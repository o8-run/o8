import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { prunePackagedBuildInputs } from '../scripts/lib/packaged-build-inputs.mjs';
import { RUNTIME_INPUT_FILES, stageRuntimeInputs } from './helpers/packaged-runtime-inputs';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-packaged-inputs-'));
  roots.push(root);
  const server = join(root, 'server');
  const put = (path: string) => {
    mkdirSync(dirname(join(server, path)), { recursive: true });
    writeFileSync(join(server, path), path);
  };
  const runtime = ['server.js', '.next/server/app/api/example/route.js',
    '.next/server/app/api/example/route_client-reference-manifest.js', '.next/required-server-files.json',
    'node_modules/typescript/lib/typescript.js', 'node_modules/@shikijs/langs/dist/tsx.mjs',
    'node_modules/better-sqlite3/prebuilds/node-v127/darwin-x64/better_sqlite3.node',
    'node_modules/better-sqlite3/prebuilds/node-v137/darwin-arm64/better_sqlite3.node',
    'node_modules/better-sqlite3/lib/database.js', 'node_modules/better-sqlite3/LICENSE',
    'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
    'node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js'];
  const buildOnly = ['.next/server/app/api/example/route.js.nft.json', '.next/types/validator.ts',
    'node_modules/better-sqlite3/deps/sqlite3/sqlite3.c', 'node_modules/better-sqlite3/binding.gyp',
    'node_modules/node-pty/src/unix/pty.cc', 'node_modules/node-pty/third_party/conpty/OpenConsole.exe'];
  for (const path of [...runtime, ...buildOnly]) put(path);
  stageRuntimeInputs(server);
  return { root, server, put, runtime, buildOnly };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('packaged build inputs', () => {
  it('removes only build inputs after export, retains runtime files and is repeatable', () => {
    const f = fixture();
    const result = prunePackagedBuildInputs(f.server, 'darwin');
    expect(result.removedFiles).toBe(f.buildOnly.length);
    expect(result.removedBytes).toBeGreaterThan(0);
    for (const path of f.buildOnly) expect(existsSync(join(f.server, path)), path).toBe(false);
    for (const path of [...f.runtime, ...Object.keys(RUNTIME_INPUT_FILES)]) {
      expect(readFileSync(join(f.server, path), 'utf8')).toBe(RUNTIME_INPUT_FILES[path] ?? path);
    }
    expect(prunePackagedBuildInputs(f.server, 'darwin').removedFiles).toBe(0);
  });

  it('keeps native build sources and Windows helpers outside a Mac export', () => {
    const f = fixture();
    prunePackagedBuildInputs(f.server, 'win32');
    for (const path of f.buildOnly.filter((path) => path.startsWith('node_modules/'))) {
      expect(readFileSync(join(f.server, path), 'utf8')).toBe(path);
    }
  });

  it.each(['.next', 'node_modules/node-pty/third_party'])('rejects linked pruning ancestor %s before deleting anything', (ancestor) => {
    const f = fixture();
    const outside = ancestor === '.next' ? join(f.root, 'outside') : join(f.server, 'keep');
    mkdirSync(join(outside, 'types'), { recursive: true });
    mkdirSync(join(outside, 'conpty'), { recursive: true });
    writeFileSync(join(outside, 'types', 'keep.ts'), 'keep');
    writeFileSync(join(outside, 'conpty', 'keep.exe'), 'keep');
    rmSync(join(f.server, ancestor), { recursive: true });
    symlinkSync(outside, join(f.server, ancestor));
    expect(() => prunePackagedBuildInputs(f.server, 'darwin')).toThrow();
    expect(readFileSync(join(outside, 'types', 'keep.ts'), 'utf8')).toBe('keep');
    expect(readFileSync(join(outside, 'conpty', 'keep.exe'), 'utf8')).toBe('keep');
    expect(existsSync(join(f.server, 'node_modules/better-sqlite3/binding.gyp'))).toBe(true);
  });

  it('rejects escaping dependency links before removing any build inputs', () => {
    const f = fixture();
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'source.c'), 'keep');
    symlinkSync(outside, join(f.server, 'node_modules', 'escape'));
    expect(() => prunePackagedBuildInputs(f.server, 'darwin')).toThrow('escapes');
    expect(readFileSync(join(outside, 'source.c'), 'utf8')).toBe('keep');
    for (const path of f.buildOnly) expect(existsSync(join(f.server, path))).toBe(true);
  });
});
