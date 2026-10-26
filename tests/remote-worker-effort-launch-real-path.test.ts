import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'o8-remote-effort-'));
const output = join(root, 'captured.json');
type Snapshot = { runs: unknown; events: unknown; lanes: string; receipts: unknown };
let result: { flag: { enabled: boolean; source: string }; cases: Array<{
  effort: string; status: number; body: { code?: string }; before: Snapshot; after: Snapshot;
  captured: { modelHint?: string; effort?: string; packetPrompt: string } | null;
}>; direct: { ok: boolean; note?: string }; directBefore: Snapshot; directAfter: Snapshot;
queueBefore: Snapshot; queueAfter: Snapshot; queueError: string; correctionStatus: number;
unknownStatus: number; unknownBefore: Snapshot; unknownAfter: Snapshot };
beforeAll(() => {
  execFileSync(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'tests/fixtures/remote-worker-effort.ts', root, output], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  result = JSON.parse(readFileSync(output, 'utf8'));
}, 65_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
it('enables the actual optional adapter through the persisted startup gate', () => {
  expect(result.flag).toEqual({ enabled: true, source: 'file' });
});
it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])('rejects unsupported concrete %s before queue, lane or idempotency mutation', effort => {
  const row = result.cases.find(candidate => candidate.effort === effort)!;
  expect(row.status).toBe(400);
  expect(row.body.code).toBe('effort_unsupported_runtime');
  expect(row.after).toEqual(row.before);
});
it.each(['omitted', 'adaptive'])('preserves %s and the remote model hint in the captured queue request', effort => {
  const row = result.cases.find(candidate => candidate.effort === effort)!;
  expect(row.status).toBe(200);
  expect(row.captured).toMatchObject({ modelHint: 'remote/model-fixture', packetPrompt: expect.stringContaining('fixture request') });
  if (effort === 'omitted') expect(row.captured).not.toHaveProperty('effort');
  else expect(row.captured?.effort).toBe('adaptive');
});
it('also refuses a direct adapter launch before the transport queue changes', () => {
  expect(result.direct.ok).toBe(false);
  expect(result.direct.note).toContain('high');
  expect(result.directAfter).toEqual(result.directBefore);
});


it('refuses a direct queue submission before persisted mutations', () => {
  expect(result.queueError).toContain('max'); expect(result.queueAfter).toEqual(result.queueBefore);
});
it('allows correction with the same mutation id after refusing a concrete pin', () => {
  expect(result.correctionStatus).toBe(200);
});
it('fails closed for an unverified runtime before binding a mutation receipt', () => {
  expect(result.unknownStatus).toBe(400); expect(result.unknownAfter).toEqual(result.unknownBefore);
});
