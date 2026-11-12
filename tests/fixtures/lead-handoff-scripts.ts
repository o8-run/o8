export const reviewWorkerHelper = `
  import { execFileSync } from 'node:child_process';
  import { writeFileSync } from 'node:fs';
  const missions = (await import('./src/lib/orchestrator/operator-mission-service.ts')).default;
  const registryModule = await import('./src/lib/lane/registry.ts');
  const findLaneByPacket = registryModule.findLaneByPacket || registryModule.default?.findLaneByPacket;
  const packetId = process.env.O8_TEST_PACKET_ID;
  const worker = packetId ? findLaneByPacket(packetId) : null;
  if (!worker?.worktreePath) throw new Error('Review worker binding is missing.');
  const head = execFileSync('git', ['-C', worker.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const review = await missions.submitPacketReview({
    packetId,
    approved: true,
    findings: [],
    reviewedHeadSha: head,
    contractCoverageEvidence: {
      contractVersion: 1, headSha: head,
      entries: [{ requirementId: 'R1', productionPath: 'lead-worker-proof.txt' }],
    },
  });
  writeFileSync(process.env.O8_TEST_REVIEW_FILE, JSON.stringify({ packetId, review }));
`;

export const fakeCodexScript = `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.145.0'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in'); process.exit(0); }
if (args.includes('--input-format')) process.exit(0);
if (args[0] === 'app-server') {
  const { createInterface } = await import('node:readline');
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      console.log(JSON.stringify({ id: message.id, result: {} }));
    } else if (message.method === 'account/rateLimits/read') {
      console.log(JSON.stringify({ id: message.id, result: {
        rateLimits: { primary: { usedPercent: 0, windowDurationMins: 10_080, resetsAt: 2_000_000_000 }, secondary: null },
        planType: 'pro',
      } }));
    }
  }
  process.exit(0);
}
appendFileSync(process.env.O8_TEST_LEAD_ARGS, JSON.stringify(args) + '\\n');
const prompt = args.at(-1) || '';
const resumeIndex = args.indexOf('resume');
const threadId = resumeIndex < 0 ? 'fixture-persistent-lead-thread' : args[resumeIndex + 1];
console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
if (process.env.O8_WORKER_PACKET_ID) {
  const markerPath = process.env.O8_TEST_WORKER_MARKERS;
  const mark = (event) => markerPath && appendFileSync(markerPath, JSON.stringify({ event, pid: process.pid, at: Date.now() }) + '\\n');
  mark('worker_started');
  writeFileSync('lead-worker-proof.txt', 'worker returned to persistent lead\\n');
  const commit = spawnSync('git', [
    '-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local',
    'add', 'lead-worker-proof.txt',
  ], { cwd: process.cwd(), encoding: 'utf8' });
  if (commit.status !== 0) { console.error(commit.stderr); process.exit(commit.status || 1); }
  const saved = spawnSync('git', [
    '-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local',
    'commit', '-qm', 'test: add persistent lead proof',
  ], { cwd: process.cwd(), encoding: 'utf8' });
  if (saved.status !== 0) { console.error(saved.stderr); process.exit(saved.status || 1); }
  mark('worker_committed');
  // Hold the worker active until the lead has reported waiting_workers.
  const returnDeadline = Date.now() + 20_000;
  while (!existsSync(process.env.O8_TEST_WORKER_RETURN_READY_FILE)) {
    if (Date.now() >= returnDeadline) throw new Error('Timed out waiting for the lead waiting_workers receipt.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'worker-reply', type: 'agent_message', text: 'offline worker reply' } }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
  mark('worker_exit_requested');
  process.exit(0);
}
if (prompt.includes('[fixture:dispatch-worker]')) {
  // The parent prepares and launches the real worker before releasing this turn.
  const deadline = Date.now() + 20_000;
  while (!process.env.O8_TEST_DISPATCH_READY_FILE || !existsSync(process.env.O8_TEST_DISPATCH_READY_FILE)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for real-path worker dispatch.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
if (prompt.includes('returned review')) {
  const packetId = prompt.match(/\\[FLEET\\][\\s\\S]*?packet (pkt-[a-zA-Z0-9-]+)\\) returned review\\./)?.[1];
  if (!packetId) throw new Error('Persistent lead review return omitted its packet binding.');
  const result = spawnSync(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx',
    '--input-type=module', '--eval', process.env.O8_TEST_REVIEW_HELPER,
  ], {
    cwd: process.env.O8_TEST_SOURCE_ROOT,
    env: { ...process.env, O8_TEST_PACKET_ID: packetId },
    encoding: 'utf8', timeout: 20000,
  });
  if (result.status !== 0) { console.error(result.stderr || result.stdout); process.exit(result.status || 1); }
}
if (prompt.includes('[fixture:hang]')) await new Promise((resolve) => setTimeout(resolve, 5000));
else if (prompt.includes('[fixture:slow-left-2541]') || prompt.includes('returned review')) await new Promise((resolve) => setTimeout(resolve, 350));
if (prompt.includes('[fixture:event-error]')) {
  console.log(JSON.stringify({ type: 'error', message: 'fixture orchestrator event failed' }));
  process.exit(0);
}
const report = prompt.match(/o8 lead report ([^ ]+) --turn ([^ ]+) --repo ([^ ]+) --thread-id ([^ ]+)/);
if (report && !prompt.includes('[fixture:no-outcome]')) {
  const kind = prompt.includes('[fixture:dispatch-worker]')
    ? 'waiting_workers'
    : prompt.includes('returned review') ? 'needs_approval'
      : ['completed', 'waiting_workers', 'needs_context', 'needs_approval', 'blocked']
        .find(kind => prompt.includes('[fixture:outcome:' + kind + ']')) ?? 'completed';
  const reported = spawnSync(process.execPath, [
    process.env.O8_TEST_SOURCE_ROOT + '/cli/dist/o8.mjs',
    'lead', 'report', report[1], '--turn', report[2], '--repo', JSON.parse(report[3]),
    '--thread-id', report[4], '--kind', kind, '--summary', 'fixture structured outcome',
    '--evidence', kind === 'completed' ? '["fixture provider receipt"]' : '[]',
  ], { env: process.env, encoding: 'utf8' });
  if (reported.status !== 0) { console.error(reported.stderr || reported.stdout); process.exit(reported.status || 1); }
}
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'offline lead reply' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`;
