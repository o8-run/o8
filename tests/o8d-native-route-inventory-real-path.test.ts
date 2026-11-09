import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { nativeSurfaceRoutes, matchNativeHttpRoute } from '@/lib/ws-server/native-http-registry';
import { viewerHttpRoutes } from '@/lib/viewers/http-routes';
import {
  NEXT_ONLY_CLI_METHODS, NEXT_ONLY_CLI_PATHS, NEXT_ONLY_MCP_METHODS, NEXT_ONLY_MCP_PATHS, NEXT_ONLY_NATIVE_METHODS,
  NEXT_ONLY_NATIVE_PATHS, NEXT_ONLY_SHELL_METHODS, NEXT_ONLY_SHELL_PATHS, NEXT_ONLY_TABLES, NEXT_ONLY_WS_PATHS,
  RETIRED_WITH_REASON, nextOnlyRoutes, type NextOnlyTable,
} from './fixtures/o8d-next-only-routes';

/**
 * Test-only sources: `*.test.ts(x)` / `*.spec.ts(x)`, or a path segment whose words include test(s),
 * testing, __tests__, fixture(s) or fake(s). Whole words only, so latest.ts or attestation.rs still count,
 * and `spec` alone stays product code (the spec surface).
 */
function isTestSource(file: string) {
  return /\.(test|spec)\.tsx?$/.test(file) || file.split(/[\\/]/)
    .some(part => part.split(/[._-]+/).some(word => /^(tests?|testing|__tests__|fixtures?|fakes?)$/.test(word)));
}

const concrete = (path: string) => path.replace(/\[\w+\]/g, 'fixture');
const VERBS = '(GET|HEAD|POST|PUT|PATCH|DELETE)';
type MethodReader = (source: string, quoteAt: number) => string[] | undefined;

/** The unmatched `(` that opens the Rust call holding `at`, skipping string literals; -1 when none is near. */
function enclosingOpen(source: string, at: number): number {
  let depth = 0;
  for (let index = at - 1; index >= Math.max(0, at - 800); index -= 1) {
    const char = source[index];
    if (char === '"') {
      index -= 1;
      while (index > 0 && !(source[index] === '"' && source[index - 1] !== '\\')) index -= 1;
    } else if (char === ')') depth += 1;
    else if (char === '(' && depth-- === 0) return index;
  }
  return -1;
}

/**
 * The method a Rust request sends for the path literal whose opening quote is at `quoteAt`:
 * a method argument before the path (`json_request(client, "POST", path)`, `("PATCH", format!(…))`),
 * a verb in the callee's name (`client.get`, `o8_http::post_json`, `pr_post`), or the
 * `request("M", &url)` that sends a `let url = client.url(path)`. Undefined when the source does not
 * say (a method held in a variable, or a literal that is not a request); the path is then checked alone.
 */
function rustMethod(source: string, quoteAt: number): string | undefined {
  let open = enclosingOpen(source, quoteAt);
  // format! only builds the path; the call around it sends the request.
  while (open > 0 && /format!\s*$/.test(source.slice(Math.max(0, open - 20), open))) open = enclosingOpen(source, open);
  if (open < 0) return undefined;
  const literals = [...source.slice(open + 1, quoteAt).matchAll(new RegExp(`"${VERBS}"`, 'g'))];
  if (literals.length > 0) return literals.at(-1)![1];
  const callee = source.slice(Math.max(0, open - 80), open).match(/([A-Za-z_]\w*)\s*(?:::<[^()]*>)?\s*$/)?.[1];
  if (!callee) return undefined;
  const verb = callee.match(/(?:^|_)(get|head|post|put|patch|delete)(?:_|$)/i);
  if (verb) return verb[1].toUpperCase();
  if (callee !== 'url') return undefined;
  const statement = source.slice(Math.max(0, open - 200), open).split(/[;{}]/).at(-1) ?? '';
  const binding = statement.match(/\blet\s+(?:mut\s+)?(\w+)\s*(?::[^=]+)?=/)?.[1];
  if (!binding) return undefined;
  const sent = source.slice(open, open + 2_000)
    .match(new RegExp(`\\brequest\\(\\s*(?:"${VERBS}"|\\w+)\\s*,\\s*&?${binding}\\b`));
  return sent?.[1];
}
const rustMethods: MethodReader = (source, quoteAt) => {
  const method = rustMethod(source, quoteAt);
  return method ? [method] : undefined;
};

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

