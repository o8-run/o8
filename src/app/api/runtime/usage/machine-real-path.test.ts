import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import { GET } from './route';
import { REMOTE_USAGE_PROBE } from '@/lib/usage/remote-probe.generated';
import { build } from 'esbuild';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it('reads a saved machine through the HTTP entry point, real probe process and persisted catalog, without leaking transcripts or modifying provider stores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'o8-machine-usage-')); const id = randomUUID(); const args = join(root, 'ssh-args');
  try {
    for (const name of ['O8_DATA_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'OPENCODE_DATA_DIR', 'ANTIGRAVITY_DATA_DIR']) vi.stubEnv(name, root);
    vi.stubEnv('PATH', `${root}:${process.env.PATH}`); vi.stubEnv('O8_TEST_NODE', process.execPath); vi.stubEnv('O8_TEST_SSH_ARGS', args);
    // Children inherit only allowlisted names (#4585). The fake ssh runs the probe locally, so it needs
    // its knobs and the fixture's store homes, never the host's own provider stores.
    vi.stubEnv('O8_WORKER_ENV_ALLOW', ['O8_TEST_NODE', 'O8_TEST_SSH_ARGS', 'O8_DATA_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
      'GROK_HOME', 'OPENCODE_DATA_DIR', 'ANTIGRAVITY_DATA_DIR'].join(','));
    await mkdir(join(root, 'projects'));
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(join(root, 'opencode.db'));
    database.exec('PRAGMA journal_mode=WAL; CREATE TABLE unused(id TEXT)'); database.close();
    const databaseBefore = await readFile(join(root, 'opencode.db'));
    const catalog = { schema: 'o8/cli/machines/v1', machines: [{ id, label: 'Build host', target: 'usagehost', port: 2200, sshConfig: null, remoteCli: 'o8', enabled: true, usageOnly: true }] };
    await writeFile(join(root, 'ssh-machines.json'), JSON.stringify(catalog));
    await writeFile(join(root, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$@" > "$O8_TEST_SSH_ARGS"\nexec "$O8_TEST_NODE" --no-warnings -\n`);
    await chmod(join(root, 'ssh'), 0o700);
    await writeFile(join(root, 'projects', 'external.jsonl'), JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), sessionId: 'external-session', requestId: 'external-request',
      message: { id: 'external-message', model: 'fixture-model', content: 'PRIVATE-REMOTE-CHAT', usage: { input_tokens: 10, output_tokens: 20 } } }) + '\n');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ 'fixture-model': { input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 } })));
    const request = (query: string) => new NextRequest(`http://localhost/api/runtime/usage?${query}`, { headers: { host: 'localhost' } });
    const inventory = await GET(request('machines=1')); expect(inventory.status).toBe(200);
    expect((await inventory.json()).machines).toContainEqual({ id, label: 'Build host', enabled: true, local: false });
    expect((await GET(request('machine=unknown'))).status).toBe(404);
    const query = `machine=${id}&days=7&timeZone=UTC`;
    expect((await GET(request(query))).status).toBe(202);
    let snapshot: Record<string, unknown> = {};
    await vi.waitFor(async () => {
      const response = await GET(request(query)); expect(response.status).toBe(200); snapshot = await response.json();
      expect(snapshot).toMatchObject({ machine: { id, label: 'Build host' }, providerSessions: { claude: 1 },
        buckets: [{ totals: { uncachedInputTokens: 10, outputTokens: 20 } }] });
    }, { timeout: 15_000, interval: 100 });
    expect((snapshot.buckets as { costUsd: number }[])[0].costUsd).toBeCloseTo(0.00018);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE-REMOTE-CHAT'); expect(JSON.stringify(snapshot)).not.toContain(root);
    const actualArgs = await readFile(args, 'utf8'); expect(actualArgs).toContain('StrictHostKeyChecking=yes');
    expect(actualArgs).toContain('BatchMode=yes'); expect(actualArgs).toContain('\n2200\n--\nusagehost\n');
    expect(await readFile(join(root, 'ssh-machines.json'), 'utf8')).toBe(JSON.stringify(catalog));
    expect(await readFile(join(root, 'opencode.db'))).toEqual(databaseBefore);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(root, 'opencode.db-wal'))).toBe(false); expect(existsSync(join(root, 'opencode.db-shm'))).toBe(false);
    expect(existsSync(join(root, 'usage-history', 'scans-v1.json.gz'))).toBe(false);
    // A failed remote refresh must retain this machine's observation, never fall back to local history.
    await writeFile(join(root, 'ssh'), '#!/bin/sh\necho "private host detail" >&2\nexit 255\n');
    await new Promise(resolve => setTimeout(resolve, 1_050));
    await GET(request(`${query}&fresh=1`));
    await vi.waitFor(async () => {
      const response = await GET(request(query)); expect(response.status).toBe(200);
      const data = await response.json(); expect(data.refreshFailed).toBe(true); expect(data.machine.id).toBe(id);
      expect(JSON.stringify(data)).not.toContain('private host detail');
    });
    const remote = new NextRequest(`http://remote.invalid/api/runtime/usage?machine=${id}`);
    expect((await GET(remote)).status).toBe(401);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps the shipped SSH probe identical to the shared collectors it is generated from', async () => {
  const result = await build({ entryPoints: ['src/lib/usage/remote-probe.ts'], bundle: true, platform: 'node', target: 'node22',
    format: 'iife', globalName: 'o8UsageProbe', minify: true, write: false,
    alias: { '@': join(process.cwd(), 'src'), 'server-only': join(process.cwd(), 'scripts/server-only-stub.js') }, legalComments: 'inline' });
  expect(result.outputFiles[0].text).toBe(REMOTE_USAGE_PROBE);
});
