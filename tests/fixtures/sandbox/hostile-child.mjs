import { spawn } from 'node:child_process';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';

const mode = process.argv[2] ?? 'audit';

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? '';
}

async function readable(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function enumerable(path) {
  try {
    return (await readdir(path)).length > 0;
  } catch {
    return false;
  }
}

async function writable(path) {
  try {
    await writeFile(path, 'hostile-write', { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

async function connectable(pathOrOptions) {
  return await new Promise((resolve) => {
    const socket = createConnection(pathOrOptions);
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function scanForCredentialMaterial() {
  const needles = /(?:ARLIAI_API_KEY|OPENAI_API_KEY|synthetic-(?:arliai|openai)-credential)/i;
  const roots = ['/capsule', '/tmp', '/run/secrets'];
  for (const root of roots) {
    let names;
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    for (const name of names.slice(0, 128)) {
      if (root === '/capsule' && name === 'hostile-child.mjs') continue;
      try {
        const content = await readFile(`${root}/${name}`, 'utf8');
        if (needles.test(content)) return true;
      } catch {
        // Directories and unreadable files are intentionally ignored.
      }
    }
  }
  return false;
}

async function descendantCredentialMaterial() {
  const source = [
    "const keys=['ARLIAI_API_KEY','OPENAI_API_KEY'];",
    "const found=Object.fromEntries(keys.filter((key)=>process.env[key]!==undefined).map((key)=>[key,process.env[key]]));",
    "process.stdout.write(JSON.stringify({found,argv:process.argv.slice(1)}));",
  ].join('');
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('error', () => resolve({ found: {}, argv: [] }));
    child.once('close', () => {
      try { resolve(JSON.parse(stdout)); } catch { resolve({ found: {}, argv: [] }); }
    });
  });
}

async function exhaustPidLimit() {
  const children = [];
  let rejected = 0;
  await Promise.all(Array.from({ length: 100 }, async () => await new Promise((resolve) => {
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    child.once('spawn', () => { children.push(child); resolve(); });
    child.once('error', () => { rejected += 1; resolve(); });
  })));
  for (const child of children) child.kill('SIGKILL');
  await Promise.all(children.map(async (child) => await new Promise((resolve) => child.once('close', resolve))));
  return { started: children.length, rejected };
}

if (mode === 'grandchild') {
  const output = process.argv[3];
  const grandchild = spawn('/bin/sh', ['-c', `sleep 2; printf survived > ${JSON.stringify(output)}`], {
    detached: true,
    stdio: 'ignore',
  });
  grandchild.unref();
  setInterval(() => {}, 60_000);
} else {
  const hostSentinelPath = option('outside-host-path');
  const hostHomePath = option('host-home');
  const hostLoopbackPort = Number(option('host-loopback-port'));
  const pidLimit = await exhaustPidLimit();
  const descendant = await descendantCredentialMaterial();
  const result = {
    outside_sentinel_readable: await readable(hostSentinelPath) || await readable('/outside-sentinel/secret.txt'),
    host_home_enumerable: await enumerable(hostHomePath) || await enumerable('/host-home'),
    credential_environment: Object.fromEntries(
      ['ARLIAI_API_KEY', 'OPENAI_API_KEY']
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    ),
    credential_argv: process.argv.filter((value) => /synthetic-(?:arliai|openai)-credential/i.test(value)),
    credential_files: await scanForCredentialMaterial(),
    descendant_credential_environment: descendant.found,
    descendant_credential_argv: descendant.argv,
    outside_write_succeeded: await writable('/broker/hostile-write.txt'),
    pid_limit: pidLimit,
    docker_socket_exists: await access('/var/run/docker.sock').then(() => true, () => false),
    docker_socket_connectable: await connectable('/var/run/docker.sock'),
    host_loopback_connectable: await connectable({ host: '127.0.0.1', port: hostLoopbackPort }),
    host_loopback_port: hostLoopbackPort,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
