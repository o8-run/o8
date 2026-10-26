// Disposable session workload. Raw logs/snapshots stay in work/; receipts contain no paths.
// Production: npm run build, then node scripts/bench/session-memory.mjs
//   --standalone --sessions=96 --worker-sessions=48 --transcript-mib=4
//   --idle-ms=600000 --output=work/session-memory
// Add --snapshots for a separate diagnostic run; RSS is sampled before snapshots.
// Use --snapshots=raw for heaps too large to load into the diagnostic JSON parser.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { evidencePath, freePort, healthy, launch, root, rss, sleep, stop, writeJson } from '../speed/common.mjs';
import { inspector, postGc, summarizeHeap } from '../speed/memory.mjs';
import { retainedOwners } from './standalone-heap.mjs';
import { seedWorkerSessions } from './session-memory-workers.mjs';

const mib = bytes => Math.round(bytes / 1024 / 1024 * 100) / 100;
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const persistedFile = entry => fs.existsSync(entry.file) ? entry.file : entry.archivedFile ?? entry.file;
function memory(usage) {
  return Object.fromEntries(['rss', 'heapUsed', 'heapTotal', 'external', 'arrayBuffers']
    .map(key => [`${key}MiB`, mib(usage[key])]));
}

async function retainedUsage(client) {
  // Native-buffer finalizers can run after the first collection callback.
  let usage;
  for (let pass = 0; pass < 3; pass++) usage = await postGc(client);
  return usage;
}

export async function bundleWs(outfile) {
  const require = createRequire(import.meta.url);
  // Same ESM format, native externals and server-only shim as the existing WS probe.
  await build({
    entryPoints: ['src/ws-server.ts'], outfile, bundle: true, platform: 'node', format: 'esm',
    alias: { 'server-only': path.join(root, 'scripts/server-only-stub.js') },
    // The CI fixture can live outside the checkout. Resolve native externals
    // against the installed repository dependencies instead of its temp parent.
    plugins: [{ name: 'fixture-native-externals', setup(builder) {
      builder.onResolve({ filter: /^(node-pty|better-sqlite3|bindings)$/ }, args => (
        { path: require.resolve(args.path), external: true }
      ));
    } }],
    banner: { js: [
      'import {createRequire as __o8_require} from "node:module";',
      'import {fileURLToPath as __o8_path} from "node:url";',
      'import {dirname as __o8_dir} from "node:path";',
      `const require=__o8_require(${JSON.stringify(path.join(root, 'package.json'))});`,
      'const __filename=__o8_path(import.meta.url);const __dirname=__o8_dir(__filename);',
    ].join('') },
    logLevel: 'silent',
  });
}

