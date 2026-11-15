import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request as forward } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { codexModelListFixtureScript } from './helpers/codex-model-list-fixture';
import { nextOnlyRoutes } from './fixtures/o8d-next-only-routes';
import { startParityReference } from './fixtures/ws-parity-server';

// Write-path receipt for the Next-stopped switch (#5576). One run against the real WS process with
// the native transport on and Next stopped:
//   1. boot: the real o8 next binary opens through its app-shell entry point (the boot receipt);
//   2. chat: sidebar New thread, a message typed and sent; a scripted provider's reply lands;
//   3. settings: the composer's effort picker saves the operator default;
//   4. threads: a saved thread opened from the sidebar, then archived from its row menu;
//   5. activity: a running packet's Archive, then Stop and archive;
//   6. worker CLI: the packet's own worker runs the o8 commands a worker uses (status, packet
//      heartbeat, scope, report, log and diff, task list and report, problem list, packet capture and
//      mirror-proof) with the token and CLI its launch minted, against the relay. A route the worker
//      is still refused on fails only on itself, by the expected-blocked list below.
// The WS process's API base is its own listener (apiOnListener), which models the API-port binding
// the switch itself still has to make: with Next stopped nothing else answers O8_API_PORT.
// Steps 2 to 5 drive the production shell through GPUI's simulated input in an ignored native test
// (native/o8-next/src/o8d_write_receipt.rs), not clicks on a display server. Every request either
// process makes goes through one recording relay. Routes that still need Next fail only on their
// own route, by the shared Next-only lists (tests/fixtures/o8d-next-only-routes.ts); a flow they block asserts that
// nothing changed, and its full outcome once the route is native. No model is called: codex is a
// local script that prints a fixed reply.
// Full mode, on Linux inside a private Xvfb display with release builds from this checkout:
//   xvfb-run -a -s '-screen 0 1440x1024x24 -nolisten tcp -noreset -br' env O8_NEXT_BINARY=... \
//     O8_NEXT_WRITE_TEST_BINARY=... npx vitest run tests/o8-next-o8d-write-real-path.test.ts
// O8_NEXT_WRITE_TEST_BINARY is the o8-next test executable from
// `cargo test --release --no-run --manifest-path native/o8-next/Cargo.toml`; O8_NEXT_BINARY is the
// release o8-next. Both are prebuilt: the receipt never builds them. Flow 1 needs O8_NEXT_BINARY and
// the display; flows 2 to 5's window steps need the test executable.
// Worker-only mode, on Linux or macOS with no Rust build and no display: dispatch, flow 6 and the
// worker sandbox checks, from the WS side alone:
//   O8_RECEIPT_WORKER_ONLY=1 npx vitest run tests/o8-next-o8d-write-real-path.test.ts
// Either mode takes O8_NEXT_WRITE_SANDBOX=1 to dispatch the worker under O8_WORKER_SANDBOX=1, and
// O8_NEXT_WRITE_CLI_CONTROL=1 for flow 6's negative control.
// The routes that still need Next, from the shared fixture: a `/path` key covers every method, a
// `METHOD /path` key that method alone. An entry marked noNextHandler has no Next handler either, so
// it is blocked rather than a Next fall-back; either may fail only on its own route.
const listed = (path: string) => new RegExp(`^${path.replace(/[.*+?^${}()|\\]/g, '\\$&').replace(/\[\w+\]/g, '[^/]+')}$`);
const nextOnly = [...nextOnlyRoutes()].map(([key, entry]) => {
  const [method, path] = key.startsWith('/') ? [null, key] : key.split(' ');
  return { method, path: listed(path), noNextHandler: entry.noNextHandler === true };
});
const matches = (method: string, path: string, noNextHandler: boolean) => nextOnly.some(route => route.noNextHandler === noNextHandler
  && (route.method === null || route.method === method) && route.path.test(path));
/** Whether a request still needs Next by the shared lists. */
const needsNext = (method: string, path: string) => matches(method, path, false);
/** Whether a request is listed with no handler on either side: blocked, not a Next fall-back. */
const nextlessBlocked = (method: string, path: string) => matches(method, path, true);

// Routes a packet worker's own credential is still refused on natively, separate from the
// Next-only lists: each fails only on itself, and fails the receipt once it answers 2xx.
const EXPECTED_BLOCKED: Array<{ route: string; reason: string }> = [
  // Native fall-through: not registered on the native transport.
  { route: 'POST /api/tasks/[id]/report', reason: 'security open fix: worker grant for task report and block (/api/tasks/[id]/[id])' },
];
const securityRoutes = EXPECTED_BLOCKED.map(({ route }) => ({ method: route.split(' ')[0], path: listed(route.split(' ')[1]) }));
/** Whether a recorded `METHOD path STATUS` line is on the expected-blocked list, at any status. */
function securityListed(line: string) {
  const [method, route] = line.split(' ');
  return securityRoutes.some(entry => entry.method === method && entry.path.test(route));
}
/** An expected-blocked route refused or unanswered: 401, 403, 404, 405 or 5xx. */
const securityHeld = (line: string) => securityListed(line) && / (401|403|404|405|5\d\d)$/.test(line);

const binary = process.env.O8_NEXT_BINARY;
const testBinary = process.env.O8_NEXT_WRITE_TEST_BINARY;
// O8_RECEIPT_WORKER_ONLY=1 runs dispatch, flow 6 and the sandbox checks alone: no o8 next binary,
// no cargo test and no display, so it runs on macOS too.
const workerOnly = process.env.O8_RECEIPT_WORKER_ONLY === '1';
const runnable = workerOnly ? process.platform === 'linux' || process.platform === 'darwin'
  : process.platform === 'linux' && !!binary && !!testBinary && !!process.env.DISPLAY;

const REPLY = 'o8d write receipt: scripted reply 4417';
// The worker's channel to the receipt, inside its worktree (see fakeCodex).
const WORKER_CHANNEL = '.o8d-receipt';
const PROMPT = 'Reply with the receipt line.';
const THREAD = 'thoughts-o8d-write-archive';
const MODEL = 'gpt-6.1-sol';

