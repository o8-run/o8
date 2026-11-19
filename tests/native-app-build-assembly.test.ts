import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyServerTree, NEXT_PAYLOAD } from '../scripts/native-app-build.mjs';

/** A small `out/server`: the Next payload beside the WS and runtime files a Next-off launcher runs. */
const FIXTURE = [
  'server.js',
  'server-impl.js',
  'ws-server.mjs',
  'server-chunk-a1b2.mjs',
  'ws-server-impl.mjs',
  'package.json',
  '.next/BUILD_ID',
  '.next/server/app/page.js',
  '.next/static/chunks/main.js',
  'node_modules/next/package.json',
  'node_modules/next/dist/server/next.js',
  'node_modules/@next/env/package.json',
  'node_modules/next-auth/package.json',
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'node_modules/node-pty/package.json',
  'node_modules/@nextui/theme/package.json',
  'public/icon.png',
  'pi-sdk/index.mjs',
];

const NEXT_FILES = FIXTURE.filter((file) => NEXT_PAYLOAD.some((path) => file === path || file.startsWith(`${path}/`)));

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-native-assembly-'));
  roots.push(root);
  const source = join(root, 'out/server');
  for (const file of FIXTURE) {
    mkdirSync(dirname(join(source, file)), { recursive: true });
    writeFileSync(join(source, file), file);
  }
  return { source, destination: join(root, 'o8.app/Contents/Resources/server') };
}

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('copyServerTree', () => {
  it('leaves the Next payload out of a Next-off candidate and keeps the source whole', () => {
    const { source, destination } = fixture();
    copyServerTree(source, destination, { candidate: true, nextOff: true });

    expect(NEXT_FILES).toHaveLength(6);
    for (const path of NEXT_PAYLOAD) expect(existsSync(join(destination, path)), path).toBe(false);
    expect(files(destination)).toEqual(FIXTURE.filter((file) => !NEXT_FILES.includes(file)).sort());
    // Launcher discovery (`crates/o8-launcher/src/bundle.rs`) still finds server.js.
    expect(existsSync(join(destination, 'server.js'))).toBe(true);
    // Names that only start like the payload stay.
    expect(existsSync(join(destination, 'node_modules/next-auth/package.json'))).toBe(true);
    expect(existsSync(join(destination, 'node_modules/@nextui/theme/package.json'))).toBe(true);
    expect(files(source)).toEqual([...FIXTURE].sort());
  });

  it.each([
    ['an ordinary build', undefined],
    ['a release build', { candidate: false, nextOff: false }],
    ['a front-door candidate', { candidate: true, nextOff: false }],
    ['Next off without --candidate', { candidate: false, nextOff: true }],
  ])('copies everything for %s', (_, mode) => {
    const { source, destination } = fixture();
    copyServerTree(source, destination, mode);
    expect(files(destination)).toEqual([...FIXTURE].sort());
  });
});
