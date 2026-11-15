import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const architectureDeltaRoute = await import('@/app/api/review/architecture-delta/route');
const { buildArchitectureDelta } = await import('@/lib/review/architecture-delta');
const { collectWorktreeDiffSnapshot } = await import('@/lib/worktree/diff-transport');
const fixturePaths = new Set<string>();

afterEach(() => {
  for (const fixturePath of fixturePaths) rmSync(fixturePath, { recursive: true, force: true });
  fixturePaths.clear();
});

function git(repoPath: string, args: string[]) {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function write(repoPath: string, relativePath: string, content: string) {
  const target = path.join(repoPath, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function createRepo() {
  const repoPath = mkdtempSync(path.join(os.tmpdir(), 'o8-architecture-delta-'));
  fixturePaths.add(repoPath);
  git(repoPath, ['init', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'architecture-delta@example.test']);
  git(repoPath, ['config', 'user.name', 'Architecture Delta Test']);
  write(repoPath, 'tsconfig.json', JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: { '@/*': ['src/*'] },
    },
  }));
  write(repoPath, 'src/feature.ts', "import { core } from '@/core';\nexport const feature = core;\n");
  write(repoPath, 'src/core.ts', 'export const core = 1;\n');
  write(repoPath, 'src/entry.ts', "import { feature } from './feature';\nexport const entry = feature;\n");
  write(repoPath, 'src/unrelated.ts', 'export const unrelated = true;\n');
  git(repoPath, ['add', 'tsconfig.json', 'src/feature.ts', 'src/core.ts', 'src/entry.ts', 'src/unrelated.ts']);
  git(repoPath, ['commit', '-m', 'test: seed architecture fixture']);
  return repoPath;
}

function requestFor(repoPath: string) {
  return new NextRequest(
    `http://localhost:3001/api/review/architecture-delta?workspace=${encodeURIComponent(repoPath)}`,
    { headers: { host: 'localhost:3001' } },
  );
}

