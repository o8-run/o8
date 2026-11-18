import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';

const checkout = vi.hoisted(() => ({ path: '' }));
vi.mock('@/lib/lane/registry', () => ({ findLaneBySession: () => ({ worktreePath: checkout.path }) }));
vi.mock('@/lib/mobile/orchestrator-thread-history', () => ({ readProjectedThread: () => ({ repoPath: checkout.path }) }));
const root = mkdtempSync(join(tmpdir(), 'phone-source-control-'));
const token = 'phone-source-control-fixture';
process.env.CORTEX_IDE_DATA_DIR = root;
writeFileSync(join(root, 'mobile-device-tokens'), createHash('sha256').update(token).digest('hex') + '\n');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
// The phone interpolates SourceAction in write(`/api/mobile/source-control/${action}`, body).
// Keep the complete dynamic caller inventory here; literal-only scans miss these routes.
const phoneActions = ['stage', 'unstage', 'commit', 'pull', 'push'] as const;
const file = z.object({ path: z.string(), originalPath: z.string().optional(), index: z.string(), worktree: z.string(), staged: z.boolean(), unstaged: z.boolean(), untracked: z.boolean() });
const sourceResponse = z.object({ ok: z.literal(true), status: z.object({ branch: z.string().nullable(), upstream: z.string().nullable(), ahead: z.number().int().nonnegative(), behind: z.number().int().nonnegative(), files: z.array(file) }) });
let origin = '';
const server = createServer(async (req, res) => {
  const { handleNativeHttp } = await import('@/lib/ws-server/native-http-routes');
  if (!await handleNativeHttp(req, res, req.socket.localPort, false, '198.51.100.2')) res.writeHead(404).end();
});
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

it.each(phoneActions)('keeps the dynamic phone caller %s in route templates and Next handlers', async action => {
  const path = `/api/mobile/source-control/${action}`;
  expect(JSON.parse(readFileSync('crates/o8d/route-templates.json', 'utf8'))).toContain(path);
  expect(readFileSync(`src/app${path}/route.ts`, 'utf8')).toContain(`sourceControlResponse(request, '${action}')`);
});

it.each(['unstage', 'pull', 'push'] as const)('executes phone %s over HTTP and returns the phone schema', async action => {
  const identity = action === 'push' ? 'threadId' : 'sessionKey';
  const cwd = mkdtempSync(join(root, 'checkout-'));
  checkout.path = cwd;
  git(cwd, 'init', '-b', 'feature');
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  const remote = mkdtempSync(join(root, 'remote-'));
  git(remote, 'init', '--bare', '--initial-branch=trunk');
  writeFileSync(join(cwd, 'a'), 'initial');
  git(cwd, 'add', '--', 'a');
  git(cwd, 'commit', '-m', 'initial');
  git(cwd, 'remote', 'add', 'origin', remote);
  git(cwd, 'push', 'origin', 'HEAD:trunk');
  const write = async (action: typeof phoneActions[number], body: object = {}) => {
    const response = await fetch(`${origin}/api/mobile/source-control/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ [identity]: 'phone-thread', ...body }) });
    expect(response.status, action).toBe(200);
    return sourceResponse.parse(await response.json()).status;
  };
  git(cwd, 'push', '--set-upstream', 'origin', 'feature');
  // Probe each restored route independently before exercising the complete flow.
  await write(action, action === 'unstage' ? { all: true } : {});
  writeFileSync(join(cwd, 'a'), 'changed');
  await write('stage', { paths: ['a'] });
  expect((await write('unstage', { paths: ['a'] })).files[0]).toMatchObject({ staged: false, unstaged: true });
  expect(git(cwd, 'diff', '--cached')).toBe('');
  await write('stage', { all: true });
  expect((await write('unstage', { all: true })).files[0].staged).toBe(false);
  await write('stage', { all: true });
  await write('commit', { message: 'phone commit' });
  expect((await write('push')).upstream).toBe('origin/feature');
  expect(git(remote, 'rev-parse', 'feature')).toBe(git(cwd, 'rev-parse', 'HEAD'));
  const peer = mkdtempSync(join(root, 'peer-'));
  git(peer, 'clone', '--branch', 'feature', remote, '.');
  git(peer, 'config', 'user.name', 'Test');
  git(peer, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(peer, 'remote-file'), 'pulled');
  git(peer, 'add', '--', 'remote-file');
  git(peer, 'commit', '-m', 'remote change');
  git(peer, 'push');
  expect((await write('pull')).behind).toBe(0);
  expect(readFileSync(join(cwd, 'remote-file'), 'utf8')).toBe('pulled');
});

it.each(phoneActions)('restricts native phone %s to paired POST requests', async action => {
  const url = `${origin}/api/mobile/source-control/${action}`;
  for (const bearer of ['', 'revoked-device']) {
    expect((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(401);
  }
  expect((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(403);
});
