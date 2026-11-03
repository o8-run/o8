import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import type { PacketTaskContract } from '@/lib/orchestrator/types';
import { cliBundleAlias } from '../cli/bundle-alias.mjs';

const telemetry = vi.hoisted(() => ({ path: '' }));
vi.mock('@/lib/codex/sessions', async (original) => ({
  ...await original<typeof import('@/lib/codex/sessions')>(),
  getCodexRolloutPath: async () => telemetry.path,
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));

const root = mkdtempSync(join(tmpdir(), 'o8-reviewer-evidence-'));
const repo = join(root, 'repo');
execFileSync('git', ['init', '-qb', 'main', repo]);
function git(args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}
git(['config', 'user.name', 'test']);
git(['config', 'user.email', 'test@example.test']);
writeFileSync(join(repo, 'README.md'), 'base\n');
git(['add', 'README.md']);
git(['commit', '-qm', 'base']);
git(['checkout', '-qb', 'review']);
writeFileSync(join(repo, 'README.md'), 'reviewed change\n');
git(['commit', '-qam', 'change']);
const head = git(['rev-parse', 'HEAD']);
const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { startReviewTurn, finishReviewTurn } = await import('@/lib/lane/review-turn-state');
const { recordCodexAutoReviewVerdict, appendCodexAutoReviewVerdictInstructions } = await import('@/lib/lane/codex-auto-review-verdict');
const { getApproval, listApprovalsForContext, markSecondPassAgreed } = await import('@/lib/approvals/store');
const { assessDurableApprovedReview } = await import('@/lib/lane/durable-review-approval');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const transcriptRoute = await import('@/app/api/orchestrator/packet-transcript/route');
const reviewRoute = await import('@/app/api/orchestrator/review/route');
const runsRoute = await import('@/app/api/panel/managed-runs/route');
const { handleTranscript } = await import('@/lib/mcp/operator-handlers/status');
const { buildAutoReviewPromptV1, buildBlindSecondPassPromptV1 } = await import('@/lib/prompts/v1');

const contract: PacketTaskContract = { version: 1, requirements: [{ id: 'R1', source: 'Update documentation.',
  expectedBehavior: 'Documentation updated.', productionPath: 'README.md', verification: 'read file' }],
  smallestRoute: [{ path: 'README.md', requirements: ['R1'], reason: 'Deliver update.' }],
  processConstraints: [{ id: 'P1', source: 'Run verification.', expectedBehavior: 'Verification ran.',
    verification: 'command receipt' }], exclusions: [] };

let counter = 0;
function fixture(worktreePath = repo) {
  const packetId = `pkt-reviewer-evidence-${++counter}`;
  const lane = createLane({ repoPath: repo, worktreePath, branch: 'review', baseBranch: 'main',
    runtime: 'codex', packetId, sessionKey: `codex:${packetId}` });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
  writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState({ version: 2,
    missionId: `mission-${packetId}`, repoPath: repo, runtime: 'codex', packets: [{
      id: packetId, referenceLabel: packetId, title: 'Evidence fixture', summary: 'Review documentation',
      runtime: 'codex', workspaceTargetPath: repo, branchTarget: 'review', dependencyLabels: [], dependencyPacketIds: [],
      queueState: 'queued', releaseState: 'pending', status: 'awaiting_review',
      taskContractRequired: true, taskContractSource: 'explicit', taskContract: contract,
      lane: { laneId: lane.id, sessionKey: lane.sessionKey, worktreePath, repoPath: repo }, review: null,
    }],
  }));
  return { packetId, lane };
}