function painted(file: string, env: NodeJS.ProcessEnv) {
  execFileSync('import', ['-window', 'root', `png:${file}`], { env, stdio: 'pipe', timeout: 10_000 });
  return Number(execFileSync('identify', ['-format', '%k', file], { env, encoding: 'utf8', timeout: 10_000 })) > 32;
}
async function until(read: () => boolean | Promise<boolean>, label: string, timeoutMs = 30_000, child?: ChildProcess) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(`exited before: ${label}`);
    if (await read()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 1_500);
  await exited;
  clearTimeout(force);
}

/**
 * A local codex: model discovery, a fixed reply for chat turns, and a worker that runs until
 * stopped. It lives in the receipt's scratch bin, as both codex and claude, so neither name can
 * reach a real CLI, and the owned home's ~/.local/bin (where runtime detection scans) links to it.
 */
function fakeCodex(home: string, root: string, repo: string, probeDir: string) {
  // Outside the data folder, as a real install keeps its binaries apart from ~/.o8: the worker
  // sandbox masks every data folder, so a provider inside it would vanish (a separate finding).
  const bin = join(root, 'provider-bin');
  mkdirSync(bin, { recursive: true });
  const file = join(bin, 'codex');
  writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
${codexModelListFixtureScript()}
if (!args.includes('exec')) process.exit(0);
// Chat turns run in the repository; a delegated worker runs in its own worktree.
const worker = fs.realpathSync(process.cwd()) !== ${JSON.stringify(repo)};
const emit = value => console.log(JSON.stringify(value));
emit({ type: 'thread.started', thread_id: worker ? 'o8d-write-worker' : 'o8d-write-chat' });
if (worker) {
  emit({ type: 'item.completed', item: { id: 'worker-1', type: 'agent_message', text: 'Worker running.' } });
  // A worker may run in a sandbox that sees only its worktree, so its channel to the receipt lives
  // there: the run record, the commands to run and their results, and the sentinel that keeps it
  // running until the receipt ends (at most five minutes).
  const channel = process.cwd() + '/${WORKER_CHANNEL}';
  fs.mkdirSync(channel + '/steps', { recursive: true });
  fs.writeFileSync(channel + '/alive', '');
  // Sandbox evidence: this process's namespaces (the receipt compares them with its own) and ancestry.
  const ns = Object.fromEntries(['user', 'mnt', 'pid', 'net'].map(name => {
    try { return [name, fs.readlinkSync('/proc/self/ns/' + name)]; } catch { return [name, null]; }
  }));
  const ancestry = [];
  for (let pid = process.ppid, depth = 0; pid > 0 && depth < 12; depth++) {
    try {
      const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
      ancestry.push(fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\0')[0] || stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')));
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { break; }
  }
  // One write outside every path the sandbox grants (see the probe folder in the receipt): a
  // sandbox refuses it and the worker carries on; without one it lands and is removed by its path.
  const probe = ${JSON.stringify(join(probeDir, 'probe'))};
  let outside;
  try { fs.writeFileSync(probe, ''); fs.rmSync(probe); outside = 'written'; } catch (error) { outside = error.code || String(error); }
  fs.appendFileSync(channel + '/runs.jsonl', JSON.stringify({ pid: process.pid, cwd: process.cwd(), worker, args, ns, ancestry, outside }) + '\\n');
  // Runs the o8 commands the receipt hands it, through the run's own CLI, until stopped.
  const { spawnSync } = require('node:child_process');
  const steps = channel + '/steps';
  const end = Date.now() + 300000;
  setInterval(() => {
    if (!fs.existsSync(channel + '/alive') || Date.now() > end) process.exit(0);
    for (const name of fs.readdirSync(steps)) {
      const out = steps + '/' + name.replace(/\\.json$/, '.out');
      if (!name.endsWith('.json') || fs.existsSync(out)) continue;
      const step = JSON.parse(fs.readFileSync(steps + '/' + name, 'utf8'));
      // The step's port is the recording relay's; the worker's own API port is reported as found.
      const env = { ...process.env, O8_API_PORT: step.port };
      // The negative control only: this one command presents the operator credential instead.
      if (step.operator) { delete env.O8_WORKER_TOKEN; env.O8_API_TOKEN = step.operator; }
      const cli = spawnSync('sh', ['-c', 'command -v o8'], { env, encoding: 'utf8' }).stdout.trim();
      const run = spawnSync('o8', step.argv, { cwd: process.cwd(), env, encoding: 'utf8', timeout: 60000 });
      fs.writeFileSync(out, JSON.stringify({ status: run.status, error: run.error ? String(run.error) : null, cli,
        stdout: String(run.stdout ?? '').slice(-600), stderr: String(run.stderr ?? '').slice(-600),
        packet: process.env.O8_WORKER_PACKET_ID ?? null, token: !!process.env.O8_WORKER_TOKEN, apiPort: process.env.O8_API_PORT ?? null }));
    }
  }, 100);
} else {
  fs.appendFileSync(${JSON.stringify(join(root, 'codex-runs.jsonl'))}, JSON.stringify({ pid: process.pid, cwd: process.cwd(), worker, args }) + '\\n');
  emit({ type: 'item.completed', item: { id: 'reply-1', type: 'agent_message', text: ${JSON.stringify(REPLY)} } });
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
}
}
`);
  chmodSync(file, 0o700);
  copyFileSync(file, join(bin, 'claude'));
  // A gh that never reaches the network, first on the WS process's PATH and its workers': a proof
  // mirror would otherwise run the host's signed-in gh.
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "gh is not available in the receipt" >&2\nexit 1\n', { mode: 0o700 });
  const scanned = join(home, '.local', 'bin');
  mkdirSync(scanned, { recursive: true });
  for (const name of ['codex', 'claude']) symlinkSync(join(bin, name), join(scanned, name));
  return file;
}

// Which credential a request carried, compared without printing either token, and the start of a
// failed answer's body.
type Recorded = { flow: string; line: string; bearer?: 'operator' | 'other' | 'none'; body?: string };

/** Token-like strings (32 or more characters with no path separator) redacted. */
const redact = (text: string) => text.replace(/(?<![\w/-])[A-Za-z0-9_-]{32,}(?![\w/-])/g, '<redacted>');

/** A sandbox argv file, one argument per line: the options in full and the command's first arguments,
 * with every --setenv value and token-like string redacted. The prompt is left out. */
function sandboxArgv(text: string) {
  const lines = (redactSetenv(text) ?? '').split('\n');
  const split = lines.indexOf('--');
  return redact((split < 0 ? lines.slice(0, 80) : lines.slice(0, split + 6)).join(' '));
}

/** Runs a recorded bwrap argv by hand with every token-named --setenv value replaced by a throwaway:
 * first a probe (start, write the worktree, reach the listener), then the worker's own command. */
function handRerun(text: string, port: number, fixture: string) {
  const lines = text.replace(/\n$/, '').split('\n');
  const [bwrap, ...rest] = lines;
  const args = rest.map((line, index) => index >= 2 && rest[index - 2] === '--setenv' && /TOKEN|SECRET|KEY/i.test(rest[index - 1])
    ? 'o8d-receipt-throwaway' : line);
  const split = args.indexOf('--');
  const probe = `const fs = require('node:fs'); const out = { alive: true, cwd: process.cwd(), apiPort: process.env.O8_API_PORT ?? null };
