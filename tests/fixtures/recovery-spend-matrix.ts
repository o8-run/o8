import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import { expect, it, vi } from 'vitest';
import type { OwnedSessionIo } from '@/lib/runtimes/shared/owned-session/session-io';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import type { OrchestratorMissionState } from '@/lib/orchestrator/types';

const triggers = ['cold-start', 'supervisor-restart', 'resume', 'retry'] as const;
const sources = ['operator-hold', 'registry-operator-hold', 'mission-hold', 'registry-mission-hold',
  'archived-mission', 'archived-mission-mirror', 'archived-mission-unreadable', 'explicit-stop', 'telemetry-only', 'packet-only', 'both',
  'unknown-cost', 'unknown-packet-only', 'packet-usd-breach', 'telemetry-usd-breach', 'archived-packet'] as const;
const crashes = ['source-only', 'cost-before-event', 'event-before-cost', 'event-evicted-before-cost',
  'during-cost-read', 'after-interrupt-journal', 'after-archive', 'during-readiness'] as const;
type Source = typeof sources[number];
type Trigger = typeof triggers[number];
type Baseline = { session: OwnedSessionRecord; mission: OrchestratorMissionState; laneId: string };
interface Harness {
  root: string; repoPath: string; io: OwnedSessionIo;
  starts(): number; requests(): number;
  waitForPids(): Promise<unknown>;
  refresh(): Promise<unknown>;
  action(surfaceId: string, runId: string): Promise<{ ok: boolean; note?: string }>;
}