const HTTP_METHODS = new RegExp(`['"\`]${VERBS}['"\`]`, 'g');
const TYPE_ARGUMENTS = '(?:<(?:[^()<>]|<(?:[^()<>]|<[^()<>]*>)*>)*>)?';
const REQUEST_CALL = new RegExp(String.raw`\b(apiFetch|buildNextUrl|fetchNext\w*|nextFetch\w*|apiFetchCorrelatedMutation|fetchCorrelatedPacketMutation)`
  + TYPE_ARGUMENTS + String.raw`\s*\(\s*(\w+(?:\(\))?\s*,\s*)?$`);
/**
 * The methods a TS request sends when the path is its first argument, or its second after the CLI's
 * config: a `method:` option; buildNextUrl's method argument; POST for the correlated-mutation helpers
 * and for a CLI apiFetch with a body; GET otherwise. A `method:` holding no literal (a variable)
 * returns undefined, and the path is then checked without a method.
 */
const callMethods: MethodReader = (source, quoteAt) => {
  // Only calls that send the request; apiError and the like only name a path.
  const before = source.slice(Math.max(0, quoteAt - 600), quoteAt).match(REQUEST_CALL);
  if (!before) return undefined; // Not a request's path argument: a constant, list or comparison.
  if (/CorrelatedMutation|CorrelatedPacketMutation/.test(before[1])) return ['POST'];
  const args = callArguments(source, quoteAt - before[0].length + before[0].indexOf('(', before[1].length));
  // `{ method }` shorthand holds a variable, so the method is unknown.
  if (/[{,]\s*method\s*[,}]/.test(args)) return undefined;
  const options = [...args.matchAll(/\bmethod\s*:\s*([^,\n}]+)/g)];
  if (options.length > 0) {
    const verbs = options.flatMap(option => [...option[1].matchAll(HTTP_METHODS)].map(verb => verb[1]));
    if (verbs.length === 0) return undefined;
    // Options picked by a condition (`x ? {} : { method: 'POST' }`): a branch with no method sends the default.
    const picked = args.match(/[`'"]\s*,\s*[\w.!()\s=&|'"]+\?\s*(\{[^{}]*\})\s*:\s*(\{[^{}]*\})/);
    if (picked && !picked.slice(1).every(branch => /\bmethod\s*:/.test(branch))) verbs.push('GET');
    return [...new Set(verbs)];
  }
  const trailing = args.match(new RegExp(`,\\s*['"]${VERBS}['"]\\s*$`));
  if (trailing) return [trailing[1]];
  // The CLI's apiFetch(cfg, path, { body }) sends POST when no method is given.
  if (before[2] && before[1] === 'apiFetch' && /\bbody\b\s*[:,}]/.test(args)) return ['POST'];
  return ['GET'];
};

const keys = (table: NextOnlyTable) => new Set(Object.keys(table));
const retired = new Set(Object.keys(RETIRED_WITH_REASON));

function checkInventory(directory: string) {
  const files = readdirSync(directory, { recursive: true }).map(String)
    .filter(file => file.endsWith('.rs') && !isTestSource(file));
  const paths = new Set([...Object.values(nativeSurfaceRoutes).flat(), ...viewerHttpRoutes].map(route => route.path));
  const hasRoute = (path: string) => [...paths].some(known =>
    known.replace(/\[\w+\]/g, '[]') === path.replace(/\[\w+\]/g, '[]'))
    // Checkpoint producers share the native transport but have no surface owner.
    || matchNativeHttpRoute(concrete(path)) !== undefined;
  const nextOnly = keys(NEXT_ONLY_NATIVE_PATHS);
  const nextOnlyMethods = keys(NEXT_ONLY_NATIVE_METHODS);
  const problems: string[] = [];
  const found = new Set<string>();
  for (const path of nextOnly) if (hasRoute(path)) problems.push(`${path} is registered`);
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
      if (nextOnly.has(path)) continue;
      if (!hasRoute(path)) { problems.push(`${file}: ${path}`); continue; }
      // A registered path still falls back to Next for a method it does not register.
      const method = rustMethod(source, match.index);
      if (!method) continue;
      found.add(`${method} ${path}`);
      if (nextOnlyMethods.has(`${method} ${path}`)) continue;
      if (!matchNativeHttpRoute(concrete(path), method)) problems.push(`${file}: ${method} ${path}`);
    }
  }
  for (const entry of nextOnlyMethods) {
    const [method, path] = entry.split(' ');
    if (matchNativeHttpRoute(concrete(path), method)) problems.push(`${entry} is registered`);
    if (!found.has(entry)) problems.push(`${entry} has no caller left`);
  }
  if (problems.length > 0) throw new Error(`native client routes:\n${problems.join('\n')}`);
}

