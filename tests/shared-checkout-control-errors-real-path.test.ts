import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, expect, it, vi } from 'vitest';
import { buildToolRegistry, resetToolSpinePortIdentityForTests } from '@/lib/mcp/tool-spine/build';
import { toCodexServersMap } from '@/lib/mcp/tool-spine/emit-codex';
import { readSharedCheckoutTeam, recordSharedCheckoutMember, reserveSharedCheckoutMember } from '@/lib/orchestrator/shared-checkout-team';

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };
type Review = { id: string; head: string; paths: string[] };
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

function toolClient(child: ChildProcessWithoutNullStreams) {
  let nextId = 0;
  const pending = new Map<number, (result: ToolResult) => void>();
  createInterface({ input: child.stdout }).on('line', line => {
    if (!line.startsWith('{')) return;
    const message = JSON.parse(line) as { id: number; result: ToolResult };
    pending.get(message.id)?.(message.result);
  });
  return (name: string, args: Record<string, unknown> = {}) => new Promise<ToolResult>((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The fixture control call did not settle.')); }, 30_000);
    pending.set(id, result => { clearTimeout(timer); pending.delete(id); resolve(result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
  }
  vi.unstubAllEnvs(); resetToolSpinePortIdentityForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const externalData = process.env.O8_CHECKOUT_CONTROL_DATA_DIR;
  const root = realpathSync(mkdtempSync(join(externalData || tmpdir(), 'o8-checkout-controls-')));
  roots.push(root);
  const repoPath = join(root, 'repo'); const dataDir = externalData || join(root, 'data'); const owned = join(root, 'owned');
  mkdirSync(repoPath); mkdirSync(dataDir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  writeFileSync(join(repoPath, 'operator-note.txt'), 'Original note.\n');
  git('add', '.'); git('-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'fixture');
  writeFileSync(join(repoPath, 'operator-note.txt'), 'Preserved operator edit.\n');
  vi.stubEnv('O8_DATA_DIR', dataDir); vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
  vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', owned);
  vi.stubEnv('O8_BUNDLED_MCP_PATH', ''); vi.stubEnv('O8_BUNDLED_MCP_DIR', ''); vi.stubEnv('O8_PACKAGED_APP', '');
  resetToolSpinePortIdentityForTests();
  const parentThreadId = 'thoughts-checkout-control'; const target = { repoPath, parentThreadId, dataDir };
  await reserveSharedCheckoutMember({ ...target, runtime: 'codex', taskName: 'Finished fixture worker', clientMutationId: 'checkout-control-fixture', paths: ['worker.txt'] });
  await recordSharedCheckoutMember({ ...target, runtime: 'codex', taskName: 'Finished fixture worker', clientMutationId: 'checkout-control-fixture', surfaceId: 'codex-owned:checkout-control-fixture' });
  mkdirSync(join(owned, 'fixture'), { recursive: true });
  writeFileSync(join(owned, 'fixture', 'session.json'), JSON.stringify({ surfaceId: 'codex-owned:checkout-control-fixture',
    launchMutationId: 'checkout-control-fixture', cwd: repoPath, repoPath, recentRuns: [{ id: 'finished-fixture-run', outcome: 'finished' }] }));
  mkdirSync(join(dataDir, 'chat-history'), { recursive: true });
  for (const id of [parentThreadId, 'thoughts-checkout-second']) {
    writeFileSync(join(dataDir, 'chat-history', id + '.json'), JSON.stringify({ repoPath, backend: 'codex', messages: [] }));
  }
  let diagnostic = '';
  const start = (threadId: string) => {
    const config = toCodexServersMap(buildToolRegistry(repoPath, { threadId })).cortex;
    if (config.type !== 'stdio') throw new Error('The production Shared controls require the stdio server.');
    const child = spawn(config.command, config.args, { cwd: repoPath, env: { ...process.env, ...config.env, NODE_OPTIONS: '--conditions=react-server' }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child); child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-64_000); });
    return toolClient(child);
  };
  const call = start(parentThreadId);
  const status = async () => JSON.parse((await call('cortex_shared_team_status')).content[0].text) as { review: Review };
  const reconcile = async (review: Review) => call('cortex_reconcile_shared_team', { reviewId: review.id, reviewedHead: review.head,
    acknowledgedPaths: review.paths, reviewSummary: 'Reviewed the preserved operator edit; retain it exactly.' });
  const finishArgs = { reviewSummary: 'Reviewed the finished worker and preserved edit.', verification: 'Verified the exact fixture state.' };
  const serverState = async () => {
    const base = process.env.O8_CHECKOUT_CONTROL_DEV_URL;
    if (!base) return;
    const response = await fetch(new URL('/api/orchestrator/shared-team/active?' + new URLSearchParams({ repoPath }), base), {
      headers: { Authorization: 'Bearer ' + readFileSync(join(dataDir, 'ws-token'), 'utf8').trim() },
    });
    expect(response.status).toBe(200);
    return await response.json() as { team: { parentThreadId: string } | null };
  };
  return { target, repoPath, call, start, status, reconcile, finishArgs, serverState, failureLine: () => diagnostic.split('\n').find(line => line.startsWith('[mcp] Tool failure:')) };
}

it.each(['reconcile', 'finish'] as const)('names the %s control and its actual hold, preserves the edit, and recovers after a fresh review', async action => {
  const fixture = await setup();
  const initialReview = (await fixture.status()).review;
  const operatorFile = join(fixture.repoPath, 'operator-note.txt');
  writeFileSync(operatorFile, 'Preserved operator edit, changed after review.\n');
  const before = JSON.stringify(readSharedCheckoutTeam(fixture.target));
  const serverBefore = await fixture.serverState();
  if (serverBefore) expect(serverBefore.team?.parentThreadId).toBe(fixture.target.parentThreadId);
  const name = action === 'reconcile' ? 'cortex_reconcile_shared_team' : 'cortex_finish_shared_team';
  const result = action === 'reconcile' ? await fixture.reconcile(initialReview) : await fixture.call(name, fixture.finishArgs);
  expect(result.isError).toBe(true);
  const message = result.content.map(entry => entry.text).join('\n');
  // Preserve the actual production reply as a fail-first receipt, without paths or draft contents.
  console.log(JSON.stringify({ call: name, failure: message, runtimeFailure: fixture.failureLine() }));
  expect(message).toContain(name);
  expect(message).toMatch(action === 'reconcile' ? /review is stale/i : /operator edits changed/i);
  expect(message).toContain('cortex_shared_team_status');
  expect(message).toMatch(/retry|try again/i);
  expect(message).not.toContain('o8 operation failed');
  expect(JSON.stringify(readSharedCheckoutTeam(fixture.target))).toBe(before);
  expect(readFileSync(operatorFile, 'utf8')).toBe('Preserved operator edit, changed after review.\n');
  const serverHeld = await fixture.serverState();
  if (serverHeld) expect(serverHeld.team?.parentThreadId).toBe(fixture.target.parentThreadId);
  const current = (await fixture.status()).review;
  expect((await fixture.reconcile(current)).isError).not.toBe(true);
  expect((await fixture.call('cortex_finish_shared_team', fixture.finishArgs)).isError).not.toBe(true);
  expect(readSharedCheckoutTeam(fixture.target)).toBeNull();
  expect(readFileSync(operatorFile, 'utf8')).toBe('Preserved operator edit, changed after review.\n');
  const serverAfter = await fixture.serverState();
  if (serverAfter) expect(serverAfter.team).toBeNull();
}, 90_000);


it.each(['reconcile', 'finish'] as const)('names the %s ownership refusal in a second saved thread without suggesting an unavailable status call', async action => {
  const fixture = await setup();
  const operatorFile = join(fixture.repoPath, 'operator-note.txt');
  writeFileSync(operatorFile, 'Operator edit reviewed in the owning thread.\n');
  const review = (await fixture.status()).review;
  expect((await fixture.reconcile(review)).isError).not.toBe(true);
  expect(readSharedCheckoutTeam(fixture.target)?.reconciliations).toHaveLength(1);
  const before = JSON.stringify(readSharedCheckoutTeam(fixture.target));
  const serverBefore = await fixture.serverState();
  if (serverBefore) expect(serverBefore.team?.parentThreadId).toBe(fixture.target.parentThreadId);
  const other = fixture.start('thoughts-checkout-second');
  const name = action === 'reconcile' ? 'cortex_reconcile_shared_team' : 'cortex_finish_shared_team';
  const result = await other(name, action === 'reconcile' ? { reviewId: review.id, reviewedHead: review.head,
    acknowledgedPaths: review.paths, reviewSummary: 'Reviewed the current checkout.' } : fixture.finishArgs);
  expect(result.isError).toBe(true);
  const message = result.content.map(entry => entry.text).join('\n');
  console.log(JSON.stringify({ call: name, failure: message }));
  expect(message).toContain(name);
  expect(message).toMatch(/another orchestrator thread owns this checkout/i);
  expect(message).toMatch(/continue in the owning thread/i);
  expect(message).toMatch(/separate checkout/i);
  expect(message).not.toContain('cortex_shared_team_status');
  expect(message).not.toMatch(/unknown|o8 operation failed/i);
  expect(message).not.toContain(fixture.repoPath);
  expect(message).not.toContain(fixture.target.parentThreadId);
  expect(JSON.stringify(readSharedCheckoutTeam(fixture.target))).toBe(before);
  expect(readFileSync(operatorFile, 'utf8')).toBe('Operator edit reviewed in the owning thread.\n');
  expect((await fixture.call('cortex_finish_shared_team', fixture.finishArgs)).isError).not.toBe(true);
  expect(readSharedCheckoutTeam(fixture.target)).toBeNull();
  const serverAfter = await fixture.serverState();
  if (serverAfter) expect(serverAfter.team).toBeNull();
}, 90_000);
