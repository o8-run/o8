import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';

// A packet worker may ask for its own packet's merge preview, which lints the packet's changed
// files. ESLint config is code, so it must come from the base revision and the repository's
// install, never from the packet's checkout. Here the packet changes the config to report an
// outside file's contents, and gives its checkout its own ESLint install.
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));

const root = mkdtempSync(join(tmpdir(), 'o8-preview-lint-'));
const dataDir = join(root, 'data');
mkdirSync(dataDir);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const OPERATOR_TOKEN = 'merge-preview-lint-operator-0123456789';
writeFileSync(join(dataDir, 'ws-token'), `${OPERATOR_TOKEN}\n`, 'utf8');

const { createLane } = await import('@/lib/lane/registry');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { closeDb } = await import('@/lib/db');
const route = await import('@/app/api/orchestrator/merge-preview/route');
const { panelGateMiddleware } = await import('@/middleware');

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=o8 test',
  '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A loopback caller, as Next's bundled server stamps it, through the real gate and then the route.
async function preview(token: string, packetId: string) {
  const url = `http://localhost:3001/api/orchestrator/merge-preview?packetId=${packetId}`;
  const init = { headers: { host: 'localhost:3001', 'x-o8-client-addr': '127.0.0.1', authorization: `Bearer ${token}` } };
  const gate = panelGateMiddleware(new NextRequest(url, init));
  expect(gate.headers.get('x-middleware-next')).toBe('1');
  const res = await route.GET(new NextRequest(url, init));
  expect(res.status).toBe(200);
  return await res.json() as { checks: Array<{ name: string; verdict: string; detail?: string }> };
}

it("lints a worker's packet with the base config and the repository's install", async () => {
  const secret = join(root, 'outside-secret.txt');
  writeFileSync(secret, 'fixture-outside-secret\n');
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ private: true, scripts: { lint: 'eslint .' } }));
  writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
  writeFileSync(join(repo, 'eslint.config.mjs'), "export default [{ files: ['**/*.js'], rules: { 'no-console': 'warn' } }];\n");
  writeFileSync(join(repo, 'src', 'index.js'), 'export const base = 1;\n');
  symlinkSync(join(process.cwd(), 'node_modules'), join(repo, 'node_modules'), 'junction');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');

  const packetId = 'fixture-preview-lint';
  const lane = join(root, 'lane');
  git(repo, 'worktree', 'add', '-q', '-b', `inline/${packetId}`, lane, 'main');
  // The packet's checkout has its own install, and the packet rewrites the lint config.
  symlinkSync(join(process.cwd(), 'node_modules'), join(lane, 'node_modules'), 'junction');
  writeFileSync(join(lane, 'eslint.config.mjs'), [
    "import { readFileSync } from 'node:fs';",
    `const secret = readFileSync(${JSON.stringify(secret)}, 'utf8').trim();`,
    'const leak = { rules: { leak: { create: (context) => ({ Program(node) { context.report({ node, message: secret }); } }) } } };',
    "export default [{ files: ['**/*.js'], plugins: { leak }, rules: { 'leak/leak': 'error' } }];",
    '',
  ].join('\n'));
  writeFileSync(join(lane, 'src', 'index.js'), 'export const base = 1;\nexport const packet = 2;\n');
  git(lane, 'add', '-A');
  git(lane, 'commit', '-qm', 'packet change');
  createLane({ repoPath: repo, worktreePath: lane, branch: `inline/${packetId}`, baseBranch: 'main',
    runtime: 'codex', packetId, sessionKey: `codex:${packetId}` });

  const result = await preview(mintPacketWorkerToken(packetId), packetId);
  expect(JSON.stringify(result)).not.toContain('fixture-outside-secret');
  expect(result.checks.find((check) => check.name === 'lint')).toMatchObject({ verdict: 'pass' });
}, 60_000);
