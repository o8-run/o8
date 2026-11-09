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
/**
 * Test-only sources: `*.test.ts(x)` / `*.spec.ts(x)`, or a path segment whose words include test(s),
 * testing, __tests__, fixture(s) or fake(s). Whole words only, so latest.ts or attestation.rs still count,
 * and `spec` alone stays product code (the spec surface).
 */
function isTestSource(file: string) {
  return /\.(test|spec)\.tsx?$/.test(file) || file.split(/[\\/]/)
    .some(part => part.split(/[._-]+/).some(word => /^(tests?|testing|__tests__|fixtures?|fakes?)$/.test(word)));
}

function checkInventory(directory: string) {
  const files = readdirSync(directory, { recursive: true }).map(String)
    .filter(file => file.endsWith('.rs') && !isTestSource(file));
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
  '/api/v1/audio/transcriptions', '/api/v1/chat/completions',
]);
const NEXT_ONLY_MCP_PATHS = new Set([
  '/api/agents/inbox', '/api/agents/message', '/api/agents/presence', '/api/broadcast/post',
  '/api/broadcast/tokens', '/api/browser/proxy', '/api/canvas/intent', '/api/cortex/sources',
  '/api/devices/agent', '/api/harness', '/api/leases',
  '/api/orchestrator/create-mission', '/api/orchestrator/dispatch',
  '/api/orchestrator/merge', '/api/orchestrator/propose-spec',
  '/api/orchestrator/reload', '/api/orchestrator/truth',
  '/api/task-artifacts',
  // Hidden until the scan read template literals whole: `/api/lanes/${encodeURIComponent(id)}/events`
  // was cut at the call and counted as the registered /api/lanes/[id].
  '/api/lanes/[id]/events', '/api/task-artifacts/[id]/actions',
]);
// Registered paths the MCP server calls with a method the native registration lacks, so that
// request still falls back to Next. Remove an entry when its method is registered.
const NEXT_ONLY_MCP_METHODS = new Set([
  'POST /api/panel/projects', 'POST /api/setup/mcp-servers', 'POST /api/visualizations',
  // Also matched the GET-only /api/visualizations/[id] path, so a path-only check counted it as served.
  'POST /api/visualizations/preview',
]);
const NEXT_ONLY_WS_PATHS = new Set([
  '/api/mobile/symon', '/api/mobile/symon/confirm', '/api/mobile/symon/text-turn', '/api/mobile/symon/tool',
  '/api/symon/machine/session', '/api/worktrees/conflicts',
  '/api/v2/proxy/llm', // o8 lane model calls: provider keys and spend, held for security
]);

function sourceFiles(directory: string, extension: string) {
  return readdirSync(directory, { recursive: true }).map(String)
    .filter(file => file.endsWith(extension) && !isTestSource(file)).map(file => join(directory, file));
}

/** The text between the call's parentheses, starting at its `(`; quotes and nesting are respected. */
function callArguments(source: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char) && --depth === 0) return source.slice(open + 1, index);
  }
  return source.slice(open + 1);
}

