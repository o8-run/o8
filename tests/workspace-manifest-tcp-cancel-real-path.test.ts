import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-manifest-tcp-')));
const previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
const previousO8DataDir = process.env.O8_DATA_DIR;

beforeAll(async () => {
  process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
  process.env.O8_DATA_DIR = path.join(root, 'data');
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ productTelemetryEnabled: false, workspaceManifestPolicy: 'auto' });
});

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
  if (previousO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = previousO8DataDir;
  rmSync(root, { recursive: true, force: true });
});

// Real supervisor processes own the health probes. Refusal/retry and cancellation
// run against real loopback sockets, with Git, SQLite and lease readback.
describe.sequential('workspace manifest TCP health lifecycle', () => {
  it.each(['healthy', 'failed', 'cancelled'] as const)('settles %s TCP health through manifest apply', async mode => {
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const preferred = (listener.address() as AddressInfo).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    const repoPath = path.join(root, mode);
    mkdirSync(repoPath);
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
    writeFileSync(path.join(repoPath, 'o8.workspace.json'), JSON.stringify({
      version: 1,
      services: [{ name: 'db', command: mode === 'healthy' ? `${process.execPath} -e \"require('node:net').createServer(s => s.end()).listen(Number(process.env.PORT), '127.0.0.1')\"` : 'exec sleep 600', port: { preferred }, health: { tcp: true, timeoutMs: mode === 'failed' ? 150 : 30_000 } }],
      preview: { url: 'http://127.0.0.1:{{port}}/' },
    }));
    execFileSync('git', ['add', 'o8.workspace.json'], { cwd: repoPath });
    execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=test@o8.test',
      'commit', '-qm', 'fixture'], { cwd: repoPath });
    const { createLane, getLaneEvents, setLaneStatus, updateLane } = await import('@/lib/lane/registry');
    const { applyWorkspaceManifest } = await import('@/lib/workspace/manifest/apply');
    const { readWorkspaceManifestReceipt, settleTerminalWorkspaceManifest } = await import('@/lib/workspace/manifest/lifecycle');
    const { readWorkspacePortLeases } = await import('@/lib/workspace/manifest/port-leases');
    const packetId = `packet-tcp-${mode}`;
    const lane = createLane({ repoPath, branch: 'main', baseBranch: 'main', runtime: 'codex', label: packetId, packetId });
    updateLane(lane.id, { worktreePath: repoPath }, 'system');
    setLaneStatus(lane.id, 'launching', 'system', 'fixture launch');
    const application = applyWorkspaceManifest({ repoPath, worktreePath: repoPath, packetId, laneId: lane.id });
    let settled = false;
    void application.then(() => { settled = true; });
    try {
      const { readWorkspaceServiceState } = await import('@/lib/workspace/manifest/services');
      if (mode === 'cancelled') {
        await vi.waitFor(async () => expect((await readWorkspaceServiceState({ worktreePath: repoPath, packetId, laneId: lane.id }))?.services).toHaveLength(1), { timeout: 5000 });
        setLaneStatus(lane.id, 'failed', 'system', 'cancel pending TCP health');
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 5000 });
      }
      const result = await application;
      const receipt = await readWorkspaceManifestReceipt(repoPath);
      const events = getLaneEvents(lane.id, 100);
      expect(receipt).toMatchObject({ packetId, laneId: lane.id,
        state: mode === 'healthy' ? 'completed' : mode, finishedAt: expect.any(String) });
      if (mode === 'healthy') {
        expect(receipt?.services[0].health).toMatchObject({ kind: 'tcp', ok: true });
        expect(result?.preview).toBe(`http://127.0.0.1:${receipt?.ports.db}/`);
      } else {
        expect(result).toBeNull();
        expect(events.some(event => event.verb === 'workspace_manifest_applied')).toBe(false);
        expect(events.filter(event => event.verb === 'workspace_manifest_failed')).toEqual([
          expect.objectContaining({ payload: expect.objectContaining({ state: mode, step: 'services' }) }),
        ]);
        if (mode === 'failed') expect(receipt?.services[0].health).toMatchObject({ kind: 'tcp', ok: false, error: 'ECONNREFUSED' });
        else {
          expect(receipt?.services).toHaveLength(1);
          expect(Object.values(await readWorkspacePortLeases()).some(lease => lease.laneId === lane.id)).toBe(false);
        }
      }
    } finally {
      await application;
      await settleTerminalWorkspaceManifest({ worktreePath: repoPath, packetId, laneId: lane.id });
    }
  }, 30_000);
});
