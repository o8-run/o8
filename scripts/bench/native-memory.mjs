// Passive whole-app RSS during the disposable session workload.
// Normal startup runs only on a disposable hosted macOS runner. No installed app is used.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { WebviewSocketClient, executeJs } from '../preship-webview-gate.mjs';
import { cleanupGate } from '../lib/preship-gate-cleanup.mjs';
import { prepareNativeRunner } from './native-runner-preconditions.mjs';
import { computeArtifactDigest, descendantPids, snapshotProcesses, webkitPids } from '../lib/footprint-budget.mjs';
import { buildFixturePlan, materializeFixture } from './interactions/fixtures.mjs';
import { exerciseSessionWorkload, verifySessionWorkload } from './session-memory.mjs';
import { countSandboxDenials } from './session-memory-workers.mjs';

const round = n => Math.round(n * 100) / 100;
const edit = 'Launch input check';

export const COMPOSER_PROBE_JS = `(() => {
  const editor = document.querySelector('textarea[data-o8-active-composer="true"]')
    || document.querySelector('[data-o8-composer-root] textarea');
  const box = editor?.getBoundingClientRect();
  const visible = Boolean(box && box.width > 0 && box.height > 0 && document.visibilityState === 'visible');
  if (!editor || !visible || editor.disabled) return JSON.stringify({ state: 'pending', editor: Boolean(editor), visible, disabled: editor?.disabled });
  const text = ${JSON.stringify(edit)};
  if (!editor.dataset.o8LaunchEdit) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.focus();
    editor.dataset.o8LaunchEdit = '1';
    return JSON.stringify({ state: 'edit-sent' });
  }
  // The native value setter alone cannot change defaultValue. This requires a
  // controlled textarea commit, rather than an unhydrated HTML input.
  if (editor.value !== text || editor.defaultValue !== text || document.activeElement !== editor || !document.hasFocus()) {
    return JSON.stringify({ state: 'awaiting-edit-commit', focused: document.hasFocus(), acknowledged: editor.defaultValue === text });
  }
  const navigation = performance.getEntriesByType('navigation')[0];
  return JSON.stringify({ state: 'ready', acknowledged: true, focused: document.hasFocus(),
    timeOrigin: performance.timeOrigin, pageNow: performance.now(),
    hydrated: document.documentElement.getAttribute('data-o8-dashboard-hydrated') === '1',
    navigation: navigation ? { requestStart: navigation.requestStart, responseStart: navigation.responseStart,
      responseEnd: navigation.responseEnd, domContentLoaded: navigation.domContentLoadedEventEnd } : null });
})()`;

function wholeAppRss(rootPid) {
  const processes = snapshotProcesses();
  const owned = new Set([...descendantPids(processes, rootPid),
    ...webkitPids(processes)]);
  const rows = execFileSync('ps', ['-axo', 'pid=,rss='], { encoding: 'utf8' });
  let bytes = 0, count = 0;
  const components = {};
  for (const row of rows.trim().split('\n')) {
    const match = row.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match || !owned.has(Number(match[1]))) continue;
    const pid = Number(match[1]), value = Number(match[2]) * 1024;
    const command = processes.get(pid)?.command ?? '';
    const component = pid === rootPid ? 'shell' : command.includes('/WebKit.framework/') ? 'webviewHelpers'
      : command.includes('next-server') ? 'httpServer' : command.includes('ws-server') ? 'realtimeServer' : 'otherHelpers';
    const group = components[component] ??= { bytes: 0, count: 0 };
    group.bytes += value; group.count++;
    count++; bytes += value;
  }
  return { bytes, count, components,
    includes: 'native shell, server descendants and all webview helpers on the disposable runner' };
}

function requireDisposableRunner(app) {
  assert.equal(process.platform, 'darwin', 'Native launch measurements require macOS');
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Use a disposable hosted runner');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Normal startup must not run beside an installed app');
  const relative = path.relative(fs.realpathSync(process.env.GITHUB_WORKSPACE), fs.realpathSync(app));
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Use the freshly built workspace artifact');
  for (const installed of ['/Applications/o8.app', path.join(os.homedir(), 'Applications/o8.app')]) {
    assert(!fs.existsSync(installed), 'An installed app is present; refusing normal-startup measurements');
  }
  const identifier = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier',
    path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  assert.equal(identifier, 'ai.o8.desktop.memorybench', 'Build with the isolated measurement identifier');
}

