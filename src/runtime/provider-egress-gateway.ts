import { spawn, execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import { createDockerContainerRemovalControllerV4 } from './process-sandbox.js';

export interface ProviderGatewayLeaseV4 {
  readonly container_id: string;
  readonly gateway_base_url: string;
  readonly non_secret_api_key_value: 'broker-gateway';
  revoke(): Promise<void>;
}

export interface ProviderGatewayStartRequestV4 {
  readonly docker_executable: string;
  readonly image_id: `sha256:${string}`;
  readonly execution_id: string;
  readonly internal_network: string;
  readonly outbound_network: string;
  readonly outbound_address: string;
  readonly provider_origin: string;
  readonly allowed_methods: readonly string[];
  readonly allowed_paths: readonly string[];
  readonly real_api_key: string;
  readonly ca_pem: string;
  readonly startup_timeout_ms: number;
}

interface GatewayBootPayloadV4 {
  readonly api_key: string;
  readonly ca_pem: string;
  readonly listen_address: string;
}

const execFileAsync = promisify(execFile);
const maxRequestBytes = 1024 * 1024;
const maxResponseBytes = 4 * 1024 * 1024;

function unavailable(): never {
  throw new Error('PROCESS_SANDBOX_UNAVAILABLE: process sandbox is unavailable');
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'TEMP', 'TMP'];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

async function docker(executable: string, argv: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync(executable, [...argv], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 512 * 1024,
      env: dockerEnvironment(),
    });
    return result.stdout.trim();
  } catch {
    unavailable();
  }
}

async function exactContainerIdPresentV4(executable: string, containerId: string): Promise<boolean> {
  const output = await docker(executable, [
    'container', 'ls', '--all', '--no-trunc', `--filter=id=${containerId}`, '--format', '{{.ID}}',
  ]);
  if (output === '') return false;
  if (output === containerId) return true;
  unavailable();
}

function gatewayContainerName(executionId: string): string {
  return `ao-gateway-${executionId.replaceAll('_', '-')}`;
}

export function validateProviderGatewayOriginV4(value: string): URL {
  let origin: URL;
  try { origin = new URL(value); } catch { unavailable(); }
  if (value !== 'https://api.arliai.com'
    || origin.protocol !== 'https:'
    || origin.hostname !== 'api.arliai.com'
    || origin.hostname !== origin.hostname.toLowerCase()
    || isIP(origin.hostname) !== 0
    || origin.username !== ''
    || origin.password !== ''
    || origin.pathname !== '/'
    || origin.search !== ''
    || origin.hash !== ''
    || origin.origin !== value) unavailable();
  return origin;
}

function validateStartRequest(request: ProviderGatewayStartRequestV4): URL {
  if (!/^sha256:[a-f0-9]{64}$/.test(request.image_id)) unavailable();
  if (!/^exec_[a-z0-9_-]{8,96}$/.test(request.execution_id)) unavailable();
  if (!/^ao-int-exec-[a-z0-9-]{4,80}$/.test(request.internal_network)) unavailable();
  if (!/^ao-out-exec-[a-z0-9-]{4,80}$/.test(request.outbound_network)) unavailable();
  if (isIP(request.outbound_address) !== 4 || !isProviderEgressAddressAllowedV4(request.outbound_address)) unavailable();
  if (request.allowed_methods.length !== 1 || request.allowed_methods[0] !== 'POST') unavailable();
  if (request.allowed_paths.length !== 1 || request.allowed_paths[0] !== '/v1/chat/completions') unavailable();
  if (request.real_api_key.length < 16 || request.real_api_key.length > 512 || /[\r\n\0]/.test(request.real_api_key)) unavailable();
  if (!request.ca_pem.includes('-----BEGIN CERTIFICATE-----') || request.ca_pem.length > 128 * 1024) unavailable();
  if (!Number.isSafeInteger(request.startup_timeout_ms) || request.startup_timeout_ms < 100 || request.startup_timeout_ms > 60_000) unavailable();
  return validateProviderGatewayOriginV4(request.provider_origin);
}

async function validateNetwork(
  executable: string,
  name: string,
  executionId: string,
  internal: boolean,
): Promise<void> {
  const raw = await docker(executable, ['network', 'inspect', name]);
  try {
    const values = JSON.parse(raw) as Array<{ Driver?: unknown; Internal?: unknown; Labels?: Record<string, string> }>;
    const value = values[0];
    if (values.length !== 1
      || value?.Driver !== 'bridge'
      || value.Internal !== internal
      || value.Labels?.['agent-orchestration.execution'] !== executionId) unavailable();
  } catch {
    unavailable();
  }
}