describe('review architecture delta route', () => {
  it('rejects a working map whose displayed diff revision changed', async () => {
    const repoPath = createRepo();
    write(repoPath, 'src/feature.ts', 'export const feature = 2;\n');
    const shown = await collectWorktreeDiffSnapshot(repoPath, null);
    const pinned = () => {
      const request = requestFor(repoPath);
      request.nextUrl.searchParams.set('expectedRevision', shown.revision);
      return request;
    };
    expect(await (await architectureDeltaRoute.GET(pinned())).json()).toMatchObject({
      status: 'ready', reviewRevision: shown.revision,
    });
    write(repoPath, 'src/feature.ts', 'export const feature = 3;\n');
    expect((await architectureDeltaRoute.GET(pinned())).status).toBe(409);
  });

  it('compares the real working tree with HEAD and bounds the result to changed modules and neighbors', async () => {
    const repoPath = createRepo();
    write(repoPath, 'src/feature.ts', "import { nextCore } from '@/next-core';\nexport const feature = nextCore;\n");
    write(repoPath, 'src/next-core.ts', 'export const nextCore = 2;\n');

    const response = await architectureDeltaRoute.GET(requestFor(repoPath));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: 'ready', truncated: false });
    expect(body.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/feature.ts', state: 'changed', focusPath: 'src/feature.ts' }),
      expect.objectContaining({ path: 'src/core.ts', state: 'context', focusPath: null }),
      expect.objectContaining({ path: 'src/entry.ts', state: 'context', focusPath: null }),
      expect.objectContaining({ path: 'src/next-core.ts', state: 'added', focusPath: 'src/next-core.ts' }),
    ]));
    expect(body.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/unrelated.ts' }),
    ]));
    expect(body.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'src/feature.ts', to: 'src/core.ts', state: 'removed' }),
      expect.objectContaining({ from: 'src/feature.ts', to: 'src/next-core.ts', state: 'added' }),
      expect.objectContaining({ from: 'src/entry.ts', to: 'src/feature.ts', state: 'context' }),
    ]));
  });

  it('reports an unsupported change set instead of presenting an empty graph as success', async () => {
    const repoPath = createRepo();
    write(repoPath, 'README.md', '# Documentation only\n');

    const response = await architectureDeltaRoute.GET(requestFor(repoPath));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      status: 'unsupported',
      reason: 'No supported source modules changed.',
      nodes: [],
      edges: [],
    });
    expect(body.unsupportedPaths).toContain('README.md');
  });

  it('rejects a mixed snapshot when modified bytes change without changing porcelain status', async () => {
    const repoPath = createRepo();
    write(repoPath, 'src/feature.ts', 'export const feature = 2;\n');

    const result = await buildArchitectureDelta({
      repoPath,
      afterSnapshotForTesting: () => {
        write(repoPath, 'src/feature.ts', 'export const feature = 3;\n');
      },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'unavailable',
      reason: 'The workspace changed during architecture analysis. Refresh Review to retry.',
    });
  });

  it('reuses an exact snapshot and invalidates the cache when modified bytes change', async () => {
    const repoPath = createRepo();
    write(repoPath, 'src/feature.ts', "import { core } from './core';\nexport const feature = core + 1;\n");

    const first = await buildArchitectureDelta({ repoPath });
    const cached = await buildArchitectureDelta({ repoPath });

    expect(cached).toBe(first);

    write(repoPath, 'src/feature.ts', 'export const feature = 3;\n');
    const refreshed = await buildArchitectureDelta({ repoPath });

    expect(refreshed).not.toBe(first);
    expect(refreshed.analysisId).not.toBe(first.analysisId);
  });

  it('does not store later analyzed bytes under an earlier same-porcelain cache key', async () => {
    const repoPath = createRepo();
    const snapshotA = "import { core } from './core';\nexport const feature = core + 1;\n";
    const snapshotB = 'export const feature = 3;\n';
    write(repoPath, 'src/feature.ts', snapshotA);

    const analyzedB = await buildArchitectureDelta({
      repoPath,
      afterCacheKeyForTesting: () => write(repoPath, 'src/feature.ts', snapshotB),
    });
    write(repoPath, 'src/feature.ts', snapshotA);
    const restoredA = await buildArchitectureDelta({ repoPath });

    expect(restoredA).not.toBe(analyzedB);
    expect(restoredA.analysisId).not.toBe(analyzedB.analysisId);
    expect(restoredA.edges).toContainEqual(expect.objectContaining({
      from: 'src/feature.ts',
      to: 'src/core.ts',
      state: 'context',
    }));
  });

  it('rejects source symlinks before reading and reports them as safely omitted', async () => {
    const repoPath = createRepo();
    symlinkSync('/dev/zero', path.join(repoPath, 'src/stream.ts'));

    const response = await architectureDeltaRoute.GET(requestFor(repoPath));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: 'ready', truncated: true });
    expect(body.omittedPaths).toContain('src/stream.ts');
    expect(body.nodes).toContainEqual(expect.objectContaining({ path: 'src/stream.ts', state: 'added' }));
    expect(body.edges.some((edge: { from: string }) => edge.from === 'src/stream.ts')).toBe(false);
  });

  it('does not fabricate dependency removals when a changed source exceeds the read bound', async () => {
    const repoPath = createRepo();
    write(repoPath, 'src/feature.ts', `export const oversized = '${'x'.repeat(513 * 1024)}';\n`);

    const response = await architectureDeltaRoute.GET(requestFor(repoPath));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: 'ready', truncated: true });
    expect(body.omittedPaths).toContain('src/feature.ts');
    expect(body.edges).not.toContainEqual(expect.objectContaining({
      from: 'src/feature.ts',
      to: 'src/core.ts',
      state: 'removed',
    }));
  });

  it('bounds import processing without presenting a partially parsed source as evidence', async () => {
    const repoPath = createRepo();
    write(
      repoPath,
      'src/feature.ts',
      `${Array.from({ length: 2_001 }, (_, index) => `import './missing-${index}';`).join('\n')}\nexport const feature = 2;\n`,
    );

    const response = await architectureDeltaRoute.GET(requestFor(repoPath));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, status: 'ready', truncated: true });
    expect(body.edges).not.toContainEqual(expect.objectContaining({
      from: 'src/feature.ts',
      to: 'src/core.ts',
      state: 'removed',
    }));
  });

  it('uses each snapshot config and resolves current baseUrl imports without invented aliases', async () => {
    const repoPath = createRepo();
    write(repoPath, 'tsconfig.json', JSON.stringify({
      compilerOptions: {
        baseUrl: 'src',
      },
    }));
    write(repoPath, 'src/feature.ts', "import { nextCore } from 'next-core';\nexport const feature = nextCore;\n");
    write(repoPath, 'src/next-core.ts', 'export const nextCore = 2;\n');

    const response = await architectureDeltaRoute.GET(requestFor(repoPath));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'src/feature.ts', to: 'src/core.ts', state: 'removed' }),
      expect.objectContaining({ from: 'src/feature.ts', to: 'src/next-core.ts', state: 'added' }),
    ]));
  });

  it('shows dependencies from a deleted module as removed evidence', async () => {
    const repoPath = createRepo();
    rmSync(path.join(repoPath, 'src/feature.ts'));
    write(repoPath, 'src/entry.ts', 'export const entry = 1;\n');

    const response = await architectureDeltaRoute.GET(requestFor(repoPath));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.nodes).toContainEqual(expect.objectContaining({
      path: 'src/feature.ts',
      state: 'removed',
      focusPath: 'src/feature.ts',
    }));
    expect(body.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'src/feature.ts', to: 'src/core.ts', state: 'removed' }),
      expect.objectContaining({ from: 'src/entry.ts', to: 'src/feature.ts', state: 'removed' }),
    ]));
  });

  it('keeps rename focus on the reviewable destination while showing both topology sides', async () => {
    const repoPath = createRepo();
    git(repoPath, ['mv', 'src/feature.ts', 'src/renamed-feature.ts']);
    write(repoPath, 'src/entry.ts', "import { feature } from './renamed-feature';\nexport const entry = feature;\n");

    const response = await architectureDeltaRoute.GET(requestFor(repoPath));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/feature.ts', state: 'removed', focusPath: 'src/renamed-feature.ts' }),
      expect.objectContaining({ path: 'src/renamed-feature.ts', state: 'added', focusPath: 'src/renamed-feature.ts' }),
    ]));
    expect(body.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'src/feature.ts', to: 'src/core.ts', state: 'removed' }),
      expect.objectContaining({ from: 'src/renamed-feature.ts', to: 'src/core.ts', state: 'added' }),
    ]));
  });
});

