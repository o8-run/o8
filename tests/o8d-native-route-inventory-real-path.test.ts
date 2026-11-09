import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { nativeSurfaceRoutes, matchNativeHttpRoute } from '@/lib/ws-server/native-http-registry';
import { viewerHttpRoutes } from '@/lib/viewers/http-routes';

// Native paths that still need Next (#5243). Remove a path when it is registered.
const NEXT_ONLY_NATIVE_PATHS = new Set([
  // Existing native inventory drift, outside the A1 and A2 slices. No methods added.
  '/api/panel/ssh-machines',
  '/api/runtime/acp-connection',
  '/api/runtime/acp-registry/prepare',
  '/api/orchestrator/comparison-diff', // GET has a write path; held for review.
  '/api/panel/devices',
  '/api/tasks/[id]/preview',
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

// With Next stopped, the WS listener serves the API port, so every caller of
// that port counts toward the Next-stopped default, not only o8 next. Remove a
// path when it is registered; the default switch waits for every list to be empty.
const NEXT_ONLY_SHELL_PATHS = new Set([
  '/api/canvas/intent',
  '/api/panel/cloud-jobs/drain',
  '/api/v1/audio/transcriptions', '/api/v1/chat/completions',
]);
const NEXT_ONLY_MCP_PATHS = new Set([
  '/api/agents/inbox', '/api/agents/message', '/api/agents/presence', '/api/broadcast/post',
  '/api/broadcast/tokens', '/api/browser/proxy', '/api/canvas/intent', '/api/cortex/sources',
  '/api/devices/agent', '/api/harness', '/api/leases',
  '/api/orchestrator/create-mission', '/api/orchestrator/digest', '/api/orchestrator/dispatch',
  '/api/orchestrator/merge', '/api/orchestrator/propose-spec',
  '/api/orchestrator/reload', '/api/orchestrator/truth',
  '/api/panel/targets',
  '/api/task-artifacts',
]);
const NEXT_ONLY_WS_PATHS = new Set([
  '/api/mobile/symon', '/api/mobile/symon/confirm', '/api/mobile/symon/text-turn', '/api/mobile/symon/tool',
  '/api/symon/machine/session', '/api/worktrees/conflicts',
  '/api/broadcast/commentary', // Symon's commentary reader
  '/api/v2/proxy/llm', // o8 lane model calls: provider keys and spend, held for security
]);

function sourceFiles(directory: string, extension: string) {
  return readdirSync(directory, { recursive: true }).map(String)
    .filter(file => file.endsWith(extension) && !/test|fixture|fake/.test(file)).map(file => join(directory, file));
}

/** Checks one caller of the API port: listed paths stay unregistered and in use, all others are registered. */
function checkCaller(files: string[], pattern: RegExp, nextOnly: Set<string>) {
  const found = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      // A placeholder after a slash is a path segment, including one cut off at
      // a space or call; after anything else it starts a query or suffix.
      let path = match[1].split('?')[0].replace(/(\/)?\$\{[^}]*$/, (_, slash) => slash ? '/[id]' : '')
        .replace(/([^/])(\$\{[^}]*\}|\{[^}]*\}).*$/, '$1').replace(/\$\{[^}]*\}|\{[^}]*\}/g, '[id]');
      if (path.endsWith('/')) path += '[id]'; // A prefix that a caller completes with an id.
      found.add(path);
      if (nextOnly.has(path)) continue;
      expect(matchNativeHttpRoute(path.replace(/\[\w+\]/g, 'fixture')), `${file}: ${path}`).toBeDefined();
    }
  }
  for (const path of nextOnly) {
    expect(matchNativeHttpRoute(path.replace(/\[\w+\]/g, 'fixture')), `${path} is registered`).toBeUndefined();
    expect(found.has(path), `${path} has no caller left`).toBe(true);
  }
}

it('counts the desktop shell, the MCP server and the WS process toward the Next-stopped default', () => {
  checkCaller(sourceFiles('src-tauri/src', '.rs'), /"[^"\s]*?(\/api\/[^"\s]+)"/g, NEXT_ONLY_SHELL_PATHS);
  checkCaller(sourceFiles('src/lib/mcp', '.ts'), /[`'"](\/api\/[\w\-./${}?=&]+)/g, NEXT_ONLY_MCP_PATHS);
  // Every src module that calls the WS-to-Next helpers, not only the WS entry and its lib.
  const nextCallers = [...sourceFiles('src', '.ts'), ...sourceFiles('src', '.tsx')]
    .filter(file => /\b(?:buildNextUrl|fetchNext(?!Page)\w*)[<(]/.test(readFileSync(file, 'utf8')));
  expect(nextCallers).toEqual(expect.arrayContaining(['src/ws-server.ts', 'src/lib/broadcast/speaker.ts']));
  checkCaller(nextCallers,
    /(?:buildNextUrl|fetchNext\w*|nextFetch\w*)(?:<[^(]*>)?\(\s*[`'"](\/api\/[^`'"\s]+)[`'"]/g, NEXT_ONLY_WS_PATHS);
  // The scorecard is derived, not pinned: each list above already fails when a path in it is
  // registered or loses its last caller, so a pinned total only made parallel ports collide.
  const remaining = new Set([...NEXT_ONLY_NATIVE_PATHS, ...NEXT_ONLY_SHELL_PATHS, ...NEXT_ONLY_MCP_PATHS, ...NEXT_ONLY_WS_PATHS]);
  console.info(`[o8d inventory] ${remaining.size} distinct API-port paths still need Next`);
});

it('rejects an unknown route discovered in a shell or MCP source file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'o8-api-caller-inventory-'));
  try {
    writeFileSync(join(directory, 'bridge.rs'), 'let url = format!("{}/api/caller-fixture-unknown?x=1", base);');
    expect(() => checkCaller(sourceFiles(directory, '.rs'), /"[^"\s]*?(\/api\/[^"\s]+)"/g, new Set()))
      .toThrow('/api/caller-fixture-unknown');
    expect(() => checkCaller([], /"(\/api\/[^"]+)"/g, new Set(['/api/caller-fixture-gone'])))
      .toThrow('/api/caller-fixture-gone has no caller left');
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