async function inspectGatewayNetworkBindingV4(
  executable: string,
  containerId: string,
  internalNetwork: string,
  outboundNetwork: string,
  outboundAddress: string,
): Promise<string> {
  const raw = await docker(executable, ['inspect', containerId]);
  try {
    const values = JSON.parse(raw) as Array<{
      Id?: unknown;
      NetworkSettings?: { Networks?: Record<string, { IPAddress?: unknown }> };
    }>;
    const value = values[0];
    const networks = value?.NetworkSettings?.Networks;
    if (values.length !== 1 || value?.Id !== containerId || networks === undefined) unavailable();
    const names = Object.keys(networks).sort();
    if (names.length !== 2 || names[0] !== [internalNetwork, outboundNetwork].sort()[0] || names[1] !== [internalNetwork, outboundNetwork].sort()[1]) unavailable();
    const internalAddress = networks[internalNetwork]?.IPAddress;
    if (typeof internalAddress !== 'string'
      || isIP(internalAddress) === 0
      || internalAddress === '0.0.0.0'
      || internalAddress === '::'
      || networks[outboundNetwork]?.IPAddress !== outboundAddress) unavailable();
    return internalAddress;
  } catch {
    unavailable();
  }
}

async function waitForGatewayNetworkBindingV4(
  request: ProviderGatewayStartRequestV4,
  containerId: string,
): Promise<string> {
  const deadline = Date.now() + request.startup_timeout_ms;
  while (Date.now() < deadline) {
    try {
      return await inspectGatewayNetworkBindingV4(
        request.docker_executable,
        containerId,
        request.internal_network,
        request.outbound_network,
        request.outbound_address,
      );
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
  unavailable();
}

export async function startProviderEgressGatewayV4(
  request: ProviderGatewayStartRequestV4,
): Promise<ProviderGatewayLeaseV4> {
  validateStartRequest(request);
  await Promise.all([
    validateNetwork(request.docker_executable, request.internal_network, request.execution_id, true),
    validateNetwork(request.docker_executable, request.outbound_network, request.execution_id, false),
  ]);
  const name = gatewayContainerName(request.execution_id);
  const createArgs = [
    'create', '--interactive', `--name=${name}`,
    '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32',
    '--memory=256m', '--cpus=1', '--user=1000:1000',
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=32m', '--network=none',
    request.image_id,
    'node', '/broker/provider-egress-gateway.js', '--serve',
    `--origin=${request.provider_origin}`,
    '--allowed-method=POST',
    '--allowed-path=/v1/chat/completions',
  ];
  const containerId = await docker(request.docker_executable, createArgs);
  if (!/^[a-f0-9]{64}$/.test(containerId)) unavailable();
  let attach: ReturnType<typeof spawn> | null = null;
  const removal = createDockerContainerRemovalControllerV4(containerId, {
    inspect_exact_id: async (id) => await exactContainerIdPresentV4(request.docker_executable, id),
    force_remove_exact_id: async (id) => {
      const removed = await docker(request.docker_executable, ['rm', '--force', id]);
      if (removed !== id) unavailable();
    },
    poll_interval_ms: 25,
    absence_timeout_ms: 5_000,
  });
  const cleanup = async (): Promise<void> => {
    await removal.remove();
    if (attach !== null && attach.exitCode === null && attach.signalCode === null) attach.kill('SIGKILL');
  };
  try {
    await docker(request.docker_executable, ['network', 'disconnect', 'none', containerId]);
    await docker(request.docker_executable, ['network', 'connect', '--alias=provider-gateway', request.internal_network, containerId]);
    await docker(request.docker_executable, ['network', 'connect', `--ip=${request.outbound_address}`, request.outbound_network, containerId]);
    attach = spawn(request.docker_executable, ['start', '--attach', '--interactive', containerId], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: dockerEnvironment(),
    });
    const attached = attach;
    const attachedStdin = attached.stdin;
    const attachedStdout = attached.stdout;
    if (attachedStdin === null || attachedStdout === null) unavailable();
    const listenAddress = await waitForGatewayNetworkBindingV4(request, containerId);
    await new Promise<void>((resolvePromise, reject) => {
      let buffered = '';
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolvePromise(); else reject(error);
      };
      const timer = setTimeout(() => finish(new Error('gateway readiness timeout')), request.startup_timeout_ms);
      timer.unref();
      attachedStdout.setEncoding('utf8');
      attachedStdout.on('data', (chunk: string) => {
        buffered += chunk;
        while (buffered.includes('\n')) {
          const index = buffered.indexOf('\n');
          const line = buffered.slice(0, index);
          buffered = buffered.slice(index + 1);
          try {
            const event = JSON.parse(line) as { event?: unknown };
            if (event.event === 'GATEWAY_READY') finish();
          } catch {
            // Non-JSON output never authorizes readiness.
          }
        }
      });
      attached.once('error', () => finish(new Error('gateway attach failed')));
      attached.once('close', () => finish(new Error('gateway exited before readiness')));
      attachedStdin.end(`${JSON.stringify({ api_key: request.real_api_key, ca_pem: request.ca_pem, listen_address: listenAddress })}\n`);
    });
  } catch {
    await cleanup();
    unavailable();
  }
  return Object.freeze({
    container_id: containerId,
    gateway_base_url: 'http://provider-gateway:8080/v1',
    non_secret_api_key_value: 'broker-gateway' as const,
    revoke: cleanup,
  });
}

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  if (value === undefined) unavailable();
  return value.slice(prefix.length);
}