it('maps immutable PR commits independently of the checkout and local edits (#5880)', async () => {
  const repoPath = createRepo();
  const base = git(repoPath, ['rev-parse', 'HEAD']);
  write(repoPath, 'src/core.ts', 'export const core = 2;\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', 'test: PR head']);
  const head = git(repoPath, ['rev-parse', 'HEAD']);
  const request = (expectedHead = head, expectedBase = base) => new NextRequest(
    `http://localhost:3001/api/review/architecture-delta?${new URLSearchParams({ workspace: repoPath, base: expectedBase, expectedHead })}`,
    { headers: { host: 'localhost:3001' } },
  );
  const response = await architectureDeltaRoute.GET(request());
  expect(response.status).toBe(200);
  const original = await response.json();
  expect(original).toMatchObject({ status: 'ready', summary: { changedModules: 1 },
    nodes: expect.arrayContaining([expect.objectContaining({ path: 'src/core.ts', state: 'changed' })]) });
  expect(await (await architectureDeltaRoute.GET(request(base))).json()).toMatchObject({ status: 'unsupported', summary: { changedModules: 0 } });
  expect(await (await architectureDeltaRoute.GET(request('f'.repeat(40)))).json()).toMatchObject({ status: 'unavailable', nodes: [] });
  write(repoPath, 'src/unrelated.ts', 'export const unrelated = false;\n');
  git(repoPath, ['checkout', '--detach', base]);
  expect(await (await architectureDeltaRoute.GET(request())).json()).toMatchObject({ status: 'ready', analysisId: original.analysisId, summary: { changedModules: 1 } });
  expect((await architectureDeltaRoute.GET(request('bad'))).status).toBe(400);
  expect((await architectureDeltaRoute.GET(request('', ''))).status).toBe(400);
});
