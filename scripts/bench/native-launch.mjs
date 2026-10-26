// Release-app process spawn to an acknowledged edit in the real composer.
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
import { computeArtifactDigest } from '../lib/footprint-budget.mjs';
import { buildFixturePlan, materializeFixture } from './interactions/fixtures.mjs';

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
  assert.equal(identifier, 'ai.o8.desktop.launchbench', 'Build with the isolated measurement identifier');
}

function childEnvironment(dataDir, repoDir, socketPath) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', '__CF_USER_TEXT_ENCODING']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
    CORTEX_IDE_DB_PATH: path.join(dataDir, 'fixture.db'), CORTEX_IDE_REPO_ROOT: repoDir,
    CORTEX_IDE_REVIEW_REPO_ROOT: repoDir, O8_TAURI_MCP_SOCKET: socketPath,
    O8_FORCE_BUNDLED_SERVERS: '1', O8_BOOT_TRACE: '1',
    CODEX_HOME: path.join(dataDir, 'provider-profile'), CLAUDE_CONFIG_DIR: path.join(dataDir, 'provider-config') };
}

export async function measureNativeLaunch({ app, output, sourceSha, samples = 3 }) {
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
  const receipt = { schema: 'o8/native-launch/v1', platform: process.platform, arch: process.arch,
    osVersion: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(), sourceSha, artifactDigest,
    method: 'normal release startup, private app data and incognito webview; spawn to controlled composer edit acknowledgment',
    pollMs: 10, limitMs: 1000, samples: [] };
  try {
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
      let child, lastProbe, socketReadyMs;
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
              if (socketReadyMs === undefined) { await client.connectOnly(); socketReadyMs = round(performance.now() - started); }
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
      } catch (error) {
        receipt.failure = { sample, message: String(error.message).replaceAll(stageRoot, '<fixture>'),
          lastProbe, nativeStages: [...nativeStages], exitCode: child?.exitCode, signal: child?.signalCode };
        throw error;
      } finally {
        await cleanupGate({ client, child, dataDir: seeded.dataDir, socketPath });
        fs.rmSync(sampleRoot, { recursive: true, force: true });
      }
    }
    receipt.maxMs = Math.max(...receipt.samples.map(row => row.interactiveComposerMs));
    return receipt;
  } finally {
    fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const [key, value] = arg.replace(/^--/, '').split('='); return [key, value ?? true];
  }));
  const receipt = await measureNativeLaunch({ app: String(args.app), output: String(args.output),
    sourceSha: String(args.sha), samples: Number(args.samples ?? 3) });
  console.log(JSON.stringify(receipt));
  if (args.check) assert(receipt.maxMs < 1000, `Launch budget exceeded: ${receipt.maxMs} ms >= 1000 ms`);
}