function childEnvironment(dataDir, repoDir, socketPath) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', '__CF_USER_TEXT_ENCODING']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, CORTEX_IDE_OWNED_CODEX_ROOT: path.join(dataDir, 'owned-memory-workers'), O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
    CORTEX_IDE_DB_PATH: path.join(dataDir, 'fixture.db'), CORTEX_IDE_REPO_ROOT: repoDir,
    CORTEX_IDE_REVIEW_REPO_ROOT: repoDir, O8_TAURI_MCP_SOCKET: socketPath,
    O8_FORCE_BUNDLED_SERVERS: '1', O8_BOOT_TRACE: '1',
    CODEX_HOME: path.join(dataDir, 'provider-profile'), CLAUDE_CONFIG_DIR: path.join(dataDir, 'provider-config') };
}

export async function measureNativeMemory({ app, output, sourceSha, samples = 1 }) {
  app = path.resolve(app); output = path.resolve(output);
  requireDisposableRunner(app);
  assert(/^[a-f0-9]{40}$/.test(sourceSha), 'Record an exact source commit');
  assert(Number.isSafeInteger(samples) && samples > 0 && samples <= 10);
  fs.mkdirSync(output, { recursive: true });
  assert(!fs.existsSync(path.join(output, 'receipt.json')), 'Use a fresh evidence directory');
  const version = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString',
    path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  const artifactDigest = computeArtifactDigest(app, { version, gitSha: sourceSha });
  const stageRoot = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'o8-launch-'));
  const stagedApp = path.join(stageRoot, 'o8.app');
  let preserveFixture = false, runner;
  const receipt = { schema: 'o8/native-idle-memory/v1', platform: process.platform, arch: process.arch,
    osVersion: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(), sourceSha, artifactDigest,
    method: 'normal release app; private profile; chat/worker history and project workload; no forced collection',
    pollMs: 10, limitBytes: 500_000_000, sessions: 24, workerSessions: 48, transcriptMiB: 4, idleMs: 600_000, samples: [] };
  try {
    runner = prepareNativeRunner('ai.o8.desktop.memorybench', stageRoot);
    receipt.privacyPrecondition = runner.services.map(service => `${service}: denied`);
    receipt.privacySetupError = runner.privacySetupError ?? null;
    execFileSync('ditto', [app, stagedApp], { stdio: 'pipe' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', stagedApp], { stdio: 'pipe' });
    assert.equal(computeArtifactDigest(stagedApp, { version, gitSha: sourceSha }), artifactDigest);
    for (let sample = 1; sample <= samples; sample++) {
      assert.equal(spawnSync('/usr/bin/pgrep', ['-x', 'o8'], { stdio: 'ignore' }).status, 1,
        'An app process is still running; refusing a normal-startup measurement');
      const sampleRoot = fs.mkdtempSync(path.join(stageRoot, 'profile-'));
      const plan = buildFixturePlan(1, 4581);
      plan.tabs = plan.tabs.filter(tab => tab.kind === 'orchestrator');
      const seeded = materializeFixture(plan, { root: sampleRoot });
      const socketPath = path.join(sampleRoot, 'control.sock');
      const client = new WebviewSocketClient(socketPath);
      let child, lastProbe, socketReadyMs, activated = false;
      const nativeStages = [], seen = new Set();
      let logTail = '';
      const capture = chunk => {
        logTail = (logTail + chunk.toString()).slice(-256_000);
        for (const match of logTail.matchAll(/\[boot(?:-trace)?\] (.*?) at (\d+)ms/g)) {
          const stage = match[1];
          if (!/^[\w ()!.,-]{1,100}$/.test(stage)) continue;
          const id = `${stage}:${match[2]}`;
          if (!seen.has(id)) { seen.add(id); nativeStages.push({ stage, atMs: Number(match[2]) }); }
        }
      };
      const epoch = Date.now(), started = performance.now();
      try {
        child = spawn(path.join(stagedApp, 'Contents/MacOS/o8'), [], { cwd: stageRoot, detached: true,
          env: childEnvironment(seeded.dataDir, seeded.repoDir, socketPath), stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', capture); child.stderr.on('data', capture);
        let launchError;
        child.on('error', error => { launchError = error; });
        while (performance.now() - started < 90_000) {
          if (launchError) throw launchError;
          assert(child.exitCode === null && child.signalCode === null, 'The app exited before accepting input');
          if (fs.existsSync(socketPath)) {
            try {
              if (socketReadyMs === undefined) {
                await client.connectOnly(); socketReadyMs = round(performance.now() - started);
              }
              if (!activated) {
                await client.send('manage_window', { window_label: 'main', operation: 'focus' });
                const activation = spawnSync(runner.executable, [String(child.pid), 'ai.o8.desktop.memorybench'],
                  { stdio: 'ignore', timeout: 3000 });
                assert.equal(activation.status, 0, 'Foreground activation failed');
                activated = true;
              }
              lastProbe = JSON.parse(await executeJs(client, COMPOSER_PROBE_JS));
              if (lastProbe.state === 'ready') {
                const interactiveComposerMs = round(performance.now() - started);
                receipt.samples.push({ sample, interactiveComposerMs, socketReadyMs, acknowledged: lastProbe.acknowledged,
                  focused: lastProbe.focused, hydrated: lastProbe.hydrated, nativeStages: [...nativeStages],
                  documentStartMs: round(lastProbe.timeOrigin - epoch), navigation: lastProbe.navigation });
                break;
              }
            } catch (error) { lastProbe = { state: 'control-pending', error: String(error.message).slice(0, 160) }; }
          }
          await sleep(10);
        }
        assert.equal(receipt.samples.length, sample, `Composer did not acknowledge input: ${JSON.stringify(lastProbe)}`);
        console.log(JSON.stringify({ sample, interactiveComposerMs: receipt.samples.at(-1).interactiveComposerMs }));
        await sleep(30_000);
        const sampleReceipt = receipt.samples.at(-1);
        const apiPort = Number(fs.readFileSync(path.join(seeded.dataDir, 'api-port'), 'utf8'));
        const wsPort = Number(fs.readFileSync(path.join(seeded.dataDir, 'ws-port'), 'utf8'));
        const token = fs.readFileSync(path.join(seeded.dataDir, 'ws-token'), 'utf8').trim();
        assert(Number.isInteger(apiPort) && apiPort > 0 && Number.isInteger(wsPort) && wsPort > 0);
        const env = childEnvironment(seeded.dataDir, seeded.repoDir, socketPath);
        const read = async (route, body) => {
          const response = await fetch(`http://127.0.0.1:${apiPort}${route}`, {
            headers: { Authorization: `Bearer ${token}`, Connection: 'close',
              ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(60_000) });
          assert.equal(response.status, 200, `Fixture route rejected ${route.split('?')[0]}`);
          return response.json();
        };
        await read('/api/mobile/history?sessionKey=llm-chat:thoughts-empty');
        await read('/api/mobile/sync', { history: { sessionKey: 'llm-chat:thoughts-empty', limit: 200 } });
        const projectIds = [];
        for (let index = 0; index < 4; index++) {
          const name = `Memory project ${index}`;
          const ledger = await read('/api/panel/projects', { name });
          projectIds.push(ledger.projects.find(project => project.name === name).id);
        }
        sampleReceipt.rss = { start: wholeAppRss(child.pid) };
        const workload = await exerciseSessionWorkload({ data: seeded.dataDir, repo: seeded.repoDir,
          env, apiPort, wsPort, token, read, sessions: 24, workerSessions: 48, transcriptMiB: 4, projectIds });
        sampleReceipt.workload = { completedSessions: workload.completedSessions, completedWorkers: workload.completedWorkers,
          transcriptDigest: workload.transcriptDigest, payloadUtf8Bytes: workload.payloadUtf8Bytes };
        sampleReceipt.rss.afterRun = wholeAppRss(child.pid);
        await sleep(600_000);
        sampleReceipt.rss.afterIdle = wholeAppRss(child.pid);
        sampleReceipt.workload.persistedOutputUnchanged = verifySessionWorkload(workload);
        sampleReceipt.workload.sandboxDenials = countSandboxDenials(workload.workers);
        assert.equal(sampleReceipt.workload.sandboxDenials, 1, 'Sandbox diagnostics must remain visible');
        assert(sampleReceipt.workload.persistedOutputUnchanged, 'Persisted fixture output changed');
      } catch (error) {
        receipt.failure = { sample, message: String(error.message).replaceAll(stageRoot, '<fixture>'),
          lastProbe, nativeStages: [...nativeStages], exitCode: child?.exitCode, signal: child?.signalCode };
        throw error;
      } finally {
        try {
          await cleanupGate({ client, child, dataDir: seeded.dataDir, socketPath });
          fs.rmSync(sampleRoot, { recursive: true, force: true });
        } catch (error) { preserveFixture = true; throw error; }
      }
    }
    receipt.maxIdleRssBytes = Math.max(...receipt.samples.map(row => row.rss.afterIdle.bytes));
    return receipt;
  } finally {
    runner?.restore();
    receipt.teardownVerified = !preserveFixture && receipt.samples.length === samples && !receipt.failure;
    fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify(receipt));
    if (!preserveFixture) fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const [key, value] = arg.replace(/^--/, '').split('='); return [key, value ?? true];
  }));
  const receipt = await measureNativeMemory({ app: String(args.app), output: String(args.output),
    sourceSha: String(args.sha), samples: Number(args.samples ?? 1) });
  if (args.check) assert(receipt.maxIdleRssBytes < receipt.limitBytes,
    `Whole-app idle RSS exceeds 500 MB (${receipt.maxIdleRssBytes} bytes)`);
}
