import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-control-plane-write-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

const { syncOrchestratorControlPlaneState, withLockedState } = await import('@/lib/orchestrator/control-plane');

const STATE = join(process.env.CORTEX_IDE_DATA_DIR, 'orchestrator-state.json');
const identity = () => { const stat = statSync(STATE, { bigint: true }); return `${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`; };

describe('control-plane persistence', () => {
  it('does not rewrite the state file when a sync changes nothing', async () => {
    await withLockedState((state) => { state.prompt = 'first mission'; });
    await syncOrchestratorControlPlaneState();
    const settled = identity();

    for (let index = 0; index < 5; index += 1) await syncOrchestratorControlPlaneState();
    expect(identity()).toBe(settled);

    await withLockedState((state) => { state.prompt = 'second mission'; });
    expect(identity()).not.toBe(settled);
    expect(JSON.parse(readFileSync(STATE, 'utf8')).mission.prompt).toBe('second mission');
  });

  it('writes again after another writer changed the file', async () => {
    await withLockedState((state) => { state.prompt = 'ours'; });
    const file = JSON.parse(readFileSync(STATE, 'utf8'));
    file.mission.summary = 'written elsewhere';
    writeFileSync(STATE, `${JSON.stringify(file, null, 2)}\n`);
    await syncOrchestratorControlPlaneState();
    expect(JSON.parse(readFileSync(STATE, 'utf8')).mission.summary).toBe('written elsewhere');
    await withLockedState((state) => { state.summary = 'ours again'; });
    expect(JSON.parse(readFileSync(STATE, 'utf8')).mission.summary).toBe('ours again');
  });
});
