import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, expect, it, vi } from 'vitest';

// Stand-in choosers on PATH: the test never opens a real dialog. Each prints
// the picked folder with the chooser's protocol newline.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-browse-folder-')));
const bin = join(root, 'bin');
const picked = join(root, 'Picked Project');
mkdirSync(bin);
mkdirSync(picked);
for (const chooser of ['osascript', 'zenity']) {
  writeFileSync(join(bin, chooser), `#!/bin/sh\nprintf '%s/\\n' ${JSON.stringify(picked)}\n`);
  chmodSync(join(bin, chooser), 0o755);
}
vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
vi.stubEnv('DISPLAY', ':0');
const dataDir = process.env.CORTEX_IDE_DATA_DIR!;

const { POST } = await import('@/app/api/panel/browse-folder/route');
const { matchNativeHttpRoute, nativeSurfaceRoutes } = await import('@/lib/ws-server/native-http-registry');
const { getSqlite } = await import('@/lib/db');

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it('registers the production folder picker POST for the native project target', async () => {
  const route = nativeSurfaceRoutes.session.find(route => route.path === '/api/panel/browse-folder');
  expect(route, 'session browse-folder registration').toBeDefined();
  expect(route!.methods).toEqual(['POST']);
  expect(await route!.load()).toMatchObject({ POST });
  for (const method of ['GET', 'PATCH', 'PUT', 'DELETE']) {
    expect(matchNativeHttpRoute('/api/panel/browse-folder', method)).toBeUndefined();
  }
});

it('opens the chooser while a provider key write holds the store lock', async () => {
  getSqlite(); // Startup opens the database; the picker must not add to the data directory.
  // On the locked boundary the chooser's launch would wait out the lock's 1 s
  // timeout, fail, and the route would answer 503 instead of the folder.
  const holder = new Database(join(dataDir, '.provider-keys.lock'));
  const files = readdirSync(dataDir).sort();
  holder.exec('BEGIN EXCLUSIVE');
  let response: Response;
  try {
    response = await POST();
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ path: picked });
  expect(readdirSync(dataDir).sort()).toEqual(files);
});