async function openAndCloseSession(wsPort, token, sessionKey, worker = false) {
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${token}`);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Session bootstrap deadline exceeded')), 30_000);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('open', () => socket.send(JSON.stringify({ type: 'realtime-subscribe',
        subscriptions: [{ stream: `session:${sessionKey}` }] })));
      socket.on('message', raw => {
        const frame = JSON.parse(String(raw));
        const events = frame.data?.events ?? [];
        const history = events.find(event => event.event === 'history.snapshot' && event.data?.sessionKey === sessionKey);
        if (!history) return;
        clearTimeout(timer);
        try {
          if (!worker) assert.equal(history.data.entries.length, 32, 'WS must deliver every fixture row');
          assert(history.data.entries.some(entry => entry.text.startsWith(worker ? 'worker-output-31:' : 'fixture-output-31:')),
            'WS transcript payload missing');
          resolve();
        } catch (error) { reject(error); }
      });
    });
    await new Promise(resolve => { socket.once('close', resolve); socket.close(); });
  } finally {
    socket.removeAllListeners();
    socket.on('error', () => {});
    socket.terminate();
  }
}

export async function measureSessionMemory({ output, sessions = 12, transcriptMiB = 4,
  workerSessions = 0, idleMs = 0, standalone = false, standaloneServer,
  snapshots = false, settleMs = 3000, wsBundle, registerCleanup } = {}) {
  output = path.resolve(output);
  assert(Number.isSafeInteger(sessions) && sessions > 0 && sessions <= 500);
  assert(Number.isFinite(transcriptMiB) && transcriptMiB > 0 && transcriptMiB <= 16);
  assert(Number.isSafeInteger(workerSessions) && workerSessions >= 0 && workerSessions <= 500);
  assert(Number.isSafeInteger(idleMs) && idleMs >= 0);
  fs.mkdirSync(output, { recursive: true });
  assert(!fs.existsSync(path.join(output, 'next.log')), 'Use a fresh evidence directory');
  fs.writeFileSync(path.join(output, '.gitignore'), '*\n');
  const fixture = fs.mkdtempSync(path.join(output, 'fixture-'));
  const data = path.join(fixture, 'data');
  const repo = path.join(fixture, 'repo');
  fs.mkdirSync(path.join(data, 'chat-history'), { recursive: true });
  fs.mkdirSync(repo);
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(data, 'ws-token'), token, { mode: 0o600 });
  const apiPort = await freePort(), wsPort = await freePort();
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    HOSTNAME: '127.0.0.1', PORT: String(apiPort), O8_API_PORT: String(apiPort), O8_WS_PORT: String(wsPort),
    NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`, O8_PACKAGED_APP: '1',
    O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, CORTEX_IDE_DB_PATH: path.join(data, 'fixture.db'),
    CORTEX_IDE_REPO_ROOT: repo, CORTEX_IDE_REVIEW_REPO_ROOT: repo,
    CODEX_HOME: path.join(fixture, 'codex-profile'), CLAUDE_CONFIG_DIR: path.join(fixture, 'claude-profile'),
  };
  for (const key of ['CORTEX_IDE_OWNED_CODEX_ROOT', 'CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT',
    'O8_OWNED_GEMINI_ROOT', 'O8_OWNED_OPENCODE_ROOT', 'O8_OWNED_CURSOR_ROOT', 'O8_OWNED_GROK_ROOT',
    'O8_OWNED_PI_ROOT', 'O8_OWNED_PI_BUILTIN_ROOT', 'O8_OWNED_PRIME_AGENT_ROOT',
    'O8_OWNED_DEEPSEEK_HARNESS_ROOT', 'O8_OWNED_HERMES_ROOT']) env[key] = path.join(data, key.toLowerCase());
  const wsEntry = wsBundle ?? path.join(fixture, 'ws-server.mjs');
  const nextArgs = standalone ? [standaloneServer ? evidencePath(standaloneServer) : path.join(root, '.next/standalone/server.js')]
    : ['--import', path.join(root, 'scripts/register-server-only-stub.mjs'), '--import', 'tsx',
      path.join(root, 'scripts/bench/session-memory-route-host.ts')];
  const processes = {}, clients = {};
  let cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    for (const client of Object.values(clients)) client.close();
    await Promise.all(Object.values(processes).map(stop));
    fs.rmSync(fixture, { recursive: true, force: true });
  })();
  registerCleanup?.(cleanup);
  const processTree = () => Object.fromEntries(Object.entries(rss(Object.fromEntries(
    Object.entries(processes).map(([name, owned]) => [name, owned.child.pid]),
  ))).map(([name, rows]) => [name, { count: rows.length,
    rssMiB: Math.round(rows.reduce((sum, row) => sum + row.rssMiB, 0) * 100) / 100 }]));
  const natural = {};
  const trees = {};
  const origin = `http://127.0.0.1:${apiPort}`;
  const read = async (route, body) => {
    const response = await fetch(origin + route, { headers: { Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000) });
    assert.equal(response.status, 200, `HTTP fixture rejected ${route.split('?')[0]}`);
    return response.json();
  };
  try {
    if (!wsBundle) await bundleWs(wsEntry);
    assert(!cleanupPromise, 'Memory fixture was cancelled');
    processes.next = launch(['--inspect=127.0.0.1:0', ...nextArgs], env, path.join(output, 'next.log'));
    await healthy(`${origin}/api/mobile/orchestrator/threads`, processes.next, token);
    assert(!cleanupPromise, 'Memory fixture was cancelled');
    processes.ws = launch(['--inspect=127.0.0.1:0', wsEntry], env, path.join(output, 'ws.log'));
    await healthy(`http://127.0.0.1:${wsPort}/health`, processes.ws, token);
    for (const name of ['next', 'ws']) clients[name] = await inspector(processes[name]);
    // Warm the exact HTTP modules against an empty store before establishing baseline.
    await read('/api/mobile/orchestrator/threads');
    await read('/api/mobile/history?sessionKey=llm-chat:thoughts-empty');
    const projectIds = [];
    for (let index = 0; index < 4; index++) {
      const ledger = await read('/api/panel/projects', { name: `Memory project ${index}` });
      projectIds.push(ledger.projects.find(project => project.name === `Memory project ${index}`).id);
    }
    await sleep(settleMs);
    natural.start = processTree();
    const idle = {};
    for (const name of ['next', 'ws']) idle[name] = memory(await retainedUsage(clients[name]));
    trees.start = processTree();
    console.log(JSON.stringify({ phase: 'start', processes: trees.start }));
    const files = [];
    const transcriptDigest = createHash('sha256');
    let payloadUtf8Bytes = 0;
    for (let index = 0; index < sessions; index++) {
      const id = `thoughts-memory-${index}`;
      const messages = Array.from({ length: 32 }, (_, row) => {
        const pattern = `${index}-${row}-transcript `;
        const length = Math.floor(transcriptMiB * 1024 * 1024 / 32);
        const content = `fixture-output-${row}:` + pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length);
        payloadUtf8Bytes += Buffer.byteLength(content);
        return { id: `entry-${index}-${row}`, role: row % 2 ? 'assistant' : 'user', content,
          timestamp: 1790812800000 + row * 10_000 };
      });
      transcriptDigest.update(JSON.stringify(messages));
      const file = path.join(data, 'chat-history', `${id}.json`);
      fs.writeFileSync(file, JSON.stringify({ id, title: `Memory fixture ${index}`, messages,
        repoPath: repo, backend: 'claude', model: 'claude-code', savedAt: '2026-10-01T01:00:00.000Z',
        orchestratorVisible: true }));
      files.push({ id, file, hash: digest(file) });
    }
    const listed = await read(`/api/mobile/orchestrator/threads?limit=${sessions}`);
    assert.equal(listed.threads.length, sessions, 'Every persisted session must be discoverable');
    let completedSessions = 0;
    for (const { id } of files) {
      const projectId = projectIds[completedSessions % projectIds.length];
      const ledger = await read('/api/panel/projects/active', { projectId });
      assert.equal(ledger.activeProjectId, projectId, 'Project selection must persist');
      const history = await read(`/api/mobile/history?sessionKey=llm-chat:${id}&limit=200`);
      assert.equal(history.transcript.length, 32, 'HTTP must deliver every fixture row');
      assert(history.transcript.at(-1).text.startsWith('fixture-output-31:'), 'HTTP transcript payload missing');
      await openAndCloseSession(wsPort, token, `llm-chat:${id}`);
      completedSessions++;
    }
    await sleep(settleMs);
    const after = {};
    const workers = seedWorkerSessions({ count: workerSessions, transcriptMiB,
      ownedRoot: env.CORTEX_IDE_OWNED_CODEX_ROOT, repo, env });
    for (const worker of workers) worker.hash = digest(worker.file);
    let completedWorkers = 0;
    for (const { sessionKey } of workers) {
      const history = await read(`/api/mobile/history?sessionKey=${sessionKey}&limit=200`);
      assert(history.transcript.some(entry => entry.text.startsWith('worker-output-31:')), 'HTTP worker payload missing');
      await openAndCloseSession(wsPort, token, sessionKey, true);
      completedWorkers++;
    }
    await sleep(settleMs);
    natural.afterRun = processTree();
    for (const name of ['next', 'ws']) after[name] = memory(await retainedUsage(clients[name]));
    trees.afterRun = processTree();
    console.log(JSON.stringify({ phase: 'afterRun', processes: trees.afterRun }));
    const afterIdle = {};
    if (idleMs) {
      await sleep(idleMs);
      natural.afterIdle = processTree();
      for (const name of ['next', 'ws']) afterIdle[name] = memory(await retainedUsage(clients[name]));
      trees.afterIdle = processTree();
      console.log(JSON.stringify({ phase: 'afterIdle', processes: trees.afterIdle }));
    }
    const receipt = { schema: 'o8/session-idle-memory/v1', node: process.version, platform: process.platform,
      entry: standalone ? 'Next standalone + ws-server bundle' : 'production route handlers + ws-server bundle',
      sessions, transcriptMiB, payloadUtf8Bytes, transcriptDigest: transcriptDigest.digest('hex'),
      workerPayloadUtf8Bytes: workers.reduce((sum, worker) => sum + fs.statSync(persistedFile(worker)).size, 0),
      workerTranscriptDigest: createHash('sha256').update(workers.map(worker => worker.hash).join('')).digest('hex'),
      completedSessions, completedWorkers, workerSessions, projects: projectIds.length,
      archivedWorkers: workers.filter(worker => !fs.existsSync(worker.file) && fs.existsSync(worker.archivedFile)).length,
      settleMs, idleMs, gcPasses: 3, idle, after, afterIdle,
      processTrees: { natural, postGc: trees },
      persistedOutputUnchanged: [...files, ...workers].every(entry => digest(persistedFile(entry)) === entry.hash),
      budgets: { postActivityHeapMiBPerProcess: 96, retainedHeapGrowthMiBPerProcess: 24,
        idleCachedBufferGrowthMiBPerProcess: 8, serverTreesRssBytes: 500_000_000 },
    };
    // Finish both RSS checkpoints before either process takes a snapshot.
    writeJson(path.join(output, 'receipt.json'), receipt);
    if (snapshots) {
      receipt.heaps = {};
      for (const name of ['next', 'ws']) {
        const file = path.join(output, `${name}-after.heapsnapshot`);
        await clients[name].snapshot(file);
        if (snapshots === 'raw') {
          receipt.heaps[name] = { snapshotBytes: fs.statSync(file).size };
          globalThis.gc?.();
          continue;
        }
        const shallow = summarizeHeap(file);
        globalThis.gc?.();
        receipt.heaps[name] = { shallow, retained: retainedOwners(file) };
        globalThis.gc?.();
      }
      writeJson(path.join(output, 'receipt.json'), receipt);
    }
    return receipt;
  } finally {
    await cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }));
  const receipt = await measureSessionMemory({ output: path.resolve(String(args.output ?? 'work/session-memory')),
    registerCleanup: cleanup => {
      process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)); });
      process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(143)); });
    },
    standalone: Boolean(args.standalone), snapshots: args.snapshots === 'raw' ? 'raw' : Boolean(args.snapshots),
    wsBundle: args['ws-bundle'] ? path.resolve(String(args['ws-bundle'])) : undefined,
    standaloneServer: args.server ? String(args.server) : undefined,
    workerSessions: Number(args['worker-sessions'] ?? 0), idleMs: Number(args['idle-ms'] ?? 0),
    sessions: Number(args.sessions ?? 96), transcriptMiB: Number(args['transcript-mib'] ?? 4) });
  console.log(JSON.stringify(receipt));
  if (args.check) {
    const checkpoints = { afterRun: receipt.after, ...(receipt.idleMs ? { afterIdle: receipt.afterIdle } : {}) };
    for (const [phase, sample] of Object.entries(checkpoints)) {
      for (const name of ['next', 'ws']) {
        assert(sample[name].heapUsedMiB < 96, `${name} ${phase} idle heap exceeds 96 MiB`);
        assert(sample[name].heapUsedMiB - receipt.idle[name].heapUsedMiB < 24,
          `${name} ${phase} retained heap growth exceeds 24 MiB`);
        assert(sample[name].arrayBuffersMiB - receipt.idle[name].arrayBuffersMiB < 8,
          `${name} ${phase} cached-buffer growth exceeds 8 MiB`);
      }
    }
    const trees = receipt.processTrees.postGc;
    for (const phase of [trees.afterRun, ...(receipt.idleMs ? [trees.afterIdle] : [])]) {
      assert(Object.values(phase).reduce((sum, server) => sum + server.rssMiB, 0) * 1024 * 1024 < 500_000_000,
        'Server trees exceed 500 MB');
    }
  }
}