try { fs.writeFileSync('.o8d-hand-probe', ''); fs.rmSync('.o8d-hand-probe'); out.worktreeWrite = 'ok'; } catch (error) { out.worktreeWrite = error.code; }
fetch('http://127.0.0.1:${port}/api/panel/ws-info').then(reply => { out.listener = reply.status; })
  .catch(error => { out.listener = String(error.cause?.code ?? error); }).finally(() => console.log(JSON.stringify(out)));`;
  const run = (command: string[], timeout: number) => {
    const result = spawnSync(bwrap, [...args.slice(0, split + 1), ...command], { encoding: 'utf8', timeout });
    return { status: result.status, signal: result.signal, error: result.error ? String(result.error) : null,
      stdout: redact(String(result.stdout ?? '').slice(-800)), stderr: redact(String(result.stderr ?? '').slice(-800)) };
  };
  // The worker's own command runs only when it is the receipt's fake provider, in its scratch bin; a real provider CLI would spend and use real credentials.
  const command = args.slice(split + 1);
  let provider = command[0] ?? '';
  try { provider = realpathSync(provider); } catch { /* reported as given */ }
  const fake = provider.startsWith(`${fixture}/`);
  return { probe: run([process.execPath, '-e', probe], 20_000),
    worker: fake ? run(command, 8_000) : { skipped: `not the receipt's fake provider: ${provider}` } };
}

/** A bwrap argv file (one argument per line) with every `--setenv NAME VALUE` value redacted, names kept. */
function redactSetenv(argv: string | null) {
  if (argv === null) return null;
  const lines = argv.split('\n');
  return lines.map((line, index) => index >= 2 && lines[index - 2] === '--setenv' ? '<redacted>' : line).join('\n');
}

/** Process names and pids from `pid` up through its host ancestors, read from /proc (Linux). */
function hostChain(pid: number) {
  const chain: Array<{ pid: number; name: string }> = [];
  for (let current = pid, depth = 0; current > 1 && depth < 8; depth++) {
    try {
      const stat = readFileSync(`/proc/${current}/stat`, 'utf8');
      chain.push({ pid: current, name: readFileSync(`/proc/${current}/cmdline`, 'utf8').split('\0')[0] });
      current = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { break; }
  }
  return chain;
}

/** A packet's stop-relevant fields: its lane and the authority Stop compares across stores. */
function stopView(packet: Record<string, unknown> | undefined) {
  if (!packet) return null;
  const pick = ['status', 'lane', 'runtime', 'archivedAt', 'operatorStopped', 'storageAdmissionEpoch', 'attemptCount',
    'projectId', 'workspaceTargetPath', 'branchTarget', 'manualLaunchClaim', 'holdIntent', 'releaseState', 'recovery'];
  return Object.fromEntries(pick.map(key => [key, packet[key] ?? null]));
}

/** The packet as the mission registry (the WS process's SQLite) holds it. */
async function registryPacket(directory: string, packetId: string) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(join(directory, 'cortex-ide.db'), { readonly: true, fileMustExist: true });
  try {
    for (const row of db.prepare('SELECT mission_state_json FROM missions WHERE archived_at IS NULL').all() as Array<{ mission_state_json: string }>) {
      const found = (JSON.parse(row.mission_state_json).packets ?? []).find((entry: { id: string }) => entry.id === packetId);
      if (found) return found as Record<string, unknown>;
    }
    return undefined;
  } finally { db.close(); }
}

/** The run-controller's own records of the packet's runs: whether each was sandboxed, and through what. */
function packetRunRecords(root: string, packetId: string) {
  const found = new Map<string, { sandboxed: unknown; commandIdentity: unknown; sandboxDenial: unknown; outcome: unknown; stderrPath: unknown;
    pid: unknown; stdoutPath: unknown; exit: unknown }>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const entry = value as Record<string, unknown>;
      if ('sandboxed' in entry && 'commandIdentity' in entry) {
        found.set(String(entry.id ?? entry.runId ?? found.size), { sandboxed: entry.sandboxed, commandIdentity: entry.commandIdentity,
          sandboxDenial: entry.sandboxDenial ?? null, outcome: entry.outcome, pid: entry.pid, stderrPath: entry.stderrPath, stdoutPath: entry.stdoutPath,
          exit: Object.fromEntries(Object.entries(entry).filter(([key]) => /exit|summary|classification|signal|error|failure/i.test(key))) });
      }
      Object.values(entry).forEach(visit);
    }
  };
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') walk(file);
      else if (entry.isFile() && entry.name.endsWith('.json') && statSync(file).size < 4_000_000) {
        const text = readFileSync(file, 'utf8');
        if (text.includes(packetId) && text.includes('"sandboxed"')) { try { visit(JSON.parse(text)); } catch { /* not a record */ } }
      }
    }
  };
  walk(root);
  return [...found.values()];
}

