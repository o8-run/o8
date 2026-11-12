import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ disabled: false }));
vi.mock('@/lib/orchestrator/runtime-capabilities', async original => {
  const actual = await original<typeof import('@/lib/orchestrator/runtime-capabilities')>();
  return { ...actual, listDispatchableRuntimes: (...args: Parameters<typeof actual.listDispatchableRuntimes>) => actual.listDispatchableRuntimes(...args).filter(runtime => !h.disabled || runtime !== 'codex') };
});
it('owner mode maps an omitted runtime and a configured default that became undispatchable to 400 worker_not_enabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o8-owner-runtime-'));
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  const { addRepo } = await import('@/lib/repos/registry');
  await addRepo(root);
  const { updateOperatorDefaults, resolveDefaultDispatchRuntimeSync } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ defaultDispatchRuntime: 'codex', subscriptionProfile: 'both' });
  expect(resolveDefaultDispatchRuntimeSync()).toBe('codex');
  const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  const { withControlPlaneLock, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  await withControlPlaneLock(() => writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath: root, packets: [{
    id: 'pkt-owner-runtime', title: 'Owner fixture', runtime: 'codex', workspaceTargetPath: root, branchTarget: 'fixture',
    status: 'queued', queueState: 'held', holdIntent: 'explicit-dispatch', releaseState: 'pending',
  } as OrchestratorPacket] }));
  vi.stubEnv('O8_NEXT_O8D', '1');
  vi.stubGlobal('__o8NativeCortexReader', true);
  h.disabled = true;
  try {
    const { POST } = await import('@/lib/tasks/dispatch-owner-route');
    const { getOrCreateWsToken } = await import('@/lib/ws-auth');
    const response = await POST(new Request('http://localhost/api/tasks/dispatch-owner', { method: 'POST',
      headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}` },
      body: JSON.stringify({ taskId: 'pkt-owner-runtime', input: {} }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'worker_not_enabled', error: 'Requested runtime codex is not dispatchable.' });
    const { createServer } = await import('node:http');
    const listener = createServer(async (request, reply) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = await POST(new Request('http://localhost/api/tasks/dispatch-owner', { method: 'POST',
        headers: { host: 'localhost', authorization: request.headers.authorization ?? '' }, body: Buffer.concat(chunks).toString(),
      }));
      reply.writeHead(result.status, { 'content-type': 'application/json' }); reply.end(await result.text());
    });
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address(); if (!address || typeof address === 'string') throw new Error('Missing owner fixture listener');
    vi.stubEnv('O8_WS_PORT', String(address.port));
    vi.stubEnv('O8_API_PORT', String(address.port));
    try {
      const { callTaskDispatchOwner } = await import('@/lib/tasks/dispatch-owner-client');
      await expect(callTaskDispatchOwner('pkt-owner-runtime', {})).rejects.toMatchObject({ status: 400, code: 'worker_not_enabled', message: 'Requested runtime codex is not dispatchable.' });
    } finally { await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }

  } finally {
    h.disabled = false; vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }
});
