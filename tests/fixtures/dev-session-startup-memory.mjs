import { spawn } from 'node:child_process';
import { closeSync, constants, cpSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { get } from 'node:http';
import { pathToFileURL } from 'node:url';
import { buildFixturePlan, materializeFixture } from '../../scripts/bench/interactions/fixtures.mjs';
import { freePort, rss, sleep } from '../../scripts/speed/common.mjs';

// Compile the actual dashboard, middleware and history routes in a cold,
// disposable checkout. No source, generated output or operator data is shared.
export async function measureDevSessionStartup(workspace, output, registerCleanup) {
  mkdirSync(output, { recursive: true });
  const root = join(output, 'checkout');
  mkdirSync(root);
  for (const name of ['src', 'scripts', 'public', 'config', 'drizzle', 'package.json', 'package-lock.json', 'tsconfig.json',
    'next.config.ts']) {
    cpSync(join(workspace, name), join(root, name), { recursive: true });
  }
  // Match a real installation: Turbopack confines dependency resolution to its root.
  cpSync(realpathSync(join(workspace, 'node_modules')), join(root, 'node_modules'), {
    recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
  });
  mkdirSync(join(root, 'src/app/memory-icons'));
  writeFileSync(join(root, 'src/app/memory-icons/page.tsx'), `
'use client';
import { File } from '@phosphor-icons/react';
import { Internet } from 'iconoir-react';
export default function Icons() {
  return <main><File weight="duotone" data-memory-icon="phosphor" />
    <Internet data-memory-icon="iconoir" /></main>;
}
`);
  const fixture = materializeFixture(buildFixturePlan(1, 2887), { root: output });
  rmSync(join(fixture.dataDir, 'chat-history', 'thoughts-interaction-fixture.json'));
  for (let session = 0; session < 8; session++) {
    const messages = Array.from({ length: session < 3 ? 1100 : 32 }, (_, row) => ({
      id: `memory-${session}-${row}`, role: row % 2 ? 'assistant' : 'user',
      content: `Memory fixture ${session}/${row}: ` + 'Retain the transcript and reading position. '.repeat(6),
      timestamp: 1700000000000 + row * 1000,
    }));
    writeFileSync(join(fixture.dataDir, 'chat-history', `thoughts-memory-${session}.json`), JSON.stringify({
      id: `thoughts-memory-${session}`, title: `Memory ${session}`, messages,
      repoPath: fixture.repoDir, backend: 'pi', model: 'pi', orchestratorVisible: true,
      savedAt: '2026-10-26T00:00:00.000Z',
    }));
  }
  const api = await freePort(), ws = await freePort();
  const token = 'offline-memory-fixture';
  writeFileSync(join(fixture.dataDir, 'ws-token'), token);
  const preload = join(output, 'offline-startup.cjs');
  // Match the original review's isolation of optional background review/search
  // jobs. The real Next registration, middleware and requested routes still run.
  writeFileSync(preload, `globalThis.__o8NextStartupScheduled = true;
globalThis.__o8EdgeTtsEnsurer = { status: () => 'ready', ensure: async () => {} };
const fs = require('node:fs'), v8 = require('node:v8');
const sample = () => fs.appendFileSync(${JSON.stringify(join(output, 'node-memory.jsonl'))}, JSON.stringify({
  pid: process.pid, entry: process.argv[1], heapLimit: v8.getHeapStatistics().heap_size_limit,
  usage: process.memoryUsage()
}) + '\\n');
sample(); setInterval(sample, 10000).unref();
`);
  const env = {
    PATH: process.env.PATH, HOME: join(output, 'home'), NODE_ENV: 'development',
    NEXT_TELEMETRY_DISABLED: '1', PORT: String(api), O8_API_PORT: String(api),
    O8_WS_PORT: String(ws), WS_PORT: String(ws), O8_DATA_DIR: fixture.dataDir,
    CORTEX_IDE_DATA_DIR: fixture.dataDir, CORTEX_IDE_DB_PATH: join(fixture.dataDir, 'fixture.db'),
    CORTEX_IDE_REPO_ROOT: fixture.repoDir, CORTEX_IDE_REVIEW_REPO_ROOT: fixture.repoDir,
    NODE_OPTIONS: `--require=${preload}`,
  };
  mkdirSync(env.HOME);
  const log = openSync(join(output, 'server.log'), 'w');
  const { generatedOutputLaunch } = await import(pathToFileURL(join(root, 'scripts/lib/generated-output-launch.mjs')).href);
  const invocation = generatedOutputLaunch('dev', ['-p', String(api), '-H', '127.0.0.1']);
  const child = spawn(invocation.command, invocation.args, {
    cwd: root, env, detached: process.platform !== 'win32', stdio: ['ignore', log, log],
  });
  closeSync(log);
  let launchError;
  child.on('error', error => { launchError = error; });
  const started = Date.now();
  const deadline = new AbortController();
  const receipt = { peakMiB: 0, elapsedMs: 0, samples: [], responses: [], error: null };
  let halted = false;
  const stop = signal => {
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch { /* Already exited. */ }
  };
  registerCleanup?.(() => stop('SIGKILL'));
  const expiry = setTimeout(() => {
    receipt.error ??= 'Startup exceeded the 600s fixture deadline';
    deadline.abort();
    stop('SIGTERM');
  }, 600_000);
  const sample = () => {
    const rows = rss({ server: child.pid }).server;
    const mb = rows.reduce((sum, row) => sum + row.rssMiB, 0);
    if (mb > receipt.peakMiB) receipt.peakProcesses = rows;
    receipt.peakMiB = Math.max(receipt.peakMiB, mb);
    receipt.samples.push({ ms: Date.now() - started, mb });
    // Safety is separate from the asserted budget. Never exhaust the host.
    if (mb > 3800 && !halted) {
      halted = true; receipt.error = 'Server tree crossed the 3800 MiB safety guard'; stop('SIGTERM');
    }
  };
  const timer = setInterval(sample, 1000);
  const read = async route => {
    if (launchError) throw launchError;
    if (halted || child.exitCode !== null) throw Error(receipt.error ?? 'Server exited before completing startup');
    // Node fetch has a separate 300s headers deadline which would measure the
    // HTTP client rather than the explicit cold-compiler fixture deadline.
    const response = await new Promise((resolve, reject) => {
      const request = get(`http://127.0.0.1:${api}${route}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.any([deadline.signal, AbortSignal.timeout(480_000)]),
      }, incoming => {
        let text = '';
        incoming.setEncoding('utf8');
        incoming.on('data', chunk => { text += chunk; });
        incoming.once('error', reject);
        incoming.once('end', () => resolve({ status: incoming.statusCode, text }));
      });
      request.once('error', reject);
    });
    receipt.responses.push({ route, status: response.status, bytes: Buffer.byteLength(response.text) });
    if (response.status !== 200) throw Error(`Startup route returned ${response.status}`);
    return response;
  };
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 180; attempt++) {
      if (halted || deadline.signal.aborted || launchError || child.exitCode !== null) throw launchError ?? Error('Server exited before health');
      try {
        const response = await fetch(`http://127.0.0.1:${api}/api/panel/status`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.any([deadline.signal, AbortSignal.timeout(2000)]),
        });
        await response.arrayBuffer();
        if (response.ok) { healthy = true; break; }
      } catch { /* Compiler not ready yet. */ }
      await sleep(500);
    }
    if (!healthy) throw Error('Health route did not become ready');
    const page = await read('/dashboard');
    receipt.dashboard = page.text.includes('<html');
    const icons = await read('/memory-icons');
    receipt.renderedIcons = ['phosphor', 'iconoir'].every(name => new RegExp(
      '<svg\\b[^>]*data-memory-icon="' + name + '"[^>]*>',
    ).test(icons.text));
    const threads = JSON.parse((await read('/api/v2/chat-history/list?include=orchestrator')).text);
    receipt.threadCount = threads.conversations.length;
    receipt.histories = [];
    for (let session = 0; session < 3; session++) {
      const history = JSON.parse((await read(`/api/v2/chat-history?tabId=thoughts-memory-${session}`)).text);
      receipt.histories.push({ session, rows: history.messages.length,
        finalRowPresent: history.messages.some(row => row.id === `memory-${session}-1099`) });
    }
    receipt.dashboardRevisit = (await read('/dashboard')).text.includes('<html');
    await sleep(3000);
    sample();
  } catch (error) {
    receipt.error ??= String(error);
    receipt.failureCause = error.cause?.code ?? null;
  } finally {
    clearInterval(timer);
    clearTimeout(expiry);
    stop('SIGTERM');
    await sleep(1500);
    stop('SIGKILL');
    receipt.elapsedMs = Date.now() - started;
    writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  }
  // Check persisted output as well as response rows: the budget never prunes
  // history to pass, and every original source record remains intact.
  receipt.persistedRows = Array.from({ length: 3 }, (_, session) => JSON.parse(readFileSync(
    join(fixture.dataDir, 'chat-history', `thoughts-memory-${session}.json`), 'utf8',
  )).messages.length);
  receipt.serverProcessCount = new Set(readFileSync(join(output, 'node-memory.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line)).filter(row => row.entry?.endsWith('/next/dist/server/lib/start-server.js'))
    .map(row => row.pid)).size;
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  return receipt;
}
