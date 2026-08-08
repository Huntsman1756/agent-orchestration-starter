import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const INVENTORY_PATH = '.agent-orchestration/inventory.json';

export interface Inventory {
  schemaVersion: 1;
  policyVersion: number;
  profileVersion: number;
  profileId: string;
  files: Record<string, string>;
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function readInventory(targetDir: string): Promise<Inventory | null> {
  try {
    const value = JSON.parse(await readFile(join(targetDir, INVENTORY_PATH), 'utf8')) as Inventory;
    return value.schemaVersion === 1 && typeof value.files === 'object' ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