it.skipIf(!runnable)('o8 next boots and writes against the WS process with Next stopped', async () => {
  // The WS process's HOME and data folder, and a sibling TMPDIR for it and its workers: the worker
  // sandbox opens TMPDIR read-write, so it must never be HOME or one of its ancestors.
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'o8-next-o8d-write-')));
  const directory = join(parent, 'home');
  const workerTmp = join(parent, 'tmp');
  mkdirSync(directory);
  mkdirSync(workerTmp);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'o8-next-o8d-write-shell-')));
  // The sandbox probe's folder, in this checkout: outside every path either backend grants a worker
  // write to. macOS (sandbox.ts buildSeatbeltProfile) is `(deny default)` and allows writes only
  // under rwRoots: the worktree, repo, TMPDIR and toolchain dirs of the WS process's HOME (here its
  // data folder), git metadata and runtime state; Linux (sandbox-linux.ts BASE_ARGS) mounts `/`
  // read-only and binds only that same set read-write. TMPDIR itself is granted, so the probe
  // cannot live there.
  const probeDir = realpathSync(mkdtempSync(join(process.cwd(), '.o8d-receipt-probe-')));
  const repo = join(directory, 'repo');
  const requests: Recorded[] = [];
  const inflight = new Map<number, { line: string; started: number }>();
  let sequence = 0;
  let flow = 'boot';
  const path = (url: string | undefined) => new URL(url ?? '/', 'http://relay.invalid').pathname;
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  let app: ChildProcess | undefined;
  let driver: ChildProcess | undefined;
  let target = 0;
  let worktreePath: string | undefined;
  // Both processes run in tunnel mode (O8_NEXT_TUNNEL_HOST, O8_NEXT_WS_PORT), as a machine window
  // does, so the relay forwards each request and the live socket unchanged and records each status.
  const relay = createServer((request, response) => {
    const id = sequence++;
    const line = `${request.method} ${path(request.url)}`;
    // The WS process's own port scan (/api/panel/ports, probePort) sends `GET /` with this user agent
    // to every local listener, this relay included. Only that exact request is set aside; any
    // other request, with any user agent, counts as the window's.
    const tag = request.headers['user-agent'] === 'o8-port-probe' && line === 'GET /' ? 'port-probe' : flow;
    const presented = request.headers.authorization;
    const bearer = !presented ? 'none' : presented === `Bearer ${server?.token}` ? 'operator' : 'other';
    inflight.set(id, { line, started: Date.now() });
    response.on('close', () => inflight.delete(id));
    // A client dialing the listener names it as Host, and the panel gate answers any other Host 421.
    // The window's tunnel mode already sends the listener's; the worker's CLI, sent through this
    // relay, would name the relay's, so the relay restores the Host its direct dial would send.
    const headers = { ...request.headers, host: `127.0.0.1:${target}` };
    const upstream = forward({ host: '127.0.0.1', port: target, path: request.url, method: request.method, headers }, reply => {
      const entry: Recorded = { flow: tag, line: `${line} ${reply.statusCode}`, bearer };
      requests.push(entry);
      // A failed answer's first 200 characters, so a 404's cause is read, not guessed; a token never shows.
      if ((reply.statusCode ?? 0) >= 400 && !/event-stream/.test(String(reply.headers['content-type']))) {
        let body = '';
        reply.on('data', (chunk: Buffer) => { if (body.length < 200) body += chunk.toString('utf8'); });
        reply.on('end', () => { entry.body = body.replace(/[A-Za-z0-9_.~+/=-]{40,}/g, '<redacted>').slice(0, 200); });
      }
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    });
    upstream.on('error', () => { requests.push({ flow: tag, line: `${line} relay-error`, bearer }); response.destroy(); });
    request.pipe(upstream);
  });
  relay.on('upgrade', (request, socket, head) => {
    const line = `UPGRADE ${path(request.url)}`;
    const tag = flow;
    const upstream = connect(target, '127.0.0.1', () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.once('data', first => {
        requests.push({ flow: tag, line: `${line} ${/^HTTP\/1\.1 (\d{3})/.exec(first.toString('latin1'))?.[1] ?? 'unparsed'}` });
        socket.write(first);
        upstream.pipe(socket);
      });
      socket.pipe(upstream);
    });
    const close = () => { socket.destroy(); upstream.destroy(); };
    upstream.on('error', () => { requests.push({ flow: tag, line: `${line} relay-error` }); close(); });
    socket.on('error', close);
  });

  // The WS process's providers: only the local codex script, never a real CLI or credential.
  const providers: Record<string, string> = {
    O8_CODEX_BIN: '', O8_CLAUDE_CODE_BIN: '', CORTEX_IDE_OWNED_CODEX_ROOT: join(directory, 'owned-codex'),
    O8_SUBSCRIPTION_PROFILE: 'both', O8_CRASH_SURVIVABLE_WORKERS: '0', O8_SKIP_PRELAUNCH_TYPECHECK: '1', TMPDIR: workerTmp,
    // The worker sandbox is off unless the run asks for it (O8_NEXT_WRITE_SANDBOX=1).
    O8_WORKER_SANDBOX: process.env.O8_NEXT_WRITE_SANDBOX === '1' ? '1' : '0',
    PATH: `${join(scratch, 'provider-bin')}:${process.env.PATH}`, GH_TOKEN: '', GITHUB_TOKEN: '',
  };
  const saved = Object.fromEntries(Object.keys(providers).map(key => [key, process.env[key]]));
  try {
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=o8 fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
    writeFileSync(join(directory, 'repos.json'), JSON.stringify({ version: 1, repos: [{ id: 'o8d-write-repo', name: 'o8d-write', localPath: repo }] }));
    const codex = fakeCodex(directory, scratch, realpathSync(repo), probeDir);
    providers.O8_CODEX_BIN = codex; providers.O8_CLAUDE_CODE_BIN = join(scratch, 'provider-bin', 'claude');
    Object.assign(process.env, providers);
    // The API base is the WS process's own listener, as the switch must bind it: with Next stopped,
    // nothing else answers O8_API_PORT for dispatch readiness or a worker's CLI.
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000, apiOnListener: true });
    await server.stopNext();
    target = Number(new URL(server.url.replace('ws:', 'http:')).port);
    const listener = `http://127.0.0.1:${target}`;
    const auth = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
    const read = async (route: string) => (await fetch(`${listener}${route}`, { headers: auth })).json();
    const write = async (route: string, body: unknown) => {
      const response = await fetch(`${listener}${route}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
      const value = await response.json();
      expect(response.status, `${route}: ${JSON.stringify(value)}`).toBeLessThan(300);
      return value;
    };

    // Owned state, written to the listener directly and outside the receipt: the lead runtime,
    // a saved thread to archive, and a running packet to stop, dispatched with Next stopped.
    await write('/api/panel/operator-defaults', { orchestratorBackend: 'codex', orchestratorModel: MODEL, thinkingEffort: 'low',
      workerRuntimes: ['codex'], defaultDispatchRuntime: 'codex' });
    await write('/api/v2/chat-history', { tabId: THREAD, messages: [], repoPath: repo, repoName: 'o8d-write',
      title: 'Receipt thread', backend: 'codex', model: MODEL });
    // The packet launch is checked with flow 5, so a launch failure still leaves flows 1 to 4 a receipt.
    const delegated = await fetch(`${listener}/api/orchestrator/delegate`, { method: 'POST', headers: auth, body: JSON.stringify({
      repoPath: repo, prompt: 'o8d write receipt worker: keep running.', taskName: 'o8d write receipt worker', runtime: 'codex',
      model: MODEL, requestedEffort: 'low', clientMutationId: 'o8d-write-worker' }) });
    const launched = await delegated.json();
    const packetId = String(launched.packetId ?? '');
    const worktree = launched.worktreePath as string;
    worktreePath = worktree;
    const packet = async () => ((await read('/api/orchestrator/state')).mission?.packets ?? [])
      .find((entry: { id: string }) => entry.id === packetId) as Record<string, unknown> | undefined;
    if (delegated.ok) await until(async () => (await packet())?.status === 'running', 'the delegated worker runs', 60_000);

    relay.listen(0, '127.0.0.1');
    await once(relay, 'listening');
    const address = relay.address();
    if (!address || typeof address === 'string') throw new Error('relay has no port');
    const origin = `http://127.0.0.1:${address.port}`;
    // Each process's environment only: no inherited credentials or data paths.
    const base: NodeJS.ProcessEnv = { NODE_ENV: 'test', O8_NEXT_API_TOKEN: server.token, HOME: scratch, XDG_CACHE_HOME: join(scratch, 'cache'),
      XDG_CONFIG_HOME: join(scratch, 'config'), XDG_DATA_HOME: join(scratch, 'data'),
      O8_NEXT_TUNNEL_HOST: `127.0.0.1:${target}`, O8_NEXT_WS_PORT: String(address.port) };
    for (const key of ['PATH', 'TMPDIR', 'LD_LIBRARY_PATH', 'DISPLAY', 'XAUTHORITY', 'VK_DRIVER_FILES', 'VK_ICD_FILENAMES',
      'LIBGL_ALWAYS_SOFTWARE', 'FONTCONFIG_FILE', 'FONTCONFIG_PATH']) if (process.env[key]) base[key] = process.env[key];

    // 1. Boot, as the boot receipt: the real binary's first frame, thread list and live socket.
    if (!workerOnly) {
      const image = join(scratch, 'display.png');
      expect(painted(image, base)).toBe(false);
      app = spawn(binary!, ['--enable-next', '--app-shell', '--server', origin, '--shell-state', join(scratch, 'linux-shell.json')], { env: base, stdio: 'ignore' });
      app.on('error', () => {});
      await until(() => {
        execFileSync('xrefresh', ['-none'], { env: base, stdio: 'pipe', timeout: 10_000 });
        return painted(image, base);
      }, 'first frame', 30_000, app);
      await until(() => requests.some(entry => entry.line.startsWith('GET /api/mobile/orchestrator/threads 2')), 'thread list read', 30_000, app);
      await until(() => requests.some(entry => entry.line.startsWith('UPGRADE /ws ')), 'live socket handshake', 30_000, app);
      await new Promise(resolve => setTimeout(resolve, 3_000));
      expect(app.exitCode).toBeNull();
      const open = new Map(inflight);
      await new Promise(resolve => setTimeout(resolve, 6_000));
      expect([...open.keys()].filter(id => inflight.has(id)).map(id => open.get(id)!.line)).toEqual([]);
      await stop(app);

    }

    // 6, run while the worker is live and before Activity stops it: the o8 commands a worker uses,
    // run by the worker itself, from inside its launch, with the token, CLI and packet binding the
    // launch minted, dialing the relay.
    const steps: Array<[string, string[]]> = [
      ['status', ['status', '--json']],
      ['heartbeat', ['packet', 'heartbeat', '--json']],
      ['scope', ['packet', 'scope', '--json']],
      ['report', ['packet', 'report', '--event', 'progress', '--message', 'o8d write receipt progress', '--json']],
      ['log', ['packet', 'log', '--json']],
      ['diff', ['packet', 'diff', '--json']],
      ['task-list', ['task', 'list', '--json']],
      ['task-report', ['task', 'report', packetId, '--event', 'progress', '--message', 'o8d write receipt task progress', '--json']],
      ['problem', ['problem', 'list', '--json']],
      ['capture', ['packet', 'capture', '--url', 'http://127.0.0.1:9/', '--label', 'o8d write receipt', '--json']],
      ['mirror', ['packet', 'mirror-proof', '--pr', '1', '--repo', 'o8d-fixture/receipt', '--json']],
    ];
    const cli: Record<string, { status: number | null; error: string | null; cli: string; stdout: string; stderr: string;
      packet: string | null; token: boolean; apiPort: string | null }> = {};
    // Flow 6's negative control: heartbeat presents the operator credential, so the bearer check fails.
    const operatorControl = process.env.O8_NEXT_WRITE_CLI_CONTROL === '1';
    const channel = join(worktree ?? scratch, WORKER_CHANNEL);
    let hostChains: Array<Array<{ pid: number; name: string }>> = [];
    if (delegated.ok) {
      await until(() => existsSync(join(channel, 'steps')), 'the worker opens its channel', 60_000).catch(async error => {
        // Why the worker never started: the packet and the run-controller's run records, with each
        // run's stderr tail.
        const state = await packet();
        console.log(JSON.stringify({ receipt: 'o8d-write-worker-missing', packet: state && { status: state.status,
          blockedReason: state.blockedReason, latestSummary: state.latestSummary, lastEventLabel: state.lastEventLabel },
        runs: packetRunRecords(directory, packetId).map(run => {
          const tail = (file: unknown, size: number) => typeof file === 'string' && existsSync(file)
            ? redact(readFileSync(file, 'utf8').slice(-size)) : null;
          // The sandbox argv the run-controller built, written beside the run's logs (<runId>.bwrap or .sb).
          const runs = typeof run.stderrPath === 'string' ? dirname(run.stderrPath) : null;
          const profiles = runs ? readdirSync(runs).filter(name => /\.(bwrap|sb)$/.test(name)).map(name => join(runs, name)) : [];
          return { ...run, stderr: tail(run.stderrPath, 1500), stdout: tail(run.stdoutPath, 1500),
            argv: profiles.map(file => sandboxArgv(readFileSync(file, 'utf8'))),
            // The same bwrap argv run by hand, with a throwaway bearer: a probe, then the worker's own command.
            hand: profiles.filter(file => file.endsWith('.bwrap')).map(file => handRerun(readFileSync(file, 'utf8'), target, join(scratch, 'provider-bin'))) };
        }), stderr: redact(server?.diagnostics().stderr.slice(-3000) ?? '') }));
        throw error;
      });
      // While the worker runs: every bwrap process on the host, with its host ancestry.
      if (process.platform === 'linux') {
        hostChains = readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(Number).filter(pid => {
          try { return /(^|\/)bwrap$/.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0]); } catch { return false; }
        }).map(hostChain);
      }
      for (const [index, [name, argv]] of steps.entries()) {
        flow = `cli:${name}`;
        writeFileSync(join(channel, 'steps', `step-${index}.json`), JSON.stringify({ argv, port: String(address.port),
          ...(operatorControl && name === 'heartbeat' ? { operator: server.token } : {}) }), { mode: 0o600 });
        const out = join(channel, 'steps', `step-${index}.out`);
        await until(() => existsSync(out), `o8 ${argv.join(' ')}`, 90_000);
        cli[name] = JSON.parse(readFileSync(out, 'utf8'));
      }
    }
    flow = 'cli-done';

    // 2 to 5. The production shell, driven through simulated input, through the same relay.
    const lines = (name: string) => requests.filter(entry => entry.flow === name).map(entry => entry.line);
    let beforeStop: Promise<unknown> = Promise.resolve(null);
    let receipt = {} as { chat: { thread: string; rows: number; state: { draft: string } }; settings: object; threads: object;
      activity: { archived: boolean } };
    if (!workerOnly) {
      flow = 'open';
      const output = join(scratch, 'write-receipt.json');
      driver = spawn(testBinary!, ['shell::sidebar::tests::o8d_write_receipt::o8d_write_receipt', '--exact', '--ignored', '--test-threads=1', '--nocapture'], {
        env: { ...base, O8_NEXT_WRITE_SERVER: origin, O8_NEXT_WRITE_LISTENER: listener, O8_NEXT_WRITE_OUTPUT: output,
          O8_NEXT_WRITE_PROMPT: PROMPT, O8_NEXT_WRITE_REPLY: REPLY, O8_NEXT_WRITE_THREAD: THREAD, O8_NEXT_WRITE_PACKET: packetId,
          O8_NEXT_WRITE_SHELL_STATE: join(scratch, 'write-shell.json') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let diagnostics = '';
      driver.stderr!.on('data', bytes => { diagnostics = (diagnostics + String(bytes)).slice(-8192); });
      createInterface({ input: driver.stdout! }).on('line', line => {
        const marked = /^o8d-write-flow (\w+)$/.exec(line);
        if (marked) flow = marked[1];
        // The packet as Stop will find it: the control plane's copy and the mission registry's.
        if (marked?.[1] === 'activity') beforeStop = Promise.all([packet(), registryPacket(directory, packetId)])
          .then(([plane, registry]) => ({ plane: stopView(plane), registry: stopView(registry) }));
      });
      const timer = setTimeout(() => driver?.kill('SIGKILL'), 420_000);
      const [code] = await once(driver, 'exit');
      clearTimeout(timer);
      expect(code, diagnostics.split('\n').filter(line => /panicked|assertion|left:|right:|is set by/.test(line)).join('\n')).toBe(0);
      receipt = JSON.parse(readFileSync(output, 'utf8'));
    }
    console.log(JSON.stringify({ receipt: 'o8d-write-before-stop', ...(await beforeStop.catch(error => ({ error: String(error) })) as object),
      lane: (server.diagnostics().stderr.match(/^.*\[lane\].*$/gm) ?? []).slice(-8) }));
    console.log(JSON.stringify({ receipt: 'o8d-write', workerOnly, window: receipt, routes: Object.fromEntries(
      ['boot', ...steps.map(([name]) => `cli:${name}`), 'cli-done', 'open', 'chat', 'settings', 'threads', 'activity', 'done']
        .map(name => [name, [...new Set(lines(name))].sort()])), cli }, null, 2));

    // Next is gone, so every request either process made must be answered natively: no 404 or 405
    // fall-through, no refusal, no 5xx and no relay failure. The voice host's designed 503 is the
    // one exception (see the boot receipt), and a route the lists say still needs Next, or the
    // expected-blocked list holds, may fail on that route alone. Checked last, after each flow's
    // own outcome.
    const voice = await fetch(`${listener}/api/next/voice-host`, { headers: auth });
    expect([voice.status, await voice.json()]).toEqual([503, { ok: false, available: false, code: 'VOICE_HOST_UNAVAILABLE' }]);
    const failed = (line: string) => / (4\d\d|5\d\d|relay-error|unparsed)$/.test(line);
    const expected = (line: string) => {
      const [method, route, status] = line.split(' ');
      return method !== 'UPGRADE' && /^(404|405|5\d\d)$/.test(status) && (needsNext(method, route) || nextlessBlocked(method, route));
    };
    const all = requests.filter(entry => entry.flow !== 'port-probe').map(entry => entry.line);
    const unexpected = all.filter(line => failed(line) && line !== 'GET /api/next/voice-host 503' && !expected(line) && !securityHeld(line));
    // An expected-blocked route that now answers must leave the list, so the list cannot go stale.
    const fixed = all.filter(line => securityListed(line) && / 2\d\d$/.test(line)).map(line => `fixed: remove the entry: ${line}`);
    const bodies = requests.filter(entry => entry.body !== undefined).map(entry => `${entry.flow} ${entry.line} ${entry.body}`);
    console.log(JSON.stringify({ receipt: 'o8d-write-unexpected', unexpected: [...new Set(unexpected)].sort(),
      securityBlocked: [...new Set(all.filter(securityHeld))].sort(), fixed: [...new Set(fixed)], bodies: [...new Set(bodies)] }));
    // A flow that hit a route still needing Next is blocked there and must change nothing else.
    const blocked = (name: string) => lines(name).filter(line => expected(line) || securityHeld(line));
    const answered = (name: string, request: string) => lines(name).some(line => line.startsWith(`${request} 2`));
    // The only provider runs were the local script's: chat turns in the repository, the worker in its worktree.
    const record = join(scratch, 'codex-runs.jsonl');
    const runs = existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    expect(runs.filter(run => run.worker)).toEqual([]);

    if (!workerOnly) {
      expect(all).toContain('UPGRADE /ws 101');
      // Tunnel mode dials the relay; a normal launch dials the port ws-info reports, this listener's.
      const info = await read('/api/panel/ws-info') as { wsPort: number; wsToken: string };
      expect([info.wsPort, info.wsToken.length > 0]).toEqual([target, true]);
      for (const boot of ['GET /api/mobile/orchestrator/threads 200', 'GET /api/panel/ws-info 200', 'GET /api/panel/operator-defaults 200']) {
        expect(lines('boot')).toContain(boot);
      }

      // 2. Chat: the sent message and the scripted reply are in the thread's transcript.
      const thread = receipt.chat.thread as string;
      const history = await read(`/api/mobile/history?sessionKey=${encodeURIComponent(`llm-chat:${thread}`)}&limit=100&page=1`);
      const transcript = (history.transcript as Array<{ role: string; text: string }>).map(({ role, text }) => ({ role, text }));
      if (blocked('chat').length === 0) {
        expect(receipt.chat).toMatchObject({ opened: true, sent: true, replied: true });
        expect(answered('chat', 'POST /api/v2/chat-history')).toBe(true);
        expect(answered('chat', 'POST /api/orchestrator/composer-queue')).toBe(true);
        expect(transcript.some(entry => entry.role === 'user' && entry.text.includes(PROMPT)), JSON.stringify(transcript)).toBe(true);
        expect(transcript.some(entry => entry.role === 'assistant' && entry.text.includes(REPLY)), JSON.stringify(transcript)).toBe(true);
        expect(receipt.chat.rows).toBeGreaterThanOrEqual(2);
        expect(receipt.chat.state.draft).toBe('');
      } else {
        expect(transcript.some(entry => entry.text.includes(REPLY))).toBe(false);
      }
      // The only provider runs were the local script's: chat turns in the repository, the worker in its worktree.
      const record = join(scratch, 'codex-runs.jsonl');
      const runs = existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
      if (blocked('chat').length === 0) expect(runs.some(run => !run.worker), JSON.stringify(runs)).toBe(true);

      // 3. Settings: the effort the picker chose reads back.
      const effort = (await read('/api/panel/operator-defaults?include=values')).values.thinkingEffort;
      if (blocked('settings').length === 0) {
        expect(receipt.settings).toMatchObject({ before: 'low', clicked: true, saved: true });
        expect(answered('settings', 'POST /api/panel/operator-defaults')).toBe(true);
        expect(effort).toBe('high');
      } else {
        expect(effort).toBe('low');
      }

      // 4. Threads: the thread opened from the sidebar is archived, with its messages kept.
      const archivedThread = await read(`/api/v2/chat-history?tabId=${THREAD}`);
      if (blocked('threads').length === 0) {
        expect(receipt.threads).toMatchObject({ clicked: true, opened: true, archiveClicked: true, archived: true });
        expect(answered('threads', 'PATCH /api/v2/chat-history')).toBe(true);
        expect(typeof archivedThread.archivedAt).toBe('string');
      } else {
        expect(archivedThread.archivedAt ?? null).toBeNull();
      }
      expect(archivedThread.messages).toEqual([]);

    }

    // 5. Dispatch, in both modes: the packet launched with Next stopped, and its one worker runs the
    // local script in the packet's worktree.
    expect(delegated.status, `worker launch held: ${launched.error ?? JSON.stringify(launched)}`).toBe(200);
    const workerRecord = join(worktree, WORKER_CHANNEL, 'runs.jsonl');
    const workers = existsSync(workerRecord) ? readFileSync(workerRecord, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    expect(workers.map(run => realpathSync(run.cwd))).toEqual([realpathSync(worktree)]);
    expect(existsSync(worktree)).toBe(true);

    // The worker sandbox, on whichever backend this host selects: bwrap on Linux, sandbox-exec on
    // macOS. A worker counts as sandboxed only with every check, and the plain run shows each one
    // the other way:
    //   (a) Linux only: bwrap sits between the WS process and the worker: on the host, a bwrap descends
    //       from the run-controller's spawned process and the WS process, and bwrap is in the worker's ancestry
    //       (macOS sandbox-exec execs in place, leaving no process to find);
    //   (b) the run-controller's own record of the packet's run: sandboxed, spawned through the runner;
    //   (c) the probe: the worker's write outside every granted path is refused (EPERM under
    //       Seatbelt, EROFS under bwrap's read-only `/`), and lands in the plain run.
    // The probe's refusal is caught by the worker, which carries on: the run records no sandbox denial.
    const runner = process.platform === 'darwin' ? 'sandbox-exec' : 'bwrap';
    const refused = process.platform === 'darwin' ? 'EPERM' : 'EROFS';
    const own = process.platform === 'linux'
      ? Object.fromEntries(['user', 'mnt', 'pid', 'net'].map(name => [name, readlinkSync(`/proc/self/ns/${name}`)])) : {};
    const records = packetRunRecords(directory, packetId);
    const sandbox = { requested: providers.O8_WORKER_SANDBOX === '1', runner, records,
      workers: workers.map(run => ({ parent: run.ancestry[0] ?? null, ancestry: run.ancestry, outside: run.outside,
        unshared: Object.keys(own).filter(name => run.ns[name] && run.ns[name] !== own[name]) })) };
    console.log(JSON.stringify({ receipt: 'o8d-write-sandbox', ...sandbox, serverPid: server.pid, hostChains }));
    // The run-controller spawns through a shell, so an sh hop may sit on either side of bwrap.
    const isBwrap = (name: string) => /(^|\/)bwrap$/.test(name);
    const parented = (run: typeof sandbox.workers[number]) => run.ancestry.some(isBwrap);
    // Below the WS process: a bwrap on the host whose ancestors include the WS process and the
    // run-controller's spawned process (the run record's pid; a shell that runs bwrap).
    const spawned = records.map(entry => entry.pid);
    const belowServer = hostChains.some(chain => chain.some(entry => entry.pid === server!.pid)
      && chain.slice(1).some(entry => spawned.includes(entry.pid)));
    expect(records.length, 'the run-controller recorded the packet\'s run').toBeGreaterThan(0);
    expect(records.map(entry => entry.sandboxDenial), 'no sandbox denial recorded').toEqual(records.map(() => null));
    if (sandbox.requested) {
      if (process.platform === 'linux') {
        expect(sandbox.workers.map(parented), '(a) bwrap is above the worker').toEqual(workers.map(() => true));
        expect(belowServer, '(a) bwrap is below the WS process').toBe(true);
      }
      expect(records.map(entry => [entry.sandboxed, entry.commandIdentity]), `(b) the run record: sandboxed through ${runner}`)
        .toEqual(records.map(() => [true, runner]));
      expect(sandbox.workers.map(run => run.outside), '(c) the probe write is refused').toEqual(workers.map(() => refused));
      // No read-write bind in the recorded bwrap argv is HOME (the WS process's, this data folder) or an ancestor of it.
      if (process.platform === 'linux') {
        const argvs = records.flatMap(entry => typeof entry.stderrPath === 'string' ? readdirSync(dirname(entry.stderrPath))
          .filter(name => name.endsWith('.bwrap')).map(name => readFileSync(join(dirname(entry.stderrPath as string), name), 'utf8').split('\n')) : []);
        expect(argvs.length, 'the run-controller wrote its bwrap argv').toBeGreaterThan(0);
        const overHome = argvs.flatMap(argv => argv.flatMap((arg, index) => arg === '--bind' ? [argv[index + 2]] : [])
          .filter(target => target === directory || directory.startsWith(`${target}/`)));
        expect(overHome, 'read-write binds over HOME').toEqual([]);
      }
    } else {
      expect([sandbox.workers.map(parented), belowServer], '(a) plain: no bwrap above the worker or below the WS process')
        .toEqual([workers.map(() => false), false]);
      expect(records.every(entry => entry.sandboxed !== true && entry.commandIdentity !== runner), `(b) plain: ${JSON.stringify(records)}`).toBe(true);
      expect(sandbox.workers.map(run => run.outside), '(c) plain: the probe write lands').toEqual(workers.map(() => 'written'));
    }

    // 5, continued. Activity: Stop and archive leaves the packet stopped and archived, its worktree on disk.
    if (!workerOnly) {
      expect(receipt.activity).toMatchObject({ pane: true, listed: true, expanded: true, asked: true, confirm: true, confirmed: true });
      const final = await packet();
      if (blocked('activity').length === 0) {
        expect(answered('activity', 'POST /api/lanes')).toBe(true);
        expect(answered('activity', 'PATCH /api/orchestrator/state')).toBe(true);
        expect(receipt.activity.archived).toBe(true);
        expect(typeof final?.archivedAt).toBe('string');
        expect(['running', 'launching', 'recovering']).not.toContain(final?.status);
        // The archive PATCH sets packet fields only (src/app/api/orchestrator/state/route.ts); nothing removes the worktree.
        expect(existsSync(worktree), 'Stop and archive keeps the worktree').toBe(true);
      } else {
        // Only the lane stop failed, and the client then sent no archive: the packet is still there,
        // unarchived and not stopped, and its worker runs on.
        expect(blocked('activity'), JSON.stringify(lines('activity'))).toEqual([expect.stringMatching(/^POST \/api\/lanes (404|405|5\d\d)$/)]);
        expect(lines('activity').some(line => line.startsWith('PATCH /api/orchestrator/state'))).toBe(false);
        expect(final, 'the packet still exists').toBeDefined();
        expect(final?.archivedAt ?? null).toBeNull();
        expect(final?.operatorStopped ?? false).toBe(false);
        expect(final?.status).toBe('running');
        expect(receipt.activity.archived).toBe(false);
      }

    }

    // 6. Worker CLI: each command ran from the worker's own CLI with its packet identity, its API
    // port is the WS process's listener, and each sent its requests there through the relay with the
    // worker's own bearer, never the operator's (compared in the relay; neither token is printed).
    const bearers = requests.filter(entry => entry.flow.startsWith('cli:')).map(entry => `${entry.flow} ${entry.line.replace(/ \S+$/, '')} ${entry.bearer}`);
    expect(bearers.filter(entry => !entry.endsWith(' other')), 'worker CLI requests not carrying the worker bearer').toEqual([]);
    for (const [name, argv] of steps) {
      const step = cli[name];
      expect(step, `o8 ${argv.join(' ')} ran`).toBeDefined();
      expect([step.error, step.packet, step.token, step.apiPort], `o8 ${argv.join(' ')}: ${step.stderr}`).toEqual([null, packetId, true, String(target)]);
      // The run-owned CLI the launch built and verified (worker-o8-cli.ts), not one on the host.
      expect(step.cli).toMatch(/\/worker-cli\/[0-9a-f]{64}\/o8$/);
      expect(lines(`cli:${name}`).length, `o8 ${argv.join(' ')} reached the listener`).toBeGreaterThan(0);
      if (blocked(`cli:${name}`).length === 0) {
        expect(lines(`cli:${name}`).filter(failed), `o8 ${argv.join(' ')}: ${step.stderr}`).toEqual([]);
        expect(step.status, `o8 ${argv.join(' ')}: ${step.stdout} ${step.stderr}`).toBe(0);
      }
    }

    console.log(JSON.stringify({ receipt: 'o8d-write-blocked', blocked: Object.fromEntries(
      ['chat', 'settings', 'threads', 'activity', ...steps.map(([name]) => `cli:${name}`)].map(name => [name, blocked(name)])) }));
    expect(fixed).toEqual([]);
    expect(unexpected).toEqual([]);
  } finally {
    console.log(JSON.stringify({ receipt: 'o8d-write-requests', requests }));
    await stop(app);
    await stop(driver);
    relay.closeAllConnections();
    if (relay.listening) await new Promise<void>(resolve => relay.close(() => resolve()));
    // Stops the worker if Activity did not.
    if (worktreePath) rmSync(join(worktreePath, WORKER_CHANNEL, 'alive'), { force: true });
    await server?.stop();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(parent, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    rmSync(probeDir, { recursive: true, force: true });
  }
}, 720_000);
