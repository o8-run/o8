import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';

const directory = mkdtempSync(join(tmpdir(), 'o8-cortex-reads-'));
process.env.O8_DATA_DIR = directory;
process.env.CORTEX_IDE_DATA_DIR = directory;
process.env.CORTEX_IDE_DB_PATH = join(directory, 'cortex-ide.db');
vi.stubEnv('O8_LEGACY_JACCARD_PROPOSER', '1');

// Seed persisted inputs directly, without scheduling registry write maintenance.
const repos = ['source', 'peer-a', 'peer-b'].map(id => ({
  id, name: id, localPath: join(directory, id), isGitRepo: false,
  addedAt: new Date().toISOString(),
}));
for (const repo of repos) {
  mkdirSync(repo.localPath);
  writeFileSync(join(repo.localPath, 'package.json'), JSON.stringify({ dependencies: { shared: '1' } }));
}
writeFileSync(join(directory, 'repos.json'), JSON.stringify({ version: 1, repos }));
mkdirSync(join(directory, 'directives'));
writeFileSync(join(directory, 'directives', 'shared-rule.md'), [
  '---', 'id: shared-rule', 'title: Shared rule', 'scope: repo', 'repoName: source', '---', 'Check the shared dependency.',
].join('\n'));

const route = await import('@/app/api/cortex/cross-repo-proposals/route');
const { ensureStackSignatureBoot } = await import('@/lib/cortex/stack-signature');
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function snapshot(allowBootstrap = false) {
  return ['.', ...readdirSync(directory, { recursive: true }).map(String).sort()]
    .filter(name => !/^cortex-ide\.db(?:-wal|-shm)?$/.test(name))
    // Shared schema migrations also leave version markers on a cold DB.
    .filter(name => !/^\.db-migrated-(?:v\d+|projects-ledger-v1)$/.test(name))
    .map(name => {
      const path = join(directory, name);
      const stat = statSync(path, { bigint: true });
      // SQLite schema bootstrap may change the root directory's mtime.
      return { name, mtime: name === '.' && allowBootstrap ? null : stat.mtimeNs,
        bytes: stat.isFile() ? readFileSync(path) : null };
    });
}

async function read(query = '') {
  const response = await route.GET(new NextRequest(`http://localhost/api/cortex/cross-repo-proposals${query}`));
  expect(response.status).toBe(200);
  return response.json();
}

it('cold legacy GET returns proposals without creating or changing any owned file or directory', async () => {
  const before = snapshot();
  for (const query of ['', '?force=1', '?force=true']) {
    const body = await read(query);
    expect(body.proposals).toEqual([
      expect.objectContaining({ targetRepoId: 'peer-a', directiveId: 'shared-rule', similarity: 1 }),
      expect.objectContaining({ targetRepoId: 'peer-b', directiveId: 'shared-rule', similarity: 1 }),
    ]);
    expect(existsSync(join(directory, 'stack-signatures.json')), 'GET must not create the signature cache').toBe(false);
    expect(snapshot()).toEqual(before);
  }
});

it('default project GET on a cold database creates no project or membership rows', async () => {
  vi.stubEnv('O8_LEGACY_JACCARD_PROPOSER', '0');
  const before = snapshot(true);
  expect((await read('?force=1')).proposals).toEqual([]);
  expect(snapshot(true)).toEqual(before);
  const { getSqlite } = await import('@/lib/db');
  for (const table of ['projects', 'project_repos']) {
    expect(getSqlite().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
  }
  vi.stubEnv('O8_LEGACY_JACCARD_PROPOSER', '1');
});

it('forced legacy GET computes an empty signature cache in memory without overwriting it', async () => {
  const file = join(directory, 'stack-signatures.json');
  writeFileSync(file, JSON.stringify({ version: 1, signatures: [] }));
  try {
    const before = snapshot();
    expect((await read('?force=true')).proposals).toHaveLength(2);
    expect(snapshot()).toEqual(before);
  } finally {
    rmSync(file);
  }
});

it('the existing startup hook persists signatures and later GETs leave that cache unchanged', async () => {
  const file = join(directory, 'stack-signatures.json');
  expect(existsSync(file)).toBe(false);
  ensureStackSignatureBoot();
  await vi.waitFor(() => expect(existsSync(file)).toBe(true));
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  expect(saved.signatures).toHaveLength(3);
  expect(saved.signatures.every((entry: { deps: string[] }) => entry.deps.join() === 'shared')).toBe(true);
  const before = snapshot();
  expect((await read('?force=1')).proposals).toHaveLength(2);
  expect(snapshot()).toEqual(before);
});