function ipv4Parts(address: string): [number, number, number, number] | null {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts as [number, number, number, number]
    : null;
}

function publicIpv4(parts: [number, number, number, number]): boolean {
  const [first, second, third] = parts;
  return !(first === 0
    || first === 10
    || first === 127
    || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && (third === 0 || third === 2))
    || (first === 192 && second === 88 && third === 99)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113));
}

function ipv6Words(address: string): number[] | null {
  let normalized = address.toLowerCase().split('%', 1)[0]!;
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const embedded = ipv4Parts(normalized.slice(lastColon + 1));
    if (embedded === null) return null;
    normalized = `${normalized.slice(0, lastColon)}:${((embedded[0] << 8) | embedded[1]).toString(16)}:${((embedded[2] << 8) | embedded[3]).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] === '' ? [] : halves[0]!.split(':');
  const right = halves.length === 1 || halves[1] === '' ? [] : halves[1]!.split(':');
  const omitted = 8 - left.length - right.length;
  if ((halves.length === 1 && omitted !== 0) || (halves.length === 2 && omitted < 1)) return null;
  const words = [...left, ...Array.from({ length: omitted }, () => '0'), ...right].map((value) => Number.parseInt(value, 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : null;
}

export function isProviderEgressAddressAllowedV4(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = ipv4Parts(address);
    return parts !== null && publicIpv4(parts);
  }
  if (family !== 6) return false;
  const words = ipv6Words(address);
  if (words === null) return false;
  const first = words[0]!;
  if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0 || words[5] === 0xffff)) {
    return publicIpv4([
      words[6]! >>> 8,
      words[6]! & 0xff,
      words[7]! >>> 8,
      words[7]! & 0xff,
    ]);
  }
  if ((first & 0xe000) !== 0x2000
    || (first & 0xfe00) === 0xfc00
    || (first & 0xffc0) === 0xfe80
    || (first & 0xffc0) === 0xfec0
    || (first & 0xff00) === 0xff00
    || first === 0x2002
    || (first === 0x0064 && words[1] === 0xff9b)
    || (first === 0x2001 && (words[1] === 0 || words[1] === 0x0db8 || (words[1]! & 0xfff0) === 0x0010))) return false;
  return true;
}

function pathClass(path: string): string {
  return path === '/v1/chat/completions' ? 'chat_completions' : 'other';
}

function audit(input: {
  host: string;
  path: string;
  decision: 'ALLOW' | 'DENY';
  requestBytes: number;
  responseBytes: number;
  startedAt: number;
}): void {
  process.stdout.write(`${JSON.stringify({
    event: 'GATEWAY_REQUEST',
    host: input.host,
    path_class: pathClass(input.path),
    decision: input.decision,
    request_bytes: input.requestBytes,
    response_bytes: input.responseBytes,
    duration_ms: Date.now() - input.startedAt,
  })}\n`);
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > maxRequestBytes) unavailable();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function proxyRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  origin: URL,
  boot: GatewayBootPayloadV4,
  allowedMethods: ReadonlySet<string>,
  allowedPaths: ReadonlySet<string>,
): Promise<void> {
  const startedAt = Date.now();
  const path = incoming.url ?? '';
  const method = incoming.method ?? '';
  const prohibitedTargetHeaders = ['forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-target-origin'];
  if (!allowedMethods.has(method)
    || !allowedPaths.has(path)
    || prohibitedTargetHeaders.some((header) => incoming.headers[header] !== undefined)) {
    audit({ host: origin.hostname, path, decision: 'DENY', requestBytes: 0, responseBytes: 0, startedAt });
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end('{"error":"gateway policy denied request"}');
    return;
  }
  let body: Buffer;
  try { body = await readRequestBody(incoming); } catch {
    audit({ host: origin.hostname, path, decision: 'DENY', requestBytes: 0, responseBytes: 0, startedAt });
    response.writeHead(413, { 'content-type': 'application/json' });
    response.end('{"error":"request too large"}');
    return;
  }
  try {
    const addresses = await lookup(origin.hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some((entry) => !isProviderEgressAddressAllowedV4(entry.address))) unavailable();
    const target = addresses[0]!;
    const outbound = httpsRequest({
      protocol: 'https:',
      hostname: target.address,
      family: target.family,
      servername: origin.hostname,
      port: origin.port === '' ? 443 : Number(origin.port),
      method,
      path,
      ca: boot.ca_pem,
      rejectUnauthorized: true,
      headers: {
        host: origin.host,
        authorization: `Bearer ${boot.api_key}`,
        accept: typeof incoming.headers.accept === 'string' ? incoming.headers.accept : 'application/json',
        'content-type': typeof incoming.headers['content-type'] === 'string' ? incoming.headers['content-type'] : 'application/json',
        'content-length': String(body.length),
      },
    }, (upstream) => {
      const chunks: Buffer[] = [];
      let size = 0;
      upstream.on('data', (value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size += chunk.length;
        if (size > maxResponseBytes) upstream.destroy(new Error('response too large'));
        else chunks.push(chunk);
      });
      upstream.once('end', () => {
        const payload = Buffer.concat(chunks);
        if ((upstream.statusCode ?? 500) >= 300 && (upstream.statusCode ?? 500) < 400) {
          audit({ host: origin.hostname, path, decision: 'DENY', requestBytes: body.length, responseBytes: 0, startedAt });
          response.writeHead(502, { 'content-type': 'application/json' });
          response.end('{"error":"provider redirect denied"}');
          return;
        }
        audit({ host: origin.hostname, path, decision: 'ALLOW', requestBytes: body.length, responseBytes: payload.length, startedAt });
        response.writeHead(upstream.statusCode ?? 502, {
          'content-type': typeof upstream.headers['content-type'] === 'string' ? upstream.headers['content-type'] : 'application/octet-stream',
        });
        response.end(payload);
      });
    });
    outbound.setTimeout(10_000, () => outbound.destroy(new Error('provider timeout')));
    outbound.once('error', () => {
      if (!response.headersSent) {
        audit({ host: origin.hostname, path, decision: 'DENY', requestBytes: body.length, responseBytes: 0, startedAt });
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end('{"error":"provider request failed"}');
      } else response.destroy();
    });
    outbound.end(body);
  } catch {
    audit({ host: origin.hostname, path, decision: 'DENY', requestBytes: body.length, responseBytes: 0, startedAt });
    response.writeHead(502, { 'content-type': 'application/json' });
    response.end('{"error":"provider request failed"}');
  }
}

async function readBootPayload(): Promise<GatewayBootPayloadV4> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const line = await new Promise<string>((resolvePromise, reject) => {
    lines.once('line', resolvePromise);
    lines.once('close', () => reject(new Error('missing gateway boot payload')));
  });
  lines.close();
  try {
    const value = JSON.parse(line) as Partial<GatewayBootPayloadV4>;
    if (typeof value.api_key !== 'string'
      || value.api_key.length < 16
      || typeof value.ca_pem !== 'string'
      || !value.ca_pem.includes('-----BEGIN CERTIFICATE-----')
      || typeof value.listen_address !== 'string'
      || isIP(value.listen_address) === 0
      || value.listen_address === '0.0.0.0'
      || value.listen_address === '::') unavailable();
    return { api_key: value.api_key, ca_pem: value.ca_pem, listen_address: value.listen_address };
  } catch {
    unavailable();
  }
}

async function serveGateway(): Promise<void> {
  const origin = validateProviderGatewayOriginV4(argument('origin'));
  const allowedMethod = argument('allowed-method');
  const allowedPath = argument('allowed-path');
  if (allowedMethod !== 'POST' || allowedPath !== '/v1/chat/completions') unavailable();
  const boot = await readBootPayload();
  const server = createServer((request, response) => {
    void proxyRequest(request, response, origin, boot, new Set([allowedMethod]), new Set([allowedPath]));
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 2_000;
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(8080, boot.listen_address, resolvePromise);
  });
  process.stdout.write(`${JSON.stringify({ event: 'GATEWAY_READY', host: origin.hostname })}\n`);
}

if (process.argv[1]?.endsWith('/provider-egress-gateway.js') && process.argv.includes('--serve')) {
  void serveGateway().catch(() => { process.exitCode = 1; });
}