const HTTP_METHODS = /['"`](GET|HEAD|POST|PUT|PATCH|DELETE)['"`]/g;
/**
 * The methods a TS request sends when its first argument is the path: a `method:` option, or
 * buildNextUrl's required method argument; neither means GET. A `method:` holding no
 * literal (a variable) returns undefined, and the path is then checked without a method.
 */
function callMethods(source: string, pathAt: number): string[] | undefined {
  // Only calls that send the request; apiError and the like only name a path.
  const before = source.slice(0, pathAt).match(/\b(?:apiFetch|buildNextUrl|fetchNext\w*|nextFetch\w*)(?:<[^(]*>)?\s*\(\s*$/);
  if (!before) return undefined; // Not a request's first argument: a constant, list or comparison.
  const args = callArguments(source, pathAt - before[0].length + before[0].indexOf('('));
  const option = args.match(/\bmethod\s*:\s*([^,\n}]+)/);
  if (option) {
    const verbs = [...option[1].matchAll(HTTP_METHODS)].map(verb => verb[1]);
    return verbs.length > 0 ? verbs : undefined;
  }
  const trailing = args.match(/,\s*['"](GET|HEAD|POST|PUT|PATCH|DELETE)['"]\s*$/);
  return [trailing ? trailing[1] : 'GET'];
}

/** Checks one caller of the API port: listed paths stay unregistered and in use, all others are registered. */
function checkCaller(files: string[], pattern: RegExp, nextOnly: Set<string>,
  options: { methods?: boolean; nextOnlyMethods?: Set<string> } = {}) {
  const found = new Set<string>();
  const nextOnlyMethods = options.nextOnlyMethods ?? new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const literal = match[1] ?? match[2];
      // A placeholder after a slash is a path segment, including one cut off at
      // a space or call; after anything else it starts a query or suffix.
      let path = literal.split('?')[0].replace(/(\/)?\$\{[^}]*$/, (_, slash) => slash ? '/[id]' : '')
        .replace(/([^/$])(\$\{[^}]*\}|\{[^}]*\}).*$/, '$1').replace(/\$\{[^}]*\}|\{[^}]*\}/g, '[id]');
      if (path.endsWith('/')) path += '[id]'; // A prefix that a caller completes with an id.
      found.add(path);
      if (nextOnly.has(path)) continue;
      const concrete = path.replace(/\[\w+\]/g, 'fixture');
      expect(matchNativeHttpRoute(concrete), `${file}: ${path}`).toBeDefined();
      // A registered path still falls back to Next for a method it does not register (#5743).
      const methods = options.methods ? callMethods(source, match.index + match[0].indexOf(literal) - 1) : undefined;
      for (const method of methods ?? []) {
        found.add(`${method} ${path}`);
        if (nextOnlyMethods.has(`${method} ${path}`)) continue;
        expect(matchNativeHttpRoute(concrete, method), `${file}: ${method} ${path}`).toBeDefined();
      }
    }
  }
  for (const entry of nextOnlyMethods) {
    const [method, path] = entry.split(' ');
    expect(matchNativeHttpRoute(path.replace(/\[\w+\]/g, 'fixture'), method), `${entry} is registered`).toBeUndefined();
    expect(found.has(entry), `${entry} has no caller left`).toBe(true);
  }
  for (const path of nextOnly) {
    expect(matchNativeHttpRoute(path.replace(/\[\w+\]/g, 'fixture')), `${path} is registered`).toBeUndefined();
    expect(found.has(path), `${path} has no caller left`).toBe(true);
  }
}

