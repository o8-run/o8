/** Disposable persisted mission and history, through the production read routes. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export default async function register({ repo, dataDir, seeds }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--subagents')) return {};
  const { createEmptyOrchestratorMissionState } = await import('../../../src/lib/orchestrator/store');
  const { writeOrchestratorControlPlaneState } = await import('../../../src/lib/orchestrator/control-plane');
  const state = await import('../../../src/app/api/orchestrator/state/route');
  const parent = 'thoughts-review';
  const started = Date.now() - 30_000;
  const tasks = [
    ['calculation', 'Quick calculation', 'running'],
    ['sentence', 'Sentence edit', 'awaiting_review'],
    ['fruit', 'Sort fruit', 'released'],
    ['unrelated', 'Unrelated task', 'running'],
  ] as const;
  const packets = tasks.map(([id, title, status]) => ({
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
  const persist = () => writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
    missionId: 'subagents-fixture', repoPath: repo, packets, updatedAt: new Date().toISOString() });
  persist();
  const messages = [
    { id: 'subagent-ask', role: 'user', content: 'Inspect these tasks.', timestamp: started - 2_000 },
    { id: 'subagent-trace', role: 'assistant', content: '', timestamp: started, toolCalls: [
      { id: 'existing-read', name: 'exec_command', args: { command: 'cat preserved.rs' }, status: 'done', result: 'Preserved trace output' },
      ...tasks.slice(0, 3).map(([id, title]) => ({ id: `launch-${id}`, name: 'dispatch_mission',
        args: { tasks: [{ title }] }, status: 'done',
        result: JSON.stringify({ packets: [{ id: `subagent-${id}`, title }] }) })),
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
  const calls: string[] = [];
  return {
    priority: 9,
    before: ({ method, url }) => { calls.push(`${method} ${url.pathname}${url.search}`); },
    routes: {
      'GET /api/orchestrator/state': async request => {
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        return fail ? Response.json({ error: 'Fixture unavailable' }, { status: 503 }) : state.GET(request);
      },
      'GET /api/subagents-fixture': async request => {
        const mode = request.nextUrl.searchParams.get('mode');
        if (mode === 'done') {
          packets[0].status = 'released'; packets[0].releaseState = 'released';
          packets[0].completionSummary = 'The trip takes 55 minutes, arriving at 10:10 AM.';
          packets[0].lastEventAt = new Date().toISOString(); persist();
        }
        if (mode === 'fail') fail = true;
        if (mode === 'ready') fail = false;
        if (mode === 'slow') delay = 400;
        if (mode === 'fast') delay = 0;
        return Response.json({ repo, parent, packets, calls });
      },
    },
  };
}