function request(url: string, body: unknown, token = getOrCreateWsToken()) {
  return new NextRequest(`http://localhost${url}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function evidence(process = false) {
  return { contractVersion: 1, headSha: head, entries: [{ requirementId: 'R1', productionPath: 'README.md' }],
    processEntries: process ? [{ constraintId: 'P1', source: 'command', reference: 'verification receipt: exit 0' }] : [] };
}

function transcriptData(result: Awaited<ReturnType<typeof handleTranscript>>) {
  const block = result.content.find(content => content.type === 'text');
  if (!block || block.type !== 'text') throw new Error('Missing transcript response.');
  return JSON.parse(block.text).data;
}

async function reviewed(approved = true, secondPassAgreed = true) {
  const f = fixture();
  const turn = startReviewTurn({ laneId: f.lane.id, threadId: 'fixture', backend: 'codex',
    surface: 'auto-review', expectedHeadSha: head });
  const recorded = await recordCodexAutoReviewVerdict({ lane: f.lane, requiresSecondPass: true,
    reviewTurnId: turn, expectedHeadSha: head, rawText: `CODEX_AUTO_REVIEW: ${JSON.stringify({
      approved, findings: [{ file: 'README.md', severity: approved ? 'note' : 'bug',
        status: approved ? 'accepted' : 'deferred', description: approved
          ? 'Reviewer limitation: transcript unavailable; P1 remains unverified.' : 'Concrete code defect.' }],
      contractCoverageEvidence: { ...evidence(), entries: [{ ...evidence().entries[0], anchor: 'line 1', verification: 'read content' }] },
    })}` });
  expect(recorded?.reviewUnavailable).toBe(false);
  finishReviewTurn({ laneId: f.lane.id, reviewTurnId: turn, outcome: 'completed' });
  const approval = listApprovalsForContext({ packetId: f.packetId }).find(a => a.toolName === 'orchestrator_review')!;
  if (approved && secondPassAgreed) markSecondPassAgreed(approval.id);
  return { ...f, approvalId: approval.id };
}

afterAll(() => { vi.unstubAllGlobals(); closeDb(); rmSync(root, { recursive: true, force: true }); });

describe('reviewer evidence recovery (#4150)', () => {
  it('pages the MCP tool from event zero through all 300 persisted events beyond the byte tail', async () => {
    const f = fixture();
    telemetry.path = join(root, 'rollout.jsonl');
    const event = (n: number) => JSON.stringify({ type: 'event_msg', timestamp: '2026-10-01T00:00:00Z',
      payload: { type: 'agent_message', message: `evidence-${n}: ${'x'.repeat(2000)}` } }) + '\n';
    writeFileSync(telemetry.path, Array.from({ length: 300 }, (_, i) => event(i + 1)).join(''));
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => transcriptRoute.GET(new NextRequest(String(input), {
      headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
    })));
    const tail = await handleTranscript({ packetId: f.packetId, tail: true, limit: 2 });
    expect(transcriptData(tail).events.map((e: { seq: number }) => e.seq)).toEqual([299, 300]);
    const seqs: number[] = [];
    let cursor = 0;
    for (let page = 0; page < 5; page += 1) {
      const result = await handleTranscript({ packetId: f.packetId, cursor, limit: 80 });
      expect(result.isError).not.toBe(true);
      const data = transcriptData(result);
      if (data.events.length === 0) break;
      seqs.push(...data.events.map((e: { seq: number }) => e.seq));
      cursor = data.nextCursor;
    }
    expect(seqs).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
    appendFileSync(telemetry.path, event(301));
    const next = await handleTranscript({ packetId: f.packetId, cursor, limit: 80 });
    expect(transcriptData(next).events).toMatchObject([{ seq: 301, text: expect.stringContaining('evidence-301:') }]);
  });

  it('keeps unavailable tooling separate from packet defects in every review prompt', () => {
    const f = fixture();
    const prompt = buildAutoReviewPromptV1({ lane: f.lane, depth: 'standard', worktreePath: repo,
      diffSummary: 'README.md changed', selfReviewSection: '', deviationsEntries: [], taskContract: contract, taskContractRequired: true });
    const blind = buildBlindSecondPassPromptV1({ laneLabel: 'fixture', branch: 'review', packetId: f.packetId,
      cwd: repo, diffSummary: 'README.md changed', highRiskReasons: [], taskContract: contract, taskContractRequired: true });
    for (const text of [prompt, blind, appendCodexAutoReviewVerdictInstructions(prompt)]) {
      expect(text).toContain('Reviewer limitation:');
      expect(text).not.toContain('unverified and request changes');
      expect(text).not.toContain('must block approval');
    }
  });

  it('completes process evidence on the same clean review without resetting its second pass', async () => {
    const f = await reviewed();
    expect(await assessDurableApprovedReview(f.lane)).toMatchObject({ approved: false,
      contractCoverage: { missingRequirementIds: ['P1'] } });
    const body = { packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: head,
      supplementProcessEvidence: true, contractCoverageEvidence: evidence(true), clientMutationId: 'supplement-1' };
    const res = await reviewRoute.POST(request('/api/orchestrator/review', body));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ result: { recorded: true, auditApprovalId: f.approvalId } });
    expect(getApproval(f.approvalId)).toMatchObject({ args: { secondPassAgreed: true,
      findings: [{ description: expect.stringContaining('Reviewer limitation:') }], contractCoverageEvidence: {
        ...evidence(true), entries: [{ ...evidence().entries[0], anchor: 'line 1', verification: 'read content' }],
      } },
      audit: expect.arrayContaining([expect.objectContaining({ actor: 'desktop', type: 'updated' })]) });
    expect(listApprovalsForContext({ packetId: f.packetId }).filter(a => a.toolName === 'orchestrator_review')).toHaveLength(1);
    expect(await assessDurableApprovedReview(f.lane)).toMatchObject({ approved: true, diffBudgetWaived: false });
    expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM review_queue WHERE lane_id = ?').get(f.lane.id)).toEqual({ count: 0 });
    expect((await reviewRoute.POST(request('/api/orchestrator/review', body))).status).toBe(200);
  });

  it('refuses worker supplementation, stale heads, and rejected code reviews', async () => {
    const f = await reviewed();
    const body = { packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: head,
      supplementProcessEvidence: true, contractCoverageEvidence: evidence(true), clientMutationId: 'denied-1' };
    expect([401, 403]).toContain((await reviewRoute.POST(request('/api/orchestrator/review', body, mintPacketWorkerToken(f.packetId)))).status);
    expect((await reviewRoute.POST(request('/api/orchestrator/review', { ...body, clientMutationId: 'stale-1', reviewedHeadSha: 'a'.repeat(40) }))).status).toBe(422);
    expect((await reviewRoute.POST(request('/api/orchestrator/review', { ...body, clientMutationId: 'file-replacement',
      contractCoverageEvidence: { ...evidence(true), entries: [{ requirementId: 'R1', productionPath: 'different.md' }] } }))).status).toBe(422);
    const rejected = await reviewed(false);
    expect((await reviewRoute.POST(request('/api/orchestrator/review', { ...body, packetId: rejected.packetId, clientMutationId: 'rejected-1' }))).status).toBe(422);
    expect(getApproval(f.approvalId)?.args?.contractCoverageEvidence).toMatchObject({ processEntries: [] });
  });

  it('preserves a still-required independent second pass when process citations are supplied', async () => {
    const f = await reviewed(true, false);
    const response = await reviewRoute.POST(request('/api/orchestrator/review', {
      packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: head,
      supplementProcessEvidence: true, contractCoverageEvidence: evidence(true), clientMutationId: 'pending-second-pass',
    }));
    expect(response.status).toBe(200);
    expect(getApproval(f.approvalId)?.args).toMatchObject({ requiresSecondPass: true, secondPassAgreed: false });
    expect(await assessDurableApprovedReview(f.lane)).toMatchObject({ approved: false, secondPassPending: true });
  });

  it('refuses supplementation if a successor review starts during evidence validation', async () => {
    const f = await reviewed();
    const coverage = await import('@/lib/lane/durable-review-approval');
    const original = coverage.listChangedPathsForCoverage;
    let turn = '';
    const spy = vi.spyOn(coverage, 'listChangedPathsForCoverage').mockImplementationOnce(async (...args) => {
      const paths = await original(...args);
      turn = startReviewTurn({ laneId: f.lane.id, threadId: 'successor', backend: 'codex', surface: 'auto-review', expectedHeadSha: head });
      return paths;
    });
    try {
      const response = await reviewRoute.POST(request('/api/orchestrator/review', {
        packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: head,
        supplementProcessEvidence: true, contractCoverageEvidence: evidence(true), clientMutationId: 'successor-race',
      }));
      expect(response.status).toBe(422);
      expect(getApproval(f.approvalId)?.args?.contractCoverageEvidence).toMatchObject({ processEntries: [] });
    } finally {
      spy.mockRestore();
      if (turn) finishReviewTurn({ laneId: f.lane.id, reviewTurnId: turn, outcome: 'completed' });
    }
  });

  it('uses the pinned packet baseline when the base branch has advanced to the reviewed HEAD', async () => {
    const f = await reviewed();
    const originalBase = git(['rev-parse', 'main']);
    git(['update-ref', 'refs/heads/main', head]);
    try {
      expect(await assessDurableApprovedReview(f.lane)).toMatchObject({ contractCoverage: { missingRequirementIds: ['P1'] } });
      const response = await reviewRoute.POST(request('/api/orchestrator/review', {
        packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: head,
        supplementProcessEvidence: true, contractCoverageEvidence: evidence(true), clientMutationId: 'advanced-base',
      }));
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await assessDurableApprovedReview(f.lane)).toMatchObject({ approved: true });
    } finally { git(['update-ref', 'refs/heads/main', originalBase]); }
  });

  it('admits an active operator reviewer run only at its packet checkout and preserves holds', async () => {
    const f = fixture();
    const turn = startReviewTurn({ laneId: f.lane.id, threadId: 'review-check', backend: 'codex',
      surface: 'auto-review', expectedHeadSha: head });
    const body = { action: 'register', id: 'reviewcheck1', session: 'cortex-run-reviewcheck1',
      command: 'node --check fixture.mjs', cwd: repo, packetId: f.packetId, laneId: f.lane.id, mode: 'stream' };
    expect((await runsRoute.POST(request('/api/panel/managed-runs', { ...body, id: 'workercheck1', session: 'cortex-run-workercheck1' },
      mintPacketWorkerToken(f.packetId)))).status).toBe(409);
    expect((await runsRoute.POST(request('/api/panel/managed-runs', { ...body, cwd: root }))).status).toBe(409);
    const res = await runsRoute.POST(request('/api/panel/managed-runs', body));
    expect(res.status, await res.clone().text()).toBe(200);
    const state = readOrchestratorControlPlaneState();
    state.packets[0].operatorStopped = true;
    writeOrchestratorControlPlaneState(state);
    expect((await runsRoute.POST(request('/api/panel/managed-runs', { ...body, id: 'heldcheck1', session: 'cortex-run-heldcheck1' }))).status).toBe(409);
    state.packets[0].operatorStopped = false;
    writeOrchestratorControlPlaneState(state);
    finishReviewTurn({ laneId: f.lane.id, reviewTurnId: turn, outcome: 'completed' });
    expect((await runsRoute.POST(request('/api/panel/managed-runs', { ...body, id: 'finished1', session: 'cortex-run-finished1' }))).status).toBe(409);
  });

  it('runs an actual reviewer CLI check and retains its command log and exit receipt', async () => {
    const worktree = join(root, '.cortex-worktrees', 'packet-cli-check');
    git(['worktree', 'add', '-q', '--detach', worktree, head]);
    const f = fixture(worktree);
    const turn = startReviewTurn({ laneId: f.lane.id, threadId: 'cli-check', backend: 'codex', surface: 'auto-review', expectedHeadSha: head });
    const socket = join(root, 'tmux.sock');
    const tmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec ${quote(tmux)} -S ${quote(socket)} "$@"\n`);
    chmodSync(join(bin, 'tmux'), 0o700);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    const lanesRoute = await import('@/app/api/lanes/route');
    const server = createServer(async (incoming, outgoing) => {
      let body = '';
      for await (const chunk of incoming) body += chunk;
      const req = new NextRequest(`http://localhost${incoming.url}`, { method: incoming.method,
        headers: { authorization: incoming.headers.authorization ?? '', 'content-type': 'application/json' },
        ...(incoming.method === 'POST' ? { body } : {}) });
      const res = req.nextUrl.pathname === '/api/lanes' ? await lanesRoute.GET(req)
        : req.nextUrl.pathname === '/api/orchestrator/review' ? await reviewRoute.POST(req)
        : req.nextUrl.pathname === '/api/orchestrator/merge'
          ? Response.json({ ok: true, result: { merged: false, note: 'Fixture stops after evidence admission.' } })
        : incoming.method === 'POST' ? await runsRoute.POST(req) : await runsRoute.GET(req);
      outgoing.writeHead(res.status, { 'content-type': 'application/json' }).end(await res.text());
    });
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture port.');
      const bundle = join(root, 'cli.mjs');
      await build({ alias: cliBundleAlias, entryPoints: [join(process.cwd(), 'cli/src/index.ts')], outfile: bundle,
        bundle: true, platform: 'node', format: 'esm', target: 'node22',
        define: { __O8_CLI_VERSION__: '"fixture"' },
        plugins: [{ name: 'fixture-native-sqlite', setup(bundle) {
          bundle.onResolve({ filter: /^better-sqlite3$/ }, () => ({
            path: createRequire(import.meta.url).resolve('better-sqlite3'), external: true,
          }));
        } }],
        banner: { js: [
          "import { createRequire as fixtureRequire } from 'node:module';",
          "import { fileURLToPath as fixtureFileURLToPath } from 'node:url';",
          "import { dirname as fixtureDirname } from 'node:path';",
          'const require = fixtureRequire(import.meta.url); globalThis.require = require;',
          'const __filename = fixtureFileURLToPath(import.meta.url); const __dirname = fixtureDirname(__filename);',
        ].join('\n') } });
      const command = join(root, 'check.mjs');
      writeFileSync(command, "console.log('reviewer-check-passed');\n");
      const env: NodeJS.ProcessEnv = { ...process.env, O8_API_PORT: String(address.port), O8_API_TOKEN: getOrCreateWsToken() };
      for (const key of ['O8_WORKER_TOKEN', 'O8_WORKER_PACKET_ID', 'O8_SPECTATOR_TOKEN', 'NODE_OPTIONS', 'O8_MANAGED_RUN_SETTLEMENT_BINDING', 'O8_OWNED_RUN_MARKER']) delete env[key];
      const runCli = async (args: string[]) => {
        const child = spawn(process.execPath, [bundle, ...args], { cwd: worktree, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        const exit = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
        return { exit, output };
      };
      const { exit, output } = await runCli(['run', '--', process.execPath, command]);
      expect(exit, output).toBe(0);
      expect(output).toContain('reviewer-check-passed');
      const { readLastManagedRunReceipt, managedRunReceiptPaths } = await import('../cli/src/commands/run-receipts');
      const receipt = readLastManagedRunReceipt();
      expect(receipt).toBeDefined();
      expect(receipt?.command).toContain(command);
      const paths = managedRunReceiptPaths(receipt!.id);
      expect(readFileSync(paths.logFile, 'utf8')).toContain('reviewer-check-passed');
      expect(readFileSync(paths.exitFile, 'utf8').trim()).toBe('0');
      finishReviewTurn({ laneId: f.lane.id, reviewTurnId: turn, outcome: 'completed' });
      await recordCodexAutoReviewVerdict({ lane: f.lane, requiresSecondPass: false, reviewTurnId: turn,
        expectedHeadSha: head, rawText: `CODEX_AUTO_REVIEW: ${JSON.stringify({ approved: true, findings: [], contractCoverageEvidence: evidence() })}` });
      const approval = listApprovalsForContext({ packetId: f.packetId }).find(a => a.toolName === 'orchestrator_review')!;
      const supplemented = await runCli(['packet', 'review', f.packetId, '--approve', '--supplement-process-evidence',
        '--expected-sha', head, '--coverage', 'R1=README.md', '--process-evidence', 'P1=command:reviewer check receipt exit 0']);
      expect(supplemented.exit, supplemented.output).toBe(0);
      expect(await assessDurableApprovedReview(f.lane)).toMatchObject({ approved: true, approvalId: approval.id });
    } finally {
      process.env.PATH = savedPath;
      try { execFileSync(tmux, ['-S', socket, 'kill-server'], { stdio: 'ignore' }); } catch { /* Already exited. */ }
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      finishReviewTurn({ laneId: f.lane.id, reviewTurnId: turn, outcome: 'completed' });
    }
  }, 30_000);
});
