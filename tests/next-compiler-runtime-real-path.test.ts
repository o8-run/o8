import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const compiler = vi.hoisted(() => ({ loads: 0 }));
beforeEach(() => {
  vi.doMock('typescript', async () => {
    compiler.loads += 1;
    return vi.importActual('typescript');
  });
});
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-compiler-runtime-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    'commit', '-qm', 'baseline', '--allow-empty']);
  mkdirSync(join(root, 'src'));
  return root;
}

afterEach(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetModules();
  compiler.loads = 0;
});

it('loads the compiler only when Review analyzes imports and JSONC aliases', async () => {
  const { GET } = await import('@/app/api/review/architecture-delta/route');
  expect(compiler.loads, 'importing Review must not load the compiler').toBe(0);
  const root = fixture();
  writeFileSync(join(root, 'tsconfig.json'), '{ // fixture alias\n "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }');
  writeFileSync(join(root, 'src/core.ts'), 'export const core = 1;\n');
  writeFileSync(join(root, 'src/entry.ts'), "import { core } from '@/core';\nexport const value = core;\n");
  const response = await GET(new NextRequest(`http://localhost/api/review/architecture-delta?workspace=${encodeURIComponent(root)}`, {
    headers: { host: 'localhost' },
  }));
  expect(response.status).toBe(200);
  expect((await response.json()).edges).toContainEqual(expect.objectContaining({
    from: 'src/entry.ts', to: 'src/core.ts', state: 'added',
  }));
  expect(compiler.loads).toBe(1);
});

it('loads the compiler on a skeleton scan and persists exact TS and TSX bodies', async () => {
  const { scanRepo, getChunksForFile } = await import('@/lib/skeleton');
  expect(compiler.loads).toBe(0);
  const root = fixture();
  const sources = {
    'core.ts': 'export function compute(value: number): number {\n  const doubled = value * 2;\n  return doubled + 10;\n}\n',
    'View.tsx': 'export function View({ title }: { title: string }) {\n  return <section><h1>{title}</h1><p>Fixture content</p></section>;\n}\n',
  };
  for (const [name, content] of Object.entries(sources)) writeFileSync(join(root, 'src', name), content);
  await scanRepo({ repoPath: root });
  for (const [name, content] of Object.entries(sources)) {
    const chunks = getChunksForFile(root, `src/${name}`);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].body).toBe(content.trimEnd());
    expect(content.slice(chunks[0].startPos, chunks[0].endPos)).toBe(chunks[0].body);
  }
  expect(compiler.loads).toBe(1);
});
