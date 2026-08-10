import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export type ArtifactKindV4 = 'VALIDATION_STDOUT' | 'VALIDATION_STDERR' | 'VALIDATION_MANIFEST' | 'DIFF';

export interface ArtifactReferenceV4 {
  readonly schema_version: 4;
  readonly kind: ArtifactKindV4;
  readonly content_hash: string;
  readonly byte_length: number;
  readonly storage_key: string;
}

export interface ArtifactStoreV4 {
  put(kind: ArtifactKindV4, bytes: Uint8Array): Promise<ArtifactReferenceV4>;
  verify(reference: ArtifactReferenceV4): Promise<boolean>;
}

const kinds = new Set<ArtifactKindV4>(['VALIDATION_STDOUT', 'VALIDATION_STDERR', 'VALIDATION_MANIFEST', 'DIFF']);
function failed(message: string): never { throw new Error(`VALIDATION_FAILED: ${message}`); }

export function createArtifactStoreV4(input: { root: string; max_artifact_bytes: number }): ArtifactStoreV4 {
  if (!Number.isSafeInteger(input.max_artifact_bytes) || input.max_artifact_bytes < 1 || input.max_artifact_bytes > 64 * 1024 * 1024) {
    failed('artifact byte policy is invalid');
  }
  const referenceFor = (kind: ArtifactKindV4, bytes: Uint8Array): ArtifactReferenceV4 => {
    const hash = createHash('sha256').update(bytes).digest('hex');
    return Object.freeze({ schema_version: 4, kind, content_hash: hash, byte_length: bytes.byteLength, storage_key: `${kind}/${hash}.bin` });
  };
  const verify = async (reference: ArtifactReferenceV4): Promise<boolean> => {
    if (reference.schema_version !== 4 || !kinds.has(reference.kind) || !/^[a-f0-9]{64}$/.test(reference.content_hash)
      || reference.storage_key !== `${reference.kind}/${reference.content_hash}.bin`
      || !Number.isSafeInteger(reference.byte_length) || reference.byte_length < 0 || reference.byte_length > input.max_artifact_bytes) return false;
    try {
      const bytes = await readFile(join(input.root, reference.storage_key));
      return bytes.length === reference.byte_length && createHash('sha256').update(bytes).digest('hex') === reference.content_hash;
    } catch { return false; }
  };
  return Object.freeze({
    put: async (kind: ArtifactKindV4, bytes: Uint8Array): Promise<ArtifactReferenceV4> => {
      if (!kinds.has(kind) || bytes.byteLength > input.max_artifact_bytes) failed('artifact exceeds policy');
      const immutable = Uint8Array.from(bytes);
      const reference = referenceFor(kind, immutable);
      const directory = join(input.root, kind);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const finalPath = join(input.root, reference.storage_key);
      const temporaryPath = join(directory, `.pending-${randomBytes(16).toString('hex')}`);
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        await handle.writeFile(immutable);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temporaryPath, finalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
      if (!(await verify(reference))) failed('artifact verification failed after write');
      return reference;
    },
    verify,
  });
}