it('covers native client routes with their production registration owners', () => {
  checkInventory('native/o8-next/src');
});

function sourceFiles(directory: string, extension: string) {
  return readdirSync(directory, { recursive: true }).map(String)
    .filter(file => file.endsWith(extension) && !isTestSource(file)).map(file => join(directory, file));
}

interface CallerScan { files: string[]; pattern: RegExp; methods?: MethodReader }

/**
 * Checks the callers of one API-port client: listed paths and methods stay unregistered and in use,
 * all others are registered. A retired path is skipped here; the scorecard holds it to the same rule.
 * Returns every path and `METHOD path` the scans found.
 */
function checkCallers(scans: CallerScan[], nextOnly: Set<string>, nextOnlyMethods = new Set<string>()) {
  const found = new Set<string>();
  const problems: string[] = [];
  for (const { files, pattern, methods } of scans) {
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(pattern)) {
        const literal = match[1] ?? match[2];
        // A path named in a comment is documentation, not a request.
        if (/^\s*(?:\/\/|\/?\*)/.test(source.slice(source.lastIndexOf('\n', match.index) + 1, match.index))) continue;
        let quoteAt = match.index + match[0].indexOf(literal) - 1;
        while (quoteAt > match.index && !'"\'`'.includes(source[quoteAt])) quoteAt -= 1;
        // An absolute URL on another host (a provider's /api/v1/…) is not the API port.
        if (/^[a-z]+:\/\/(?!127\.0\.0\.1|localhost|\[::1\]|[{$])/i.test(source.slice(quoteAt + 1, match.index + match[0].indexOf(literal)))) continue;
        // A placeholder after a slash is a path segment, including one cut off at
        // a space or call; after anything else it starts a query or suffix.
        let path = literal.split('?')[0].replace(/(\/)?\$\{[^}]*$/, (_, slash) => slash ? '/[id]' : '')
          .replace(/([^/$])(\$\{[^}]*\}|\{[^}]*\}).*$/, '$1').replace(/\$\{[^}]*\}|\{[^}]*\}/g, '[id]');
        if (path.endsWith('/')) path += '[id]'; // A prefix that a caller completes with an id.
        found.add(path);
        if (nextOnly.has(path) || retired.has(path)) continue;
        if (!matchNativeHttpRoute(concrete(path))) { problems.push(`${file}: ${path}`); continue; }
        // A registered path still falls back to Next for a method it does not register (#5743).
        for (const method of methods?.(source, quoteAt) ?? []) {
          found.add(`${method} ${path}`);
          if (nextOnlyMethods.has(`${method} ${path}`)) continue;
          if (!matchNativeHttpRoute(concrete(path), method)) problems.push(`${file}: ${method} ${path}`);
        }
      }
    }
  }
  for (const entry of nextOnlyMethods) {
    const [method, path] = entry.split(' ');
    if (matchNativeHttpRoute(concrete(path), method)) problems.push(`${entry} is registered`);
    if (!found.has(entry)) problems.push(`${entry} has no caller left`);
  }
  for (const path of nextOnly) {
    if (matchNativeHttpRoute(concrete(path))) problems.push(`${path} is registered`);
    if (!found.has(path)) problems.push(`${path} has no caller left`);
  }
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return found;
}
function checkCaller(files: string[], pattern: RegExp, nextOnly: Set<string>,
  options: { methods?: MethodReader; nextOnlyMethods?: Set<string> } = {}) {
  return checkCallers([{ files, pattern, methods: options.methods }], nextOnly, options.nextOnlyMethods);
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

/**
 * Modules outside the WS-to-Next helpers that read the API base and name an API path: they fetch
 * the API port directly, so a path they hold counts like a helper call. Dispatch's readiness probe
 * hid here (#5768). A new module of this kind shows up as a change to this list.
 */
const API_BASE_CLIENTS = [
  'src/lib/hooks/claude-code-pretool-hook.ts',
  'src/lib/runtimes/shared/dispatch-readiness.ts',
  'src/lib/startup/schedule.ts',
];
function apiBaseClients() {
  return [...sourceFiles('src', '.ts'), ...sourceFiles('src', '.tsx')]
    .filter(file => !/^src\/(app|components)\/|^src\/lib\/mcp\/|^src\/ws-server\.ts$|^src\/lib\/ws-server\//.test(file))
    .filter(file => {
      const source = readFileSync(file, 'utf8');
      return /@\/lib\/panel\/api-port|\bO8_API_PORT\b/.test(source) && /['"`][^'"`\s]*\/api\/[a-z]/.test(source);
    }).sort();
}

const SHELL_PATTERN = /"[^"\s]*?(\/api\/[^"\s]+)"/g;
const TS_PATTERN = /`(\/api\/[^`]*)`|['"](\/api\/[\w\-./{}?=&]+)/g;

it('counts the desktop shell, the MCP server, the WS process and the CLI toward the Next-stopped default', () => {
  const shellFound = checkCaller(sourceFiles('src-tauri/src', '.rs'), SHELL_PATTERN, keys(NEXT_ONLY_SHELL_PATHS),
    { methods: rustMethods, nextOnlyMethods: keys(NEXT_ONLY_SHELL_METHODS) });
  // A template literal is read whole, so a placeholder holding a call (`${encodeURIComponent(id)}`) no longer cuts the path short.
  const mcpFound = checkCaller(sourceFiles('src/lib/mcp', '.ts'), TS_PATTERN, keys(NEXT_ONLY_MCP_PATHS),
    { methods: callMethods, nextOnlyMethods: keys(NEXT_ONLY_MCP_METHODS) });
  // Every src module that calls the WS-to-Next helpers, not only the WS entry and its lib, and every
  // module that fetches the API base directly.
  const nextCallers = [...sourceFiles('src', '.ts'), ...sourceFiles('src', '.tsx')]
    .filter(file => /\b(?:buildNextUrl|fetchNext(?!Page)\w*)[<(]/.test(readFileSync(file, 'utf8')));
  expect(nextCallers).toEqual(expect.arrayContaining(['src/ws-server.ts', 'src/lib/broadcast/speaker.ts']));
  expect(apiBaseClients()).toEqual(API_BASE_CLIENTS);
  const wsFound = checkCallers([
    { files: nextCallers, pattern: /(?:buildNextUrl|fetchNext\w*|nextFetch\w*)(?:<[^(]*>)?\(\s*[`'"](\/api\/[^`'"\s]+)[`'"]/g, methods: callMethods },
    { files: API_BASE_CLIENTS, pattern: /[`'"][^`'"\s]*?(\/api\/[^`'"\s]+)[`'"]/g },
    // A fetch built against a base or the request's own URL: `new URL('/api/v2/proxy/llm', request.url)`.
    { files: [...sourceFiles('src', '.ts'), ...sourceFiles('src', '.tsx')], pattern: /new URL\(\s*[`'"](\/api\/[^`'"\s]+)[`'"]\s*,/g },
  ], keys(NEXT_ONLY_WS_PATHS));
  // A WS-to-Next call whose path is not a literal escapes the scan, so each one is pinned here.
  expect(dynamicNextCalls(nextCallers)).toEqual(DYNAMIC_NEXT_CALLS);
  // Workers run the o8 CLI against the API port: packet heartbeats, events, scope and reports.
  const cliFound = checkCaller(sourceFiles('cli/src', '.ts'), TS_PATTERN, keys(NEXT_ONLY_CLI_PATHS),
    { methods: callMethods, nextOnlyMethods: keys(NEXT_ONLY_CLI_METHODS) });
  // A retired path may be unregistered or answer a native refusal (a 503); either way it needs a
  // caller left, or its entry goes.
  for (const path of retired) {
    expect([shellFound, mcpFound, wsFound, cliFound].some(found => found.has(path)), `${path} has no caller left`).toBe(true);
  }
  // The scorecard is derived, not pinned: each list already fails when an entry in it is
  // registered or loses its last caller, so a pinned total only made parallel ports collide.
  const routes = nextOnlyRoutes();
  const nextOnly = [...routes.values()].filter(entry => !entry.noNextHandler);
  const byOwner = (owner: string) => nextOnly.filter(entry => entry.owner === owner).length;
  console.info(`[o8d inventory] ${nextOnly.length} API-port routes still need Next `
    + `(security ${byOwner('security')}, seek ${byOwner('seek')}); ${routes.size - nextOnly.length} have no handler on Next either; `
    + `${retired.size} retired`);
});

