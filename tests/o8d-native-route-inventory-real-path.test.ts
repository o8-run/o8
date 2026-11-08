import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { nativeSurfaceRoutes, matchNativeHttpRoute } from '@/lib/ws-server/native-http-registry';
import { viewerHttpRoutes } from '@/lib/viewers/http-routes';

// Native paths that still need Next (#5243). Remove a path when it is registered.
const NEXT_ONLY_NATIVE_PATHS = new Set([
  // Existing native inventory drift, outside the A1 and A2 slices. No methods added.
  '/api/panel/connect/attach',
  '/api/panel/mobile-pairing',
  '/api/mobile/devices',
  '/api/mobile/devices/revoke',
  '/api/setup/mcp-config',
  '/api/setup/claude-desktop',
  '/api/setup/external-client',
  '/api/panel/connect',
  '/api/mcp',
  '/api/panel/ssh-machines',
  '/api/runtime/acp-connection',
  '/api/runtime/acp-registry/prepare',
  '/api/runtime/provider-instances',
  '/api/setup/detect', // CLI probes, credential reads and CLI symlink repair.
  '/api/orchestrator/backend-models',
  '/api/orchestrator/comparison-diff', // GET has a write path; held for review.
  '/api/orchestrator/pull-request-context',
  '/api/panel/account/avatar',
  '/api/panel/browse-folder',
  '/api/panel/devices',
  '/api/panel/update/apply',
  '/api/repo-spec/asset',
  '/api/tasks/[id]/preview',
  '/api/tts',
  '/api/worktrees/retention-usage', // resolveManagedWorktreeStorageTarget creates the default root.
  '/api/review/commit', // Review's commit button: a POST, outside the Phase A reads.
  '/api/review/push', // Review's push button: a POST, outside the Phase A reads.
]);
function checkInventory(directory: string) {
  const files = readdirSync(directory, { recursive: true }).map(String)
    .filter(file => file.endsWith('.rs') && !file.includes('test') && !file.endsWith('fake.rs'));
  const paths = new Set([...Object.values(nativeSurfaceRoutes).flat(), ...viewerHttpRoutes].map(route => route.path));
  const hasRoute = (path: string) => [...paths].some(known =>
    known.replace(/\[\w+\]/g, '[]') === path.replace(/\[\w+\]/g, '[]'))
    // Checkpoint producers share the native transport but have no surface owner.
    || matchNativeHttpRoute(path.replace(/\[\w+\]/g, 'fixture')) !== undefined;
  for (const path of NEXT_ONLY_NATIVE_PATHS) expect(hasRoute(path), `${path} is registered`).toBe(false);
  for (const file of files) {
    const source = readFileSync(join(directory, file), 'utf8');
    for (const match of source.matchAll(/"(\/api\/[^"\s]+)"/g)) {
      if (match[1].includes('{endpoint}')) {
        const endpoints = [...source.matchAll(/\("(\w+)", "\w+", "\w+", \d+\)/g)].map(row => row[1]);
        expect(endpoints.length).toBeGreaterThan(0);
        for (const endpoint of endpoints) expect(hasRoute(match[1].replace('{endpoint}', endpoint)), `${file}: ${endpoint}`).toBe(true);
        continue;
      }
      const path = match[1].split('?')[0].replace(/\{[^}]*\}/g, '[id]');
      if (path.endsWith('/')) continue; // Prefix used for error policy or route construction.
      if (NEXT_ONLY_NATIVE_PATHS.has(path)) continue;
      expect(hasRoute(path), `${file}: ${path}`).toBe(true);
    }
  }
}

it('covers native client routes with their production registration owners', () => {
  checkInventory('native/o8-next/src');
});

it('rejects an unknown route discovered in a native source file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'o8-native-route-inventory-'));
  try {
    writeFileSync(join(directory, 'surface.rs'), 'const ROUTE: &str = "/api/native-fixture-unknown-route";');
    expect(() => checkInventory(directory)).toThrow('/api/native-fixture-unknown-route');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('keeps viewer registrations out of Next-only exceptions and refuses unknown routes', () => {
  for (const route of viewerHttpRoutes) {
    expect(NEXT_ONLY_NATIVE_PATHS.has(route.path), route.path).toBe(false);
    expect(matchNativeHttpRoute(route.path.replace(/\[\w+\]/g, 'fixture'), 'GET'), route.path).toBeDefined();
  }
  expect(matchNativeHttpRoute('/api/native-fixture-unknown-route', 'GET')).toBeUndefined();
});
