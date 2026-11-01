/** Disposable persisted mission and history, through the production read routes. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';
import type { OrchestratorPacket } from '../../../src/lib/orchestrator/types';

export async function prepare({ dataDir }: SurfaceContext): Promise<SurfaceRoutes> {
  if (process.argv.includes('--subagents-shared')) process.env.O8_OWNED_OPENCODE_ROOT = join(dataDir, 'owned-opencode');
  return {};
}

export default async function register({ repo, dataDir, seeds }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--subagents')) return {};
  const { createEmptyOrchestratorMissionState } = await import('../../../src/lib/orchestrator/store');
  const { writeOrchestratorControlPlaneState } = await import('../../../src/lib/orchestrator/control-plane');
  const state = await import('../../../src/app/api/orchestrator/state/route');
  const shared = await import('../../../src/app/api/orchestrator/shared-team/active/route');
  const { createLane, setLaneStatus } = await import('../../../src/lib/lane/registry');
  const { markPacketReleased } = await import('../../../src/lib/orchestrator/packet-release-truth');
  const { persistComposerImages } = await import('../../../src/lib/mobile/orchestrator-image-media');
  const image = persistComposerImages([{ dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAAAwCAIAAAAJh2qgAAAAVklEQVR4nO3PAQ3AIADAMEAOnlCOmbv4k71VsM197viT9XXA2wzXGa4zXGe4znCd4TrDdYbrDNcZrjNcZ7jOcJ3hOsN1husM1xmuM1xnuM5wneE6w3UPI0QBwum7oOkAAAAASUVORK5CYII=', name: 'Agent capture.png' }]);
  const parent = 'thoughts-review';
  const started = Date.now() - 30_000;
  const tasks = [
    ['calculation', 'Quick calculation', 'running'],
    ['sentence', 'Sentence edit', 'awaiting_review'],
    ['fruit', 'Sort fruit', 'released'],
    ['unrelated', 'Unrelated task', 'running'],
  ] as const;
  const packets: OrchestratorPacket[] = tasks.map(([id, title, status]) => ({
    id: `subagent-${id}`, referenceLabel: title, title, summary: `Task: ${title}`,
    workspaceTargetPath: repo, branchTarget: 'main', runtime: 'pi' as const, model: 'pi',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued' as const,
    releaseState: status === 'released' ? 'released' as const : 'pending' as const,
    status, attemptCount: 1, lane: null, review: null,
    orchestratorThreadId: id === 'unrelated' ? 'thoughts-tools' : parent,
    launchContext: { source: 'agent' as const, presentation: 'tab' as const, repoContext: 'registered' as const,
      parentThreadId: id === 'unrelated' ? 'thoughts-tools' : parent },
    workerRouting: undefined,
    lastEventAt: new Date(started).toISOString(), lastEventLabel: 'Checking the task',
    completionSummary: id === 'fruit' ? 'apple, banana, cherry, mango, pear' : null,
  }));
  const laneIds = new Map<string, string>();
  for (const [id, title, status] of tasks) {
    const key = `thoughts-subagent-${id}`;
    const messages = Array.from({ length: id === 'calculation' ? 124 : 2 }, (_, i) => ({
      id: `${key}-${i}`, role: i % 2 ? 'assistant' : 'user',
      content: i % 2 ? `Recorded ${title} progress ${i}` : `Stage ${i}`, timestamp: started + i,
      ...(id === 'calculation' && i === 122 ? { media: image } : {}),
    }));
    seeds.push({ id: key, title, messages });
    writeFileSync(join(dataDir, 'chat-history', `${key}.json`), JSON.stringify({
      title, repoPath: repo, backend: 'pi', model: 'pi', orchestratorVisible: false,
      savedAt: new Date().toISOString(), messages,
    }));
    const lane = createLane({ repoPath: repo, branch: 'main', runtime: 'pi', packetId: `subagent-${id}`,
      sessionKey: `llm-chat:${key}`, label: title });
    laneIds.set(id, lane.id);
    setLaneStatus(lane.id, status === 'released' ? 'completed' : status === 'awaiting_review' ? 'reviewing' : 'running', 'system', 'fixture_ready');
    if (status === 'released') markPacketReleased(packets.find(p => p.id === `subagent-${id}`)!, { source: 'read_only_completed' });
  }
  if (process.argv.includes('--subagents-shared')) {
    // Shared ownership records bind to a real checkout HEAD, including in this
    // disposable empty repository. No worker is launched by this fixture.
    execFileSync('git', ['-c', 'user.name=o8 fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--allow-empty', '-m', 'Fixture baseline'], { cwd: repo, stdio: 'ignore' });
    const { reserveSharedCheckoutMember, recordSharedCheckoutMember } = await import('../../../src/lib/orchestrator/shared-checkout-team');
    const member = { repoPath: repo, parentThreadId: parent, runtime: 'opencode', taskName: 'Shared verification',
      clientMutationId: 'subagent-shared-fixture', paths: ['shared-verification.txt'] };
    await reserveSharedCheckoutMember(member);
    await recordSharedCheckoutMember({ ...member, surfaceId: 'opencode-owned:subagent-shared', parentTurnId: 'subagent-trace' });
    const owned = join(dataDir, 'owned-opencode'); process.env.O8_OWNED_OPENCODE_ROOT = owned;
    const sessionDir = join(owned, 'subagent-shared'); mkdirSync(sessionDir, { recursive: true });
    const stdoutPath = join(sessionDir, 'run.jsonl');
    writeFileSync(stdoutPath, JSON.stringify({ type: 'text', part: { type: 'text', text: 'Shared worker result' } }) + '\n');
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ surfaceId: 'opencode-owned:subagent-shared',
      sessionDir, cwd: repo, repoPath: repo, title: member.taskName, model: 'recorded-model', activeRun: null,
      recentRuns: [{ id: 'shared-run', startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
        stdoutPath, stderrPath: join(sessionDir, 'stderr.log'), outcome: 'finished', prompt: 'Verify shared work' }] }));
    const { registerSharedWorkerParent } = await import('../../../src/lib/orchestrator/shared-worker-returns');
    registerSharedWorkerParent({ repoPath: repo, surfaceId: 'opencode-owned:subagent-shared', origin: {
      threadId: parent, turnId: 'subagent-trace', backend: 'pi', model: 'pi', effort: 'medium', mode: 'fleet',
    } });
  }
  const persist = () => writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
    missionId: 'subagents-fixture', repoPath: repo, packets, updatedAt: new Date().toISOString() });
  persist();
  const messages = [
    { id: 'subagent-ask', role: 'user', content: 'Inspect these tasks.', timestamp: started - 2_000 },
    { id: 'subagent-trace', role: 'assistant', content: '', timestamp: started, toolCalls: [
      { id: 'existing-read', name: 'exec_command', args: { command: 'cat preserved.rs' }, status: 'done', result: 'Preserved trace output' },
      ...tasks.slice(0, 3).map(([id, title]) => ({ id: `launch-${id}`, name: 'create_mission',
        args: { issues_inline: [{ title }] }, status: 'done',
        result: JSON.stringify({ packets: [{ id: `subagent-${id}`, title }] }) })),
      ...(process.argv.includes('--subagents-shared') ? [{ id: 'launch-shared', name: 'cortex_launch_agent',
        args: { taskName: 'Shared verification' }, status: 'done', result: JSON.stringify({ ok: true, surfaceId: 'opencode-owned:subagent-shared' }) }] : []),
    ] },
    { id: 'parent-result', role: 'assistant', content: 'The agents are checking their tasks.', timestamp: started + 1_000 },
  ];
  writeFileSync(join(dataDir, 'chat-history', `${parent}.json`), JSON.stringify({
    title: 'Inspect subagents', repoPath: repo, backend: 'pi', model: 'pi', orchestratorVisible: true,
    savedAt: new Date().toISOString(), messages,
  }));
  const seed = seeds.find(seed => seed.id === parent)!;
  seed.messages = messages;
  let fail = false;
  let delay = 0;
  let failPage = false;
  const history = await import('../../../src/app/api/mobile/history/route');
  const calls: string[] = [];
  return {
    priority: 9,
    before: ({ method, url }) => { calls.push(`${method} ${url.pathname}${url.search}`); },
    routes: {
      'GET /api/orchestrator/state': async request => {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        return fail ? Response.json({ error: 'Fixture unavailable' }, { status: 503 }) : state.GET(request);
      },
      'GET /api/orchestrator/shared-team/active': shared.GET,
      'GET /api/mobile/history': async request => {
        if (failPage && request.nextUrl.searchParams.has('before')) return Response.json({ error: 'Earlier history unavailable' }, { status: 503 });
        return history.GET(request);
      },
      'GET /api/subagents-fixture': async request => {
        const mode = request.nextUrl.searchParams.get('mode');
        if (mode === 'done') {
          packets[0].status = 'released'; packets[0].releaseState = 'released';
          setLaneStatus(laneIds.get('calculation')!, 'completed', 'system', 'fixture_done');
          markPacketReleased(packets[0], { source: 'read_only_completed' });
          packets[0].completionSummary = 'The trip takes 55 minutes, arriving at 10:10 AM.';
          packets[0].lastEventAt = new Date().toISOString(); persist();
        }
        if (mode === 'fail') fail = true;
        if (mode === 'ready') fail = false;
        if (mode === 'slow') delay = 400;
        if (mode === 'fast') delay = 0;
        if (mode === 'fail-page') failPage = true;
        if (mode === 'ready-page') failPage = false;
        if (mode === 'held' && process.argv.includes('--subagents-shared')) {
          const { getSqlite } = await import('../../../src/lib/db');
          getSqlite().prepare(`INSERT OR REPLACE INTO shared_worker_returns
            (id, surface_id, run_id, outcome, summary, status, reason, created_at, updated_at)
            VALUES ('shared-return', 'opencode-owned:subagent-shared', 'shared-run', 'finished', 'Shared worker result', 'held', 'Parent delivery needs review', ?, ?)`)
            .run(Date.now(), Date.now());
        }
        return Response.json({ repo, parent, packets, calls });
      },
    },
  };
}
