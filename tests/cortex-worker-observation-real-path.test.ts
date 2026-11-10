import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

function mcp(child: ChildProcessWithoutNullStreams) {
  let sequence = 0;
  let buffer = '';
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n'); buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      const result = JSON.parse(line);
      pending.get(result.id)?.(result.result); pending.delete(result.id);
    }
  });
  return (name: string, args: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${name}`)); }, 15_000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });
}

function payload(result: Record<string, unknown>) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

it('observes only persisted parent workers through the actual MCP entry, with stable bounded waits and incremental reads', { timeout: 45_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-worker-observation-')));
  const data = join(root, 'data'); const repo = join(root, 'repo');
  mkdirSync(repo); mkdirSync(join(data, 'shared-checkout-teams', 'archive'), { recursive: true });
  const parent = 'thoughts-observation';
  const surface = 'opencode-owned:related';
  const archived = 'claude-code-owned:archived';
  const isolated = 'codex-owned:isolated';
  const fileBound = 'codex-owned:file-bound';
  const unknown = 'codex-owned:missing';
  const hash = createHash('sha256').update(repo).digest('hex').slice(0, 24);
  const team = { id: hash, path: repo, parentThreadId: parent, members: [{ surfaceId: surface, runtime: 'opencode' }, { surfaceId: unknown, runtime: 'codex' }] };
  writeFileSync(join(data, 'shared-checkout-teams', `${hash}.json`), JSON.stringify(team));
  writeFileSync(join(data, 'shared-checkout-teams', 'archive', `${hash}-1.json`), JSON.stringify({ ...team, members: [{ surfaceId: archived, runtime: 'claude-code' }], finishedAt: '2026-01-01T00:00:00Z' }));
  writeFileSync(join(data, 'orchestrator-state.json'), JSON.stringify({ version: 1, mission: { packets: [
    { id: 'packet-related', workspaceTargetPath: repo, orchestratorThreadId: parent, runtime: 'codex' },
    { id: 'packet-file', workspaceTargetPath: repo, orchestratorThreadId: parent, runtime: 'codex', lane: { sessionKey: fileBound } },
    { id: 'packet-unrelated', workspaceTargetPath: repo, orchestratorThreadId: 'thoughts-other', runtime: 'codex' },
  ] } }));
  const sessionPath = join(data, 'owned-opencode', 'related', 'session.json');
  mkdirSync(join(sessionPath, '..'), { recursive: true });
  const run = { id: 'run-1', startedAt: '2026-01-01T00:00:00Z', outcome: 'running' };
  writeFileSync(sessionPath, JSON.stringify({ surfaceId: surface, activeRun: run, recentRuns: [] }));
  const archivedSession = join(data, 'owned-claude-code-archive', 'archived', 'session.json');
  mkdirSync(join(archivedSession, '..'), { recursive: true });
  writeFileSync(archivedSession, JSON.stringify({ surfaceId: archived, recentRuns: [{ ...run, id: 'archived-run', outcome: 'finished', finishedAt: '2026-01-01T00:01:00Z' }] }));
  vi.stubEnv('CORTEX_IDE_DATA_DIR', data); vi.stubEnv('O8_DATA_DIR', data);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(data, 'cortex-ide.db'));
  const { getSqlite, closeDb } = await import('@/lib/db');
  const db = getSqlite();
  for (const [id, packetId, sessionKey] of [['lane-related', 'packet-related', isolated], ['lane-other', 'packet-unrelated', 'codex-owned:unrelated']]) {
    db.prepare(`INSERT INTO lanes (id, label, repo_path, branch, base_branch, runtime, session_key, packet_id, status, ownership, created_at, updated_at)
      VALUES (?, 'fixture', ?, 'main', 'main', 'codex', ?, ?, 'running', 'orchestrator', 'now', 'now')`).run(id, repo, sessionKey, packetId);
  }
  db.prepare(`INSERT INTO shared_worker_parents (surface_id, repo_path, thread_id, turn_id, origin_json, created_at)
    VALUES (?, ?, ?, 'turn-1', '{}', 1)`).run(surface, repo, parent);
  db.prepare(`INSERT INTO shared_worker_returns (id, surface_id, run_id, outcome, summary, status, created_at, updated_at)
    VALUES ('return-1', ?, 'run-1', 'finished', 'result', 'pending', 1, 1)`).run(surface);
  db.prepare(`INSERT INTO shared_worker_parents (surface_id, repo_path, thread_id, turn_id, origin_json, created_at)
    VALUES (?, ?, ?, 'turn-archived', '{}', 1)`).run(archived, repo, parent);
  db.prepare(`INSERT INTO shared_worker_returns (id, surface_id, run_id, outcome, summary, status, created_at, updated_at)
    VALUES ('return-archived', ?, 'archived-run', 'finished', 'saved result', 'delivered', 1, 1)`).run(archived);
  let mutations = 0;
  let transcriptQuery = '';
  const server = createServer((request, response) => {
    if (request.method !== 'GET') mutations += 1;
    response.setHeader('content-type', 'application/json');
    if (request.url?.startsWith('/api/runtime/inventory')) response.end(JSON.stringify({ agents: [
      { name: 'Related', runtime: 'opencode', sessionKey: surface, runtimeSurface: { id: surface, ownership: 'owned', capabilities: { readTail: true, sendInput: true } } },
      { name: 'External', runtime: 'muse', sessionKey: 'muse-discovered:external', runtimeSurface: { id: 'muse-discovered:external', ownership: 'discovered', capabilities: { readTail: true, sendInput: false } } },
    ] }));
    else if (request.url?.startsWith('/api/runtime/transcript')) {
      transcriptQuery = request.url;
      const transcript = Array.from({ length: request.url.includes('sinceId=budget') ? 20 : 1 }, (_, i) =>
        ({ id: `entry-${i + 2}`, role: 'assistant', text: 'x'.repeat(3000), timestamp: 1, type: 'message' }));
      response.end(JSON.stringify({ transcript }));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture API unavailable.');
  const children: ChildProcessWithoutNullStreams[] = [];
  const start = () => {
    const child = spawn('npx', ['tsx', 'src/lib/mcp/cortex-mcp-server.ts'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], env: {
      ...process.env, CORTEX_API_BASE: `http://127.0.0.1:${address.port}`, CORTEX_REPO_PATH: repo, CORTEX_THREAD_ID: parent,
      O8_MCP_NODE22_CHECKED: '1', CORTEX_READONLY: '1', O8_OWNED_OPENCODE_ROOT: join(data, 'owned-opencode'),
      CORTEX_IDE_OWNED_CODEX_ROOT: join(data, 'owned-codex'), CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT: join(data, 'owned-claude-code'),
    } });
    children.push(child); return mcp(child);
  };
  try {
    const call = start();
    const first = payload(await call('cortex_wait_workers', { surfaceIds: [surface, archived, isolated, fileBound, unknown], timeoutMs: 0 }));
    expect(first.workers).toEqual(expect.arrayContaining([
      expect.objectContaining({ surfaceId: surface, runtime: 'opencode', runId: 'run-1', outcome: 'running', delivery: expect.objectContaining({ status: 'pending', id: 'return-1' }) }),
      expect.objectContaining({ surfaceId: archived, runtime: 'claude-code', membership: 'archived', runId: 'archived-run', outcome: 'finished', delivery: expect.objectContaining({ status: 'delivered', id: 'return-archived' }) }),
      expect.objectContaining({ surfaceId: isolated, runtime: 'codex', checkoutMode: 'isolated' }),
      expect.objectContaining({ surfaceId: fileBound, runtime: 'codex', checkoutMode: 'isolated' }),
      expect.objectContaining({ surfaceId: unknown, runId: null, outcome: 'unknown' }),
    ]));
    expect(existsSync(join(data, 'owned-codex'))).toBe(false);
    expect(existsSync(join(data, 'owned-claude-code'))).toBe(false);
    const args = { surfaceIds: [surface, archived, isolated, fileBound, unknown], timeoutMs: 0, afterCursor: first.cursor };
    expect(payload(await call('cortex_wait_workers', args))).toMatchObject({ changed: false, timedOut: true, cursor: first.cursor });
    expect(payload(await start()('cortex_wait_workers', args))).toMatchObject({ changed: false, cursor: first.cursor });
    const waiting = call('cortex_wait_workers', { ...args, timeoutMs: 3000 });
    await new Promise(resolve => setTimeout(resolve, 150));
    writeFileSync(sessionPath, JSON.stringify({ surfaceId: surface, recentRuns: [{ ...run, outcome: 'finished', finishedAt: '2026-01-01T00:01:00Z' }] }));
    const changed = payload(await waiting);
    expect(changed).toMatchObject({ changed: true, timedOut: false });
    expect(changed.cursor).not.toBe(first.cursor);
    expect(changed.workers.find((worker: { surfaceId: string }) => worker.surfaceId === surface)).toMatchObject({ outcome: 'finished', runId: 'run-1' });
    const stable = payload(await call('cortex_wait_workers', { ...args, afterCursor: changed.cursor, timeoutMs: 100 }));
    expect(stable).toMatchObject({ changed: false, timedOut: true, cursor: changed.cursor });
    db.prepare("UPDATE shared_worker_returns SET status = 'delivered' WHERE id = 'return-1'").run();
    const delivered = payload(await call('cortex_wait_workers', { ...args, afterCursor: stable.cursor }));
    expect(delivered).toMatchObject({ changed: true });
    expect(delivered.workers.find((worker: { surfaceId: string }) => worker.surfaceId === surface).delivery.status).toBe('delivered');
    writeFileSync(sessionPath, JSON.stringify({ surfaceId: surface, activeRun: { ...run, id: 'run-2' }, recentRuns: [{ ...run, outcome: 'finished' }] }));
    const resumed = payload(await call('cortex_wait_workers', { ...args, afterCursor: delivered.cursor }));
    expect(resumed.workers.find((worker: { surfaceId: string }) => worker.surfaceId === surface)).toMatchObject({ runId: 'run-2', outcome: 'running', delivery: { status: 'unknown' } });
    expect((await call('cortex_wait_workers', { surfaceIds: ['codex-owned:unrelated'], timeoutMs: 0 })).isError).toBe(true);
    expect((await call('cortex_wait_workers', { surfaceIds: [surface], timeoutMs: 30001 })).isError).toBe(true);
    expect((await call('cortex_wait_workers', { surfaceIds: Array(9).fill(surface) })).isError).toBe(true);
    const fleet = payload(await call('cortex_fleet_status'));
    expect(fleet.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtime: 'opencode', surfaceId: surface, related: true, ownership: 'owned' }),
      expect.objectContaining({ runtime: 'muse', surfaceId: 'muse-discovered:external', related: false, ownership: 'discovered', capabilities: { readTail: true, sendInput: false } }),
    ]));
    const transcript = payload(await call('cortex_read_transcript', { sessionKey: surface, sinceId: 'entry-1', maxTextChars: 1000 }));
    expect(transcriptQuery).toContain('sinceId=entry-1');
    expect(transcript).toMatchObject({ nextCursor: 'entry-2', truncated: true, transcript: [expect.objectContaining({ id: 'entry-2', truncated: true, originalTextChars: 3000 })] });
    expect(transcript.transcript[0].text.length).toBe(1000);
    const bounded = payload(await call('cortex_read_transcript', { sessionKey: surface, sinceId: 'budget' }));
    expect(JSON.stringify(bounded).length).toBeLessThan(35_000);
    expect(bounded.omittedEntries).toBeGreaterThan(0);
    expect(bounded.nextCursor).toBe(bounded.transcript.at(-1).id);
    expect(mutations).toBe(0);
  } finally {
    for (const child of children) {
      child.stdin.end(); child.kill('SIGKILL'); await once(child, 'exit');
    }
    server.close(); await once(server, 'close'); closeDb(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