/** WS-to-Next helper calls whose path argument is not a string literal, as `file: callee(firstArgument`. */
function dynamicNextCalls(files: string[]) {
  const calls: string[] = [];
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/(?<!function\s)\b(buildNextUrl|fetchNext(?!Page)\w*|nextFetch\w*)(?:<[^(]*>)?\(\s*([^\s`'")][^,)]*)/g)) {
      calls.push(`${file}: ${match[1]}(${match[2].trim()}`);
    }
  }
  return calls.sort();
}
// The only dynamic call is fetchNextJson's own request, whose callers pass literals and are scanned above.
const DYNAMIC_NEXT_CALLS = ['src/lib/ws-server/next-fetch.ts: buildNextUrl(pathname'];

it('counts the desktop shell, the MCP server and the WS process toward the Next-stopped default', () => {
  checkCaller(sourceFiles('src-tauri/src', '.rs'), /"[^"\s]*?(\/api\/[^"\s]+)"/g, NEXT_ONLY_SHELL_PATHS);
  // A template literal is read whole, so a placeholder holding a call (`${encodeURIComponent(id)}`) no longer cuts the path short.
  checkCaller(sourceFiles('src/lib/mcp', '.ts'), /`(\/api\/[^`]*)`|['"](\/api\/[\w\-./{}?=&]+)/g, NEXT_ONLY_MCP_PATHS,
    { methods: true, nextOnlyMethods: NEXT_ONLY_MCP_METHODS });
  // Every src module that calls the WS-to-Next helpers, not only the WS entry and its lib.
  const nextCallers = [...sourceFiles('src', '.ts'), ...sourceFiles('src', '.tsx')]
    .filter(file => /\b(?:buildNextUrl|fetchNext(?!Page)\w*)[<(]/.test(readFileSync(file, 'utf8')));
  expect(nextCallers).toEqual(expect.arrayContaining(['src/ws-server.ts', 'src/lib/broadcast/speaker.ts']));
  checkCaller(nextCallers,
    /(?:buildNextUrl|fetchNext\w*|nextFetch\w*)(?:<[^(]*>)?\(\s*[`'"](\/api\/[^`'"\s]+)[`'"]/g, NEXT_ONLY_WS_PATHS, { methods: true });
  // A WS-to-Next call whose path is not a literal escapes the scan, so each one is pinned here.
  expect(dynamicNextCalls(nextCallers)).toEqual(DYNAMIC_NEXT_CALLS);
  // The scorecard is derived, not pinned: each list above already fails when a path in it is
  // registered or loses its last caller, so a pinned total only made parallel ports collide.
  const remaining = new Set([...NEXT_ONLY_NATIVE_PATHS, ...NEXT_ONLY_SHELL_PATHS, ...NEXT_ONLY_MCP_PATHS, ...NEXT_ONLY_WS_PATHS]);
  console.info(`[o8d inventory] ${remaining.size} distinct API-port paths still need Next, `
    + `plus ${NEXT_ONLY_MCP_METHODS.size} methods on registered paths`);
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

it('checks TS callers by method, reads template paths whole and pins dynamic WS calls', () => {
  const directory = mkdtempSync(join(tmpdir(), 'o8-api-caller-methods-'));
  const mcp = /`(\/api\/[^`]*)`|['"](\/api\/[\w\-./{}?=&]+)/g;
  const ws = /(?:buildNextUrl|fetchNext\w*|nextFetch\w*)(?:<[^(]*>)?\(\s*[`'"](\/api\/[^`'"\s]+)[`'"]/g;
  const scan = (name: string, source: string, pattern: RegExp, options: Parameters<typeof checkCaller>[3] = { methods: true }) => {
    writeFileSync(join(directory, name), source);
    return () => checkCaller([join(directory, name)], pattern, new Set(), options);
  };
  try {
    // /api/panel/status is registered for GET only.
    expect(scan('get.ts', "await apiFetch('/api/panel/status');", mcp)).not.toThrow();
    expect(scan('post.ts', "await apiFetch('/api/panel/status', { method: 'POST' });", mcp)).toThrow('POST /api/panel/status');
    expect(scan('url.ts', "buildNextUrl('/api/panel/status', undefined, 'POST');", ws)).toThrow('POST /api/panel/status');
    expect(scan('json.ts', "fetchNextJson<{ ok: boolean }>('/api/panel/status', { method: 'DELETE' });", ws)).toThrow('DELETE /api/panel/status');
    // A method held in a variable is checked by path only; a path that only names an error is not a request.
    expect(scan('variable.ts', "await apiFetch('/api/panel/status', { method: verb });", mcp)).not.toThrow();
    expect(scan('error.ts', "return apiError('/api/panel/status', 500, '');", mcp)).not.toThrow();
    // A listed method stays counted until it is registered, and only while a caller sends it.
    const listed = { methods: true, nextOnlyMethods: new Set(['POST /api/panel/status']) };
    expect(scan('listed.ts', "await apiFetch('/api/panel/status', { method: 'POST' });", mcp, listed)).not.toThrow();
    expect(scan('unlisted.ts', "await apiFetch('/api/panel/status');", mcp, listed)).toThrow('POST /api/panel/status has no caller left');
    expect(scan('registered.ts', "await apiFetch('/api/panel/status');", mcp,
      { methods: true, nextOnlyMethods: new Set(['GET /api/panel/status']) })).toThrow('GET /api/panel/status is registered');
    // A placeholder holding a call no longer cuts the path at the registered /api/lanes/[id].
    expect(scan('template.ts', 'await apiFetch(`/api/lanes/${encodeURIComponent(id)}/fixture-unknown${qs}`);', mcp))
      .toThrow('/api/lanes/[id]/fixture-unknown');
    // Only a literal path can be scanned, so every other WS-to-Next call is listed.
    writeFileSync(join(directory, 'dynamic.ts'),
      'export async function fetchNextJson<T>(pathname: string) {}\nfetchNextJson(path, {});\nbuildNextUrl(`/api/x`, undefined, \'GET\');');
    expect(dynamicNextCalls([join(directory, 'dynamic.ts')])).toEqual([`${join(directory, 'dynamic.ts')}: fetchNextJson(path`]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('skips test sources by whole word, not by substring', () => {
  for (const file of ['a/route.test.ts', 'b/view.spec.tsx', 'tests/x.ts', 'c/fixtures/y.rs', 'd/__tests__/z.ts',
    'e/fake.rs', 'f/testing/h.ts', 'g/client_test.rs']) expect(isTestSource(file), file).toBe(true);
  for (const file of ['lib/db/latest-schema-migrations.ts', 'files_panel/spec_view.rs', 'lib/attestation.ts',
    'operator-handlers/spec.ts', 'lib/contest.ts']) expect(isTestSource(file), file).toBe(false);
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
