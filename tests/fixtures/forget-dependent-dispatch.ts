import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect } from 'vitest';
import { MODEL_IDS } from '@/lib/models';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import type { LaunchOptions } from '@/lib/runtimes/types';

type Fixture = {
  packet: OrchestratorPacket; sessionKey: string; session: OwnedSessionRecord;
  dependencies: Parameters<typeof import('@/lib/supervisor/agent-completion').handleAgentCompletion>[2];
};

export async function checkForgetDependentDispatch({ root, dataDir, restartRoot, fixture, starts }: {
  root: string; dataDir: string; restartRoot?: string;
  fixture(retained: boolean, transcriptOffsetMs: number): Promise<Fixture>;
  starts(): LaunchOptions[];
}) {
  const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  const { handleAgentCompletion } = await import('@/lib/supervisor/agent-completion');
  const { capturePacketCompletionContext, readPacketCompletionContext } = await import('@/lib/orchestrator/context-relay');
  const { closeDb } = await import('@/lib/db');
  const summary = 'Inspected tracked.txt without changing source.';
  if (restartRoot) {
    const state = readOrchestratorControlPlaneState();
    const { POST } = await import('@/app/api/orchestrator/dispatch/route');
    const response = await POST(new NextRequest('http://localhost/api/orchestrator/dispatch', {
      method: 'POST', headers: { authorization: 'Bearer forget-dispatch-fixture' },
      body: JSON.stringify({ missionId: state.missionId }),
    }));
    const receipt = await response.json();
    expect(response.status, JSON.stringify(receipt)).toBe(200);
    expect(starts(), JSON.stringify(receipt)).toHaveLength(1);
    const input = starts()[0];
    expect(input.packetId).toBe('dependent-forgotten-completion');
    expect(input.prompt).toContain('Inspect the next fixture');
    expect(input.prompt).not.toContain(summary);
    return;
  }
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  process.env.O8_APFS_DEPENDENCY_IMAGES = '0';
  writeFileSync(join(dataDir, 'ws-token'), 'forget-dispatch-fixture');
  const value = await fixture(true, -5_000);
  value.packet.title = 'Inspect previous fixture';
  value.packet.summary = 'An independent inspection task.';
  const state = readOrchestratorControlPlaneState();
  Object.assign(state.packets[0], { title: value.packet.title, summary: value.packet.summary });
  writeOrchestratorControlPlaneState(state);
  await handleAgentCompletion(value.sessionKey, 'completed', value.dependencies);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(await readPacketCompletionContext(value.packet.id)).toMatchObject({ summary });
  const { getSqlite } = await import('@/lib/db');
  const selected = getSqlite().prepare('SELECT id, repo_path AS repoPath, project_id AS projectId FROM session_outcomes WHERE packet_id = ?')
    .get(value.packet.id);
  expect(selected).toBeDefined();
  const { DELETE } = await import('@/app/api/cortex/recent-outcomes/route');
  expect((await DELETE(new NextRequest('http://localhost/api/cortex/recent-outcomes', {
    method: 'DELETE', body: JSON.stringify(selected),
  }))).status).toBe(200);
  // Auto-review re-captures the same completion even though its ledger row is excluded.
  await capturePacketCompletionContext(value.packet.id, value.sessionKey);
  await new Promise<void>(resolve => setImmediate(resolve));
  const { buildWorkerHandoffContext } = await import('@/lib/dispatch/worker-handoff-context');
  const handoff = await buildWorkerHandoffContext({ ...value.session, initialPrompt: summary, latestPrompt: summary },
    async () => { throw new Error('Stale transcript fragments must not be replayed after forget.'); });
  expect(handoff).toContain('Inspect previous fixture');
  expect(handoff).not.toContain(summary);
  const next = readOrchestratorControlPlaneState();
  next.packets.push({ ...value.packet, id: 'dependent-forgotten-completion', referenceLabel: '#2221',
    title: 'Inspect the next fixture', summary: 'Read-only independent follow-up.',
    branchTarget: 'codex/dependent-forgotten-completion', dependencyPacketIds: [value.packet.id],
    dependencyLabels: [value.packet.referenceLabel], status: 'draft', queueState: 'queued', releaseState: 'pending',
    lane: null, assignedModel: MODEL_IDS.raw.openAiGpt61Sol, model: MODEL_IDS.raw.openAiGpt61Sol,
    dispatchRuntimePin: 'codex',
  });
  writeOrchestratorControlPlaneState(next);
  await (await import('@/lib/orchestrator/mission-registry')).persistMissionRegistryState(next);
  closeDb();
  const { providerCredentialName } = await import('@/lib/providers/spawn-environment');
  const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !providerCredentialName(name)));
  const result = await promisify(execFile)(process.execPath, [join(process.cwd(), 'node_modules/vitest/vitest.mjs'),
    'run', 'tests/retained-completion-handoff-real-path.test.ts', '-t', 'excludes forgotten completion memory'], {
    cwd: process.cwd(), env: { ...cleanEnvironment, NODE_ENV: 'test', O8_FORGET_DISPATCH_RESTART_ROOT: root, NODE_OPTIONS: '' },
    timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  }).catch(error => { throw new Error(`Restarted dispatch failed:\n${error.stdout}\n${error.stderr}`, { cause: error }); });
  expect(result.stdout).toContain('1 passed');
}