/** Device, worker, spectator and loopback-read grants, read from the middleware source. */
function middlewareGrants() {
  const source = readFileSync('src/middleware.ts', 'utf8');
  const block = (name: string) => {
    const start = source.indexOf(`const ${name}`);
    expect(start, name).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('\n];', start));
  };
  const grants: Array<{ kind: string; methods: Set<string>; path: RegExp }> = [];
  for (const kind of ['DEVICE_CAPABILITIES', 'WORKER_CAPABILITIES', 'SPECTATOR_CAPABILITIES']) {
    for (const match of block(kind).matchAll(/methods: new Set\(\[([^\]]*)\]\), path: \/(.+)\/ \}/g)) {
      grants.push({ kind, methods: new Set([...match[1].matchAll(/'(\w+)'/g)].map(verb => verb[1])), path: new RegExp(match[2]) });
    }
  }
  for (const match of block('LOOPBACK_READ_CAPABILITIES').matchAll(/^\s*\/(.+)\/,$/gm)) {
    grants.push({ kind: 'LOOPBACK_READ', methods: new Set(['GET', 'HEAD']), path: new RegExp(match[1]) });
  }
  return grants;
}

it('gives security every Next-only route that a middleware grant reaches, with one owner per route', () => {
  const grants = middlewareGrants();
  expect(grants.filter(grant => grant.kind === 'WORKER_CAPABILITIES').length).toBeGreaterThan(10);
  expect(grants.some(grant => grant.kind === 'LOOPBACK_READ' && grant.path.test('/api/browser/proxy'))).toBe(true);
  const owners = new Map<string, string>();
  for (const [paths, methods] of Object.values(NEXT_ONLY_TABLES)) {
    for (const [route, entry] of [...Object.entries(paths), ...Object.entries(methods)]) {
      expect(entry.reason.trim(), route).not.toBe('');
      expect(owners.get(route) ?? entry.owner, `${route} has one owner`).toBe(entry.owner);
      owners.set(route, entry.owner);
      const [method, path] = route.includes(' ') ? route.split(' ') : [undefined, route];
      const granted = grants.filter(grant => grant.path.test(concrete(path)) && (!method || grant.methods.has(method)));
      if (granted.length > 0) expect(entry.owner, `${route}: ${granted.map(grant => grant.kind).join(', ')}`).toBe('security');
    }
  }
  for (const path of retired) expect(nextOnlyRoutes().has(path), `${path} is retired, not Next-only`).toBe(false);
});

