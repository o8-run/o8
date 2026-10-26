import { createHash } from 'node:crypto';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export function workerO8CliRoot(): string {
  return path.join(path.resolve(getDataDir({ ...process.env })), 'worker-cli');
}

export function workerO8CliOwner(surfaceId: string): string {
  return createHash('sha256').update(surfaceId).digest('hex');
}

export function workerO8CliSlot(surfaceId: string): string {
  return path.join(workerO8CliRoot(), workerO8CliOwner(surfaceId));
}
