import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const lockfile = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
const lockHash = createHash('sha256').update(await readFile(resolve(root, 'package-lock.json'))).digest('hex');

function packageName(path, metadata) {
  if (typeof metadata.name === 'string') return metadata.name;
  const parts = path.split('/').filter(Boolean);
  const index = parts.lastIndexOf('node_modules');
  if (index < 0 || parts[index + 1] === undefined) return null;
  return parts[index + 1].startsWith('@') ? `${parts[index + 1]}/${parts[index + 2] ?? ''}` : parts[index + 1];
}

function integrityHashes(integrity) {
  if (typeof integrity !== 'string') return undefined;
  const match = /^(sha(?:256|384|512))-(.+)$/u.exec(integrity);
  if (match === null) return undefined;
  const algorithm = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' }[match[1]];
  return [{ alg: algorithm, content: Buffer.from(match[2], 'base64').toString('hex') }];
}

const components = Object.entries(lockfile.packages ?? {})
  .filter(([path]) => path !== '')
  .flatMap(([path, metadata]) => {
    if (metadata === null || typeof metadata !== 'object' || typeof metadata.version !== 'string') return [];
    const name = packageName(path, metadata);
    if (name === null || name.endsWith('/')) return [];
    const component = {
      type: 'library',
      'bom-ref': `pkg:npm/${name}@${metadata.version}?path=${encodeURIComponent(path)}`,
      name,
      version: metadata.version,
      purl: `pkg:npm/${name}@${metadata.version}`,
    };
    const hashes = integrityHashes(metadata.integrity);
    if (hashes !== undefined) component.hashes = hashes;
    if (typeof metadata.license === 'string') component.licenses = [{ license: { id: metadata.license } }];
    return [component];
  });

const document = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${lockHash.slice(0, 8)}-${lockHash.slice(8, 12)}-5${lockHash.slice(13, 16)}-8${lockHash.slice(17, 20)}-${lockHash.slice(20, 32)}`,
  version: 1,
  metadata: {
    component: { type: 'application', name: packageJson.name, version: packageJson.version },
    properties: [{ name: 'agent-orchestration:package-lock-sha256', value: lockHash }],
  },
  components,
};

process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
