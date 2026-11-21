import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';

const reviewer = vi.hoisted(() => ({
  backend: 'claude' as OrchestratorBackendId,
  prompt: '',
  packetId: '',
  head: '',
}));

// Replace the external model process only. Queue, MCP discovery/calls, Git and
// durable review records use their production entry points.
vi.mock('@/lib/lane/orchestrator-backends/registry', () => ({
  getOrchestratorBackend: () => ({
    id: reviewer.backend,
    label: 'Fixture reviewer',
    ensureSession: () => ({ sessionName: 'fixture-review', status: 'ready' }),
    async sendTurn(_repo: string, prompt: string) {
      reviewer.prompt = prompt;
      const { handleOperatorMcpMessage } = await import('@/lib/mcp/operator-mcp-host');
      const result = await handleOperatorMcpMessage({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'submit_review', arguments: {
          packetId: reviewer.packetId, approved: true, reviewedHeadSha: reviewer.head,
          findings: [{ file: 'README.md', severity: 'note', status: 'accepted',
            description: 'Operator follow-up: mark the existing draft PR ready for review.' }],
        } },
      });
      expect(result?.result).not.toHaveProperty('isError', true);
    },
  }),
}));
vi.mock('@/lib/lane/review-route', () => ({
  resolveReviewRoute: () => ({ backend: reviewer.backend }),
}));
vi.mock('@/lib/lane/packet-explainer-queue', () => ({
  drainPacketExplainerQueue: vi.fn(async () => {}),
  enqueuePacketExplainer: vi.fn(async () => {}),
  notifyCorrectnessReviewQueued: vi.fn(),
  startPacketExplainerQueueDrain: vi.fn(() => () => {}),
}));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/mcp/o8-webview-client', () => ({
  O8WebviewClient: class {
    async screenshot() {
      return { imageBase64: Buffer.from('fixture').toString('base64'), mimeType: 'image/png', width: 1, height: 1 };
    }
  },
}));

const root = mkdtempSync(join(tmpdir(), 'o8-review-tool-contract-'));
const repo = join(root, 'repo');
execFileSync('git', ['init', '-q', '-b', 'main', repo]);

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}
git(repo, ['config', 'user.name', 'o8-test']);
git(repo, ['config', 'user.email', 'o8@example.test']);
writeFileSync(join(repo, 'README.md'), 'base\n');
git(repo, ['add', 'README.md']);
git(repo, ['commit', '-qm', 'base']);

const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { listApprovalsForContext } = await import('@/lib/approvals/store');
const { drainReviewQueue } = await import('@/lib/lane/auto-review');
const reviewRoute = await import('@/app/api/review/auto-review/route');
const { handleOperatorMcpMessage } = await import('@/lib/mcp/operator-mcp-host');
const verdictRoute = await import('@/app/api/orchestrator/review/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
getOrCreateWsToken();
vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.pathname !== '/api/orchestrator/review') throw new Error(`Unexpected request: ${url.pathname}`);
  return verdictRoute.POST(new NextRequest(url, {
    method: init?.method, headers: init?.headers, body: init?.body,
  }));
});

afterAll(() => {
  vi.unstubAllGlobals();
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

// Every tool-capable registered backend can be selected via reviewer=follow.
// The conversational o8 backend has no tools and is not a tool reviewer.
const backends: OrchestratorBackendId[] = [
  'claude', 'codex', 'pi', 'openclaw', 'hermes', 'acp', 'opencode', 'collide', 'fable',
];

describe('reviewer tool contract through the durable review queue (#4145)', () => {
  it.each(backends)('%s receives callable instructions and persists the publication follow-up', async (backend) => {
    reviewer.backend = backend;
    reviewer.prompt = '';
    reviewer.packetId = `pkt-tool-contract-${backend}`;
    const worktree = join(root, backend);
    const branch = `review-${backend}`;
    git(repo, ['worktree', 'add', '-qb', branch, worktree, 'main']);
    writeFileSync(join(worktree, 'README.md'), 'base\nreviewed change\n');
    git(worktree, ['commit', '-qam', 'reviewed change']);
    reviewer.head = git(worktree, ['rev-parse', 'HEAD']);
    const lane = createLane({
      repoPath: repo, worktreePath: worktree, branch, baseBranch: 'main',
      runtime: 'claude-code', packetId: reviewer.packetId, label: 'Review draft PR',
    });
    setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
    const response = await reviewRoute.POST(new NextRequest('http://localhost/api/review/auto-review', {
      method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost' },
      body: JSON.stringify({ action: 'enqueue', laneId: lane.id }),
    }));
    expect(response.status).toBe(200);
    await drainReviewQueue();

    const discovery = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tools = (discovery?.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name);
    const referenced = [...new Set(reviewer.prompt.match(/\b(?:submit_review|lane_command|approve_and_merge|o8_\w+)\b/g))];
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter(name => !tools.includes(name))).toEqual([]);
    expect(reviewer.prompt).toContain(`approve_and_merge({"packetId":"${reviewer.packetId}"`);
    expect(reviewer.prompt).toContain('Operator follow-up:');
    expect(reviewer.prompt).toContain('findings');
    expect(reviewer.prompt).toContain('Never attempt a merge after a rejected or unrecorded verdict.');
    expect(reviewer.prompt).toContain('do not merge when the requested outcome is PR publication only.');
    expect(getSqlite().prepare('SELECT status FROM review_queue WHERE lane_id = ?').get(lane.id))
      .toMatchObject({ status: 'completed' });
    const approval = listApprovalsForContext({ packetId: reviewer.packetId, laneId: lane.id })
      .find(candidate => candidate.toolName === 'orchestrator_review');
    expect(approval?.args).toMatchObject({ reviewedHeadSha: reviewer.head,
      findings: [{ resolution: 'accepted', description: expect.stringContaining('Operator follow-up:') }] });
    expect(approval?.description).toContain('Operator follow-up:');
  });
});