it('rejects an unknown route discovered in a shell or MCP source file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'o8-api-caller-inventory-'));
  try {
    writeFileSync(join(directory, 'bridge.rs'), 'let url = format!("{}/api/caller-fixture-unknown?x=1", base);');
    expect(() => checkCaller(sourceFiles(directory, '.rs'), SHELL_PATTERN, new Set()))
      .toThrow('/api/caller-fixture-unknown');
    // A provider URL on another host is skipped; the local API port is not.
    writeFileSync(join(directory, 'provider.rs'), 'const A: &str = "https://provider.example/api/caller-fixture-remote";');
    expect(() => checkCaller([join(directory, 'provider.rs')], SHELL_PATTERN, new Set())).not.toThrow();
    writeFileSync(join(directory, 'local.rs'), 'let u = format!("http://127.0.0.1:{port}/api/caller-fixture-local");');
    expect(() => checkCaller([join(directory, 'local.rs')], SHELL_PATTERN, new Set())).toThrow('/api/caller-fixture-local');
    expect(() => checkCaller([], /"(\/api\/[^"]+)"/g, new Set(['/api/caller-fixture-gone'])))
      .toThrow('/api/caller-fixture-gone has no caller left');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('checks TS callers by method, reads template paths whole and pins dynamic WS calls', () => {
  const directory = mkdtempSync(join(tmpdir(), 'o8-api-caller-methods-'));
  const ws = /(?:buildNextUrl|fetchNext\w*|nextFetch\w*)(?:<[^(]*>)?\(\s*[`'"](\/api\/[^`'"\s]+)[`'"]/g;
  const scan = (name: string, source: string, pattern: RegExp, options: Parameters<typeof checkCaller>[3] = { methods: callMethods }) => {
    writeFileSync(join(directory, name), source);
    return () => checkCaller([join(directory, name)], pattern, new Set(), options);
  };
  try {
    // /api/panel/status is registered for GET only.
    expect(scan('get.ts', "await apiFetch('/api/panel/status');", TS_PATTERN)).not.toThrow();
    expect(scan('post.ts', "await apiFetch('/api/panel/status', { method: 'POST' });", TS_PATTERN)).toThrow('POST /api/panel/status');
    expect(scan('url.ts', "buildNextUrl('/api/panel/status', undefined, 'POST');", ws)).toThrow('POST /api/panel/status');
    expect(scan('json.ts', "fetchNextJson<{ ok: boolean }>('/api/panel/status', { method: 'DELETE' });", ws)).toThrow('DELETE /api/panel/status');
    // A method held in a variable is checked by path only; a path that only names an error is not a request.
    expect(scan('variable.ts', "await apiFetch('/api/panel/status', { method: verb });", TS_PATTERN)).not.toThrow();
    expect(scan('error.ts', "return apiError('/api/panel/status', 500, '');", TS_PATTERN)).not.toThrow();
    // The CLI passes its config first; a body without a method is a POST, and the correlated helpers always POST.
    expect(scan('cli-get.ts', "await apiFetch<Status>(cfg, '/api/panel/status', { query: { a: '1' } });", TS_PATTERN)).not.toThrow();
    expect(scan('cli-body.ts', "await apiFetch<A<B<{ x: 1 }>>>(resolveConfig(), '/api/panel/status', { body: { a: 1 } });", TS_PATTERN))
      .toThrow('POST /api/panel/status');
    expect(scan('cli-mutation.ts', "await fetchCorrelatedPacketMutation<R>(cfg, '/api/panel/status', body);", TS_PATTERN))
      .toThrow('POST /api/panel/status');
    expect(scan('mcp-mutation.ts', "await apiFetchCorrelatedMutation('/api/panel/status', body, 'id');", TS_PATTERN))
      .toThrow('POST /api/panel/status');
    // A `{ method }` shorthand is unknown; options picked by a condition send each branch's method.
    expect(scan('shorthand.ts', "await apiFetch(cfg, '/api/panel/status', { method, body });", TS_PATTERN)).not.toThrow();
    expect(scan('ternary.ts', "await apiFetch(cfg, '/api/panel/status', x ? {} : { method: 'DELETE', body });", TS_PATTERN))
      .toThrow('DELETE /api/panel/status');
    expect(callMethods("apiFetch(cfg, '/api/x', x ? {} : { method: 'POST', body })", 14)).toEqual(['POST', 'GET']);
    expect(callMethods("apiFetch(cfg, '/api/x', action === 'list' ? {} : { method: 'POST', body })", 14)).toEqual(['POST', 'GET']);
    expect(callMethods("apiFetch(cfg, '/api/x', body ? { method: 'POST', body } : {})", 14)).toEqual(['POST', 'GET']);
    // A listed method stays counted until it is registered, and only while a caller sends it.
    const listed = { methods: callMethods, nextOnlyMethods: new Set(['POST /api/panel/status']) };
    expect(scan('listed.ts', "await apiFetch('/api/panel/status', { method: 'POST' });", TS_PATTERN, listed)).not.toThrow();
    expect(scan('unlisted.ts', "await apiFetch('/api/panel/status');", TS_PATTERN, listed)).toThrow('POST /api/panel/status has no caller left');
    expect(scan('registered.ts', "await apiFetch('/api/panel/status');", TS_PATTERN,
      { methods: callMethods, nextOnlyMethods: new Set(['GET /api/panel/status']) })).toThrow('GET /api/panel/status is registered');
    // A placeholder holding a call no longer cuts the path at the registered /api/lanes/[id].
    expect(scan('template.ts', 'await apiFetch(`/api/lanes/${encodeURIComponent(id)}/fixture-unknown${qs}`);', TS_PATTERN))
      .toThrow('/api/lanes/[id]/fixture-unknown');
    // Only a literal path can be scanned, so every other WS-to-Next call is listed.
    writeFileSync(join(directory, 'dynamic.ts'),
      'export async function fetchNextJson<T>(pathname: string) {}\nfetchNextJson(path, {});\nbuildNextUrl(`/api/x`, undefined, \'GET\');');
    expect(dynamicNextCalls([join(directory, 'dynamic.ts')])).toEqual([`${join(directory, 'dynamic.ts')}: fetchNextJson(path`]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('reads the method of a Rust request from its call', () => {
  const method = (source: string) => rustMethod(source, source.lastIndexOf('"', source.indexOf('/api/')));
  // A method argument before the path, including a branch that picks the path.
  expect(method('io::json_request(&client, "PUT", "/api/repo-spec", &[], Some(body))')).toBe('PUT');
  expect(method('json_request(c, "POST", if file { "/api/a" } else { "/api/b" }, &[])')).toBe('POST');
  expect(method('let (m, p) = if new { ("PATCH", format!("/api/automations/{id}")) } else { x };')).toBe('PATCH');
  // A verb in the callee's name, through format! and a turbofish.
  expect(method('self.get::<BotList>("/api/bots", &[])')).toBe('GET');
  expect(method('o8_http::post_correlated_json("/api/orchestrator/delegate", body).await?')).toBe('POST');
  expect(method('ureq::post(&format!("{}/api/panel/status", base))')).toBe('POST');
  expect(method('client.pr_post("/api/review/x", body)')).toBe('POST');
  // A url bound by let, sent by request() later; a method in a variable stays unknown.
  expect(method('let url = client\n  .url(&format!("/api/bots/{}/thread", id))\n  .map_err(|e| e)?;\nlet r = self.request("POST", &url).send_json(b);'))
    .toBe('POST');
  expect(method('let url = self.url("/api/x")?;\nlet r = self.request(method, &url);')).toBeUndefined();
  // A literal that is not a request, and an argument after a string holding a parenthesis.
  expect(method('if path.starts_with("/api/panel/") { return; }')).toBeUndefined();
  expect(method('json_request(c, "DELETE", ")", "/api/x")')).toBe('DELETE');
  // The native scan fails a registered path sent with a method it does not register.
  const directory = mkdtempSync(join(tmpdir(), 'o8-native-route-methods-'));
  try {
    writeFileSync(join(directory, 'surface.rs'), 'io::json_request(&client, "DELETE", "/api/panel/status", &[], None)');
    expect(() => checkInventory(directory)).toThrow('DELETE /api/panel/status');
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
    expect(nextOnlyRoutes().has(route.path), route.path).toBe(false);
    expect(matchNativeHttpRoute(route.path.replace(/\[\w+\]/g, 'fixture'), 'GET'), route.path).toBeDefined();
  }
  expect(matchNativeHttpRoute('/api/native-fixture-unknown-route', 'GET')).toBeUndefined();
});