/** Faults affect storage/transport only; all admission, spawn and billing code is real. */
export function defineRecoverySpendMatrix(h: Harness): void {
  let baseline: Baseline | undefined;
  const backup = path.join(h.root, 'matrix-journal-backup');
  const packetId = 'packet-recovery-matrix';
  const missionId = 'mission-recovery-matrix';
  const cap = { carrier: 'openrouter' as const, costUsd: 1, inputTokens: 600_000 };
  const observed = { costUsd: 0.09, inputTokens: 653_000, outputTokens: 10,
    costSource: 'gateway' as const, capHit: false, updatedAt: new Date().toISOString() };

  async function setup(): Promise<Baseline> {
    if (baseline) return baseline;
    process.env.O8_TEST_FINISH_METERED_WORKER = '1';
    await (await import('@/lib/claude-code/worker-profile')).writeClaudeCodeWorkerProfile({
      source: 'openrouter', model: 'metered/test', codexModel: null });
    await (await import('@/lib/repos/registry')).addRepo(h.repoPath);
    const { createLane, getLane } = await import('@/lib/lane/registry');
    const lane = createLane({ repoPath: h.repoPath, branch: 'issue/recovery-matrix', runtime: 'claude-code', packetId });
    const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const control = await import('@/lib/orchestrator/control-plane');
    control.writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId,
      repoPath: h.repoPath, runtime: 'claude-code', packets: [{ id: packetId, referenceLabel: 'P1',
        title: 'Recovery matrix', summary: 'Finite local transport fixture.', workspaceTargetPath: h.repoPath,
        branchTarget: 'issue/recovery-matrix', runtime: 'claude-code', claudeCodeCarrier: 'openrouter',
        dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending', status: 'launching', lane: null }] });
    const result = await (await import('@/lib/lane/commands')).dispatch({ verb: 'launch_session', laneId: lane.id,
      prompt: 'Finite recovery matrix baseline.', claudeCodeCarrier: 'openrouter', spendCap: cap, actor: 'orchestrator' });
    expect(result, result.note).toMatchObject({ ok: true });
    await h.waitForPids();
    const surfaceId = getLane(lane.id)!.sessionKey!;
    let session!: OwnedSessionRecord;
    await vi.waitFor(async () => {
      await h.refresh();
      session = (await h.io.findSession(surfaceId))!;
      expect(session.activeRun).toBeUndefined();
      expect(session.recentRuns[0].outcome).toBe('finished');
    }, { timeout: 20_000, interval: 50 });
    cpSync(session.sessionDir, backup, { recursive: true });
    const mission = control.readOrchestratorControlPlaneState();
    Object.assign(mission.packets[0], { status: 'running', queueState: 'running', operatorStopped: false,
      holdIntent: undefined, spendCap: cap, spendTelemetry: observed });
    baseline = { session: structuredClone(session), mission, laneId: lane.id };
    return baseline;
  }

  async function restore(base: Baseline): Promise<void> {
    await h.refresh();
    const current = await h.io.findSession(base.session.surfaceId) ?? await h.io.findArchivedSession(base.session.surfaceId);
    if (current?.recentRuns[0].outcome === 'finished' && !current.recentRuns[0].interruptRequestedAt
      && current.recentRuns[0].id !== base.session.recentRuns[0].id) {
      // Preserve a genuinely completed recovery generation. Replaying an older
      // journal would correctly trip the supervisor's generation fence.
      const activeDir = base.session.sessionDir;
      rmSync(backup, { recursive: true, force: true }); cpSync(current.sessionDir, backup, { recursive: true });
      base.session = structuredClone(current); base.session.sessionDir = activeDir;
    }
    const { getSqlite } = await import('@/lib/db');
    getSqlite().prepare('DELETE FROM missions WHERE id = ?').run(missionId);
    getSqlite().prepare('DELETE FROM usage_logs WHERE session_key = ?').run(base.session.surfaceId);
    getSqlite().prepare("DELETE FROM lane_events WHERE lane_id = ? AND verb = 'spend_cap_hit'").run(base.laneId);
    rmSync(base.session.sessionDir, { recursive: true, force: true });
    const archive = path.join(`${path.dirname(base.session.sessionDir)}-archive`, path.basename(base.session.sessionDir));
    rmSync(archive, { recursive: true, force: true });
    mkdirSync(path.dirname(base.session.sessionDir), { recursive: true });
    cpSync(backup, base.session.sessionDir, { recursive: true });
    await h.io.saveSession(structuredClone(base.session));
    writeFileSync(path.join(base.session.sessionDir, 'gateway-spend.json'), JSON.stringify(observed));
    (await import('@/lib/orchestrator/control-plane')).writeOrchestratorControlPlaneState(structuredClone(base.mission));
    (await import('@/lib/lane/registry')).updateLane(base.laneId, { status: 'running', sessionKey: base.session.surfaceId });
  }

  async function stop(base: Baseline, source: Source): Promise<void> {
    const control = await import('@/lib/orchestrator/control-plane');
    const state = structuredClone(base.mission);
    const packet = state.packets[0];
    const telemetry = { ...observed };
    if (source.includes('operator-hold')) Object.assign(packet, { status: 'blocked', queueState: 'held', holdIntent: 'operator' });
    if (source.includes('mission-hold')) state.lifecycleHold = { source: 'matrix', reason: 'operator_stop',
      startedAt: new Date().toISOString(), ownerPid: process.pid, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
    if (source === 'explicit-stop') Object.assign(packet, { operatorStopped: true, status: 'blocked', queueState: 'held', blockedReason: 'operator_stopped' });
    if (['packet-only', 'both'].includes(source)) packet.spendTelemetry = { ...observed, capHit: true };
    if (['telemetry-only', 'both'].includes(source)) telemetry.capHit = true;
    if (source === 'packet-usd-breach') packet.spendTelemetry = { ...observed, costUsd: 6 };
    if (source === 'telemetry-usd-breach') telemetry.costUsd = 6;
    if (source.startsWith('unknown-')) {
      packet.spendTelemetry = { ...observed, costUsd: null, costSource: 'unknown' };
      Object.assign(telemetry, { costUsd: null, costSource: 'unknown' });
    }
    if (source === 'archived-packet') Object.assign(packet, { status: 'archived', archivedAt: new Date().toISOString() });
    writeFileSync(path.join(base.session.sessionDir, 'gateway-spend.json'), JSON.stringify(telemetry));
    if (source === 'unknown-packet-only') rmSync(path.join(base.session.sessionDir, 'gateway-spend.json'));
    control.writeOrchestratorControlPlaneState(state);
    if (source.startsWith('registry-') || source.startsWith('archived-mission')) {
      (await import('@/lib/db/missions-store')).recordMission({ id: missionId, repoPath: h.repoPath,
        runtime: 'claude-code', prompt: 'Matrix fixture.', summary: '', constraints: '', packetMeta: [], totalWaves: 1, missionState: state });
      if (source.startsWith('archived-mission')) (await import('@/lib/db')).getSqlite()
        .prepare('UPDATE missions SET archived_at = ? WHERE id = ?').run(Date.now(), missionId);
      if (source === 'archived-mission-unreadable') (await import('@/lib/db')).getSqlite()
        .prepare('UPDATE missions SET mission_state_json = ? WHERE id = ?').run('{invalid', missionId);
      if (!['archived-mission-mirror', 'archived-mission-unreadable'].includes(source)) control.writeOrchestratorControlPlaneState({ ...state, missionId: undefined, packets: [] });
    }
  }

  async function recover(base: Baseline, trigger: Trigger): Promise<{ ok: boolean; note?: string }> {
    const { surfaceId } = base.session;
    const runId = base.session.recentRuns[0].id;
    if (trigger === 'resume') {
      const response = await (await import('@/app/api/runtime/action/route')).POST(new NextRequest('http://localhost/api/runtime/action', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'steer', surfaceId, message: 'Explicit recovery control.', clientMutationId: crypto.randomUUID() }) }));
      return response.json();
    }
    if (trigger === 'retry') {
      return (await import('@/lib/runtime/actions')).launchRuntimeSurface({ runtime: 'claude-code',
        repoPath: h.repoPath, cwd: h.repoPath, prompt: 'Finite automatic retry.', automaticRecoverySurfaceId: surfaceId,
        automaticRecoveryRunId: runId, claudeCodeCarrier: 'openrouter', claudeCodeModel: 'metered/test' });
    }
    const supervisor = await import('@/lib/supervisor/agent-supervisor');
    supervisor.stopSupervisorLoop();
    for (const watched of supervisor.getWatchedAgents()) supervisor.unregisterWatchedAgent(watched.surfaceId);
    supervisor.registerWatchedAgent(surfaceId, h.repoPath, 'matrix', 'Finite automatic recovery.');
    if (trigger === 'cold-start') {
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const { POST } = await import('@/app/api/runtime/action/route');
        const result = await POST(new NextRequest('http://localhost/api/runtime/action', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks).toString('utf8') }));
        response.writeHead(result.status).end(await result.text());
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Recovery transport not bound.');
      try {
        const output = await promisify(execFile)(process.execPath, ['--import', './scripts/register-server-only-stub.mjs',
          '--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `
          const mod = await import('./src/lib/supervisor/agent-supervisor.ts'); const s = mod.default ?? mod;
          const effects=[];
          s.startSupervisorLoop({ fetchFleetStatus: async () => [{sessionKey:${JSON.stringify(surfaceId)},status:'waiting'}],
            fetchTranscript: async () => [], steerAgent: async (surfaceId,message,runId) => {
              const response=await fetch('http://127.0.0.1:${address.port}', {method:'POST',headers:{'content-type':'application/json'},
                body:JSON.stringify({action:'steer',surfaceId,message,automaticRecoveryRunId:runId,clientMutationId:crypto.randomUUID()})}); effects.push(await response.json()); },
            interruptAgent:async()=>{}, relaunchAgent:async()=>({status:'held',reason:'fixture'}),
            broadcastAgentUpdate:()=>{},queueOrchestratorEscalation:()=>{} });
          s.stopSupervisorLoop(); const w=s.getWatchedAgents().find(w=>w.surfaceId===${JSON.stringify(surfaceId)});
          if(!w)throw Error('Cold watcher missing'); w.registeredAt=w.lastActivityAt=Date.now()-1800000;w.nextPollAt=0;
          await s.runSupervisorTickForTesting();
          const modRecovery=await import('./src/lib/runtimes/shared/owned-session/automatic-recovery.ts');const recovery=modRecovery.default??modRecovery;
          const held=await recovery.readOwnedRecoveryState(${JSON.stringify(surfaceId)});
          console.log('MATRIX_RECOVERY='+JSON.stringify(effects.at(-1)??{ok:false,note:held.heldReason??w.lastStatus}));
          process.exit(0);`], { cwd: process.cwd(), env: process.env, timeout: 30_000 });
        return JSON.parse(output.stdout.split('MATRIX_RECOVERY=')[1].split('\n')[0]);
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    }
    let result: { ok: boolean; note?: string } | undefined;
    supervisor.startSupervisorLoop({ fetchFleetStatus: async () => [{ sessionKey: surfaceId, status: 'waiting' }],
      fetchTranscript: async () => [], steerAgent: async (_id, _message, currentRunId) => { result = await h.action(surfaceId, currentRunId!); },
      interruptAgent: async () => {}, relaunchAgent: async () => ({ status: 'held', reason: 'fixture' }),
      broadcastAgentUpdate: () => {}, queueOrchestratorEscalation: () => {} });
    supervisor.stopSupervisorLoop();
    const watched = supervisor.getWatchedAgents().find(w => w.surfaceId === surfaceId)!;
    watched.registeredAt = watched.lastActivityAt = Date.now() - 1_800_000; watched.nextPollAt = 0;
    await supervisor.runSupervisorTickForTesting();
    const held = await (await import('@/lib/runtimes/shared/owned-session/automatic-recovery')).readOwnedRecoveryState(surfaceId);
    return result ?? { ok: false, note: held.owned && held.heldReason || watched.lastStatus };
  }

  async function authority() {
    const foreground = (await import('@/lib/orchestrator/control-plane')).readOrchestratorControlPlaneState();
    const registered = (await import('@/lib/orchestrator/mission-registry')).readMissionRegistryEntry(missionId, { includeArchived: true });
    const fields = (mission: OrchestratorMissionState | undefined) => {
      const p = mission?.packets.find(p => p.id === packetId);
      return p ? { queue: p.queueState, hold: p.holdIntent ?? null, stopped: p.operatorStopped ?? false,
        status: p.status, release: p.releaseState, archived: p.archivedAt ?? null, reason: p.blockedReason ?? null } : null;
    };
    return { foreground: fields(foreground), foregroundHold: foreground.lifecycleHold ?? null,
      registry: fields(registered?.mission), registryHold: registered?.mission.lifecycleHold ?? null,
      registryArchivedAt: ((await import('@/lib/db')).getSqlite().prepare('SELECT archived_at FROM missions WHERE id = ?')
        .get(missionId) as { archived_at: number | null } | undefined)?.archived_at ?? null };
  }

  it.each(sources.flatMap(source => crashes.flatMap(crash => triggers.map(trigger => ({ source, crash, trigger })))))(
    'recovery spend matrix: $source / $crash / $trigger', async ({ source, crash, trigger }) => {
      process.env.O8_TEST_FINISH_METERED_WORKER = '1';
      const base = await setup();
      await restore(base);
      const ready = await import('@/lib/runtimes/shared/dispatch-readiness');
      const runtime = (await import('@/lib/runtimes')).getRuntime('claude-code')!;
      let telemetrySpy: { mockRestore(): void } | undefined;
      let stopApplied = false;
      let expectedAuthority: Awaited<ReturnType<typeof authority>> | undefined;
      const apply = async () => { await stop(base, source); stopApplied = true; expectedAuthority = await authority(); };
      const cost = async () => {
        const result = await (await import('@/lib/orchestrator/cost-persistence')).persistRuntimeSessionCost({
          sessionKey: base.session.surfaceId, runtime: 'claude-code', repoPath: h.repoPath, laneId: base.laneId, packetId });
        expect(result, `${source}/${crash}: cost persistence completed`).toBe(true);
      };
      try {
        if (crash === 'during-readiness') {
          vi.mocked(ready.ensureDispatchBackendReady).mockImplementationOnce(async () => { await apply();
            return { ready: true, reason: 'fixture', waitedMs: 0, attempts: 1 } as Awaited<ReturnType<typeof ready.ensureDispatchBackendReady>>; });
        } else if (crash === 'during-cost-read') {
          const read = runtime.getTelemetry!.bind(runtime);
          telemetrySpy = vi.spyOn(runtime, 'getTelemetry').mockImplementationOnce(async id => {
            const snapshot = await read(id); await apply(); return snapshot;
          });
          await cost();
        } else {
          await apply();
          const { appendEvent } = await import('@/lib/lane/registry');
          if (crash.startsWith('event-')) {
            appendEvent(base.laneId, 'spend_cap_hit', 'system', { reason: 'matrix persistence boundary' });
            if (crash === 'event-evicted-before-cost') for (let i = 0; i < 205; i++) appendEvent(base.laneId, 'update', 'system', { matrix: i });
          }
          if (['cost-before-event', 'event-before-cost', 'event-evicted-before-cost'].includes(crash)) await cost();
          if (crash === 'after-interrupt-journal') {
            const record = structuredClone(base.session); record.recentRuns[0].interruptRequestedAt = new Date().toISOString();
            record.recentRuns[0].outcome = 'interrupted'; await h.io.saveSession(record);
          }
          if (crash === 'after-archive') {
            const archived = await (await import('@/lib/lane/reap-sessions'))
              .archiveLaneSessions([(await import('@/lib/lane/registry')).getLane(base.laneId)!]);
            expect(archived).toMatchObject({ archived: 1 });
            expect(await h.io.findArchivedSession(base.session.surfaceId)).toBeTruthy();
          }
        }
        if (crash !== 'during-readiness') expectedAuthority = await authority();
        // A fresh read-only connection proves durable visibility without leaving
        // unrelated production coordinators bound to a closed test connection.
        const Database = (await import('better-sqlite3')).default;
        const durable = new Database((await import('@/lib/db')).getSqlite().name, { readonly: true });
        try { expect(durable.prepare('SELECT id FROM lanes WHERE id = ?').get(base.laneId)).toBeTruthy(); }
        finally { durable.close(); }
        const before = { starts: h.starts(), requests: h.requests() };
        const recovery = await recover(base, trigger);
        expect.soft(recovery.ok, `${source}/${crash}/${trigger}: refusal`).toBe(false);
        expect.soft(recovery.note, `${source}/${crash}/${trigger}: governed refusal`)
          .toMatch(/packet|interrupted|unavailable|archived|held|budget|operator_stop/i);
        // Drain a wrongly admitted finite fixture before measuring, never let it
        // become invisible merely because recovery returned before its request.
        await vi.waitFor(async () => {
          await h.refresh();
          const records = await (await import('@/lib/runtimes/shared/owned-session-index')).listOwnedActiveRuns(Date.now(), true);
          expect(records.filter(r => r.surfaceId.startsWith('claude-code-owned:'))).toHaveLength(0);
        }, { timeout: 20_000, interval: 50 });
        const label = `${source}/${crash}/${trigger}`;
        expect.soft(stopApplied, label + ': exact crash boundary exercised').toBe(true);
        expect.soft(h.starts(), label + ': no worker').toBe(before.starts);
        expect.soft(h.requests(), label + ': no gateway request').toBe(before.requests);
        expect.soft(await authority(), label + ': stop authority preserved').toEqual(expectedAuthority);
        if (source.startsWith('archived-mission')) expect.soft((await authority()).registryArchivedAt, label + ': archived owner').toBeTruthy();
        const control = (await import('@/lib/orchestrator/control-plane')).readOrchestratorControlPlaneState();
        const packet = control.packets.find(p => p.id === packetId) ?? (await import('@/lib/orchestrator/mission-registry'))
          .readMissionRegistryEntry(missionId, { includeArchived: true })?.mission.packets.find(p => p.id === packetId);
        expect.soft(packet, label + ': durable packet').toBeTruthy();
        if (['packet-only', 'both'].includes(source)) expect.soft(packet?.spendTelemetry?.capHit, label + ': cap latch').toBe(true);
        if (['telemetry-only', 'both'].includes(source)) {
          const record = await h.io.findSession(base.session.surfaceId) ?? await h.io.findArchivedSession(base.session.surfaceId);
          expect.soft(JSON.parse(readFileSync(path.join(record!.sessionDir, 'gateway-spend.json'), 'utf8')).capHit,
            label + ': disk cap latch').toBe(true);
        }
        if (source.endsWith('usd-breach')) expect.soft(packet?.spendTelemetry?.costUsd, label + ': known USD breach')
          .toBe(source === 'packet-usd-breach' || crash.includes('cost') || crash === 'after-archive' ? 6 : 0.09);
        if (source === 'packet-usd-breach' && (crash.includes('cost') || crash === 'after-archive')) {
          const row = (await import('@/lib/db')).getSqlite().prepare('SELECT cost_usd FROM usage_logs WHERE session_key = ?')
            .get(base.session.surfaceId) as { cost_usd: number } | undefined;
          expect.soft(row?.cost_usd, label + ': session receipt excludes other packet spend').toBe(0.09);
        }
        if (source.startsWith('unknown-')) {
          expect.soft(packet?.spendTelemetry?.costUsd, label + ': unknown USD').toBeNull();
          expect.soft(packet?.spendTelemetry?.inputTokens, label + ': input cap').toBe(653_000);
          const row = (await import('@/lib/db')).getSqlite().prepare('SELECT cost_usd FROM usage_logs WHERE session_key = ?')
            .get(base.session.surfaceId) as { cost_usd: number } | undefined;
          expect.soft(row, label + ': unknown creates no invented numeric usage record').toBeUndefined();
        }
      } finally { telemetrySpy?.mockRestore(); vi.mocked(ready.ensureDispatchBackendReady).mockReset().mockResolvedValue({
        ready: true, reason: 'fixture', waitedMs: 0, attempts: 1 } as Awaited<ReturnType<typeof ready.ensureDispatchBackendReady>>); }
    }, 45_000);

  it('recovery spend matrix: all four under-budget recovery entries are live positive controls', async () => {
    const base = await setup();
    process.env.O8_TEST_FINISH_METERED_WORKER = '1';
    for (const trigger of triggers) {
      await restore(base);
      const before = { starts: h.starts(), requests: h.requests() };
      expect(await recover(base, trigger), trigger).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(h.starts(), trigger).toBe(before.starts + 1), { timeout: 20_000 });
      await vi.waitFor(() => expect(h.requests(), trigger).toBe(before.requests + 1), { timeout: 20_000 });
      await vi.waitFor(async () => { await h.refresh();
        expect(await (await import('@/lib/runtimes/shared/owned-session-index')).listOwnedActiveRuns(Date.now(), true)).toHaveLength(0);
      }, { timeout: 20_000 });
    }
  }, 120_000);
}
