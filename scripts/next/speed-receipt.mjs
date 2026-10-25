#!/usr/bin/env node
// Same owned histories, production browser components and native benchmark entry.
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';
import { resolveBrowserPath } from '../bench/measure-browser-boot.mjs';
import { launchMeasuredBrowser, closeMeasuredBrowser } from '../bench/interactions/browser-runtime.mjs';
import { captureOwnedProcessTree, snapshotProcessInventory } from '../bench/interactions/cleanup.mjs';
import { observeComposerKeystroke } from '../bench/interactions/page-instrumentation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ids = ['thoughts-composer-first', 'thoughts-composer-second'];
const viewport = [1200, 816];
// GPUI TestWindow fixes its device scale at 2 on both supported platforms.
const scaleFactor = 2;
function conditions(prewarmedSessionIds, switchStartSessionId, historyPolicy) {
  return { process: 'fresh-owned-process', coldStartMeasured: false, filesystemCache: 'uncontrolled-no-reset', prewarmedSessionIds, switchStartSessionId,
    switchSamples: 'both-sessions-painted-before-sampling', inputAndScroll: 'after-ten-measured-warm-switches', historyPolicy };
}
function validSetup(value) {
  return isDeepStrictEqual(value.viewport, viewport) && value.scaleFactor === scaleFactor
    && isDeepStrictEqual(value.prewarmedSessionIds, ids) && value.switchStartSessionId === ids[1];
}
const composer = 'textarea[data-o8-active-composer="true"]';
function fail(message) { throw Object.assign(new Error(message), { safe: true }); }
function options() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--binary', '--output'].includes(args[i]) || !args[i + 1] || options[args[i]]) fail('Use --binary EXECUTABLE --output RECEIPT.json');
    options[args[i]] = args[i + 1];
  }
  if (!options['--output']) fail('Use --binary TEST_EXECUTABLE --output RECEIPT.json; omit --binary to build the native test workload');
  return options;
}
async function nativeBinary(selected) {
  if (selected) return realpath(resolve(selected));
  const child = spawn('cargo', ['test', '--locked', '--manifest-path', 'native/o8-next/Cargo.toml', '--no-run', '--message-format=json'], {
    cwd: root, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: child.stdout });
  let binary;
  lines.on('line', line => {
    try {
      const artifact = JSON.parse(line);
      if (artifact.reason === 'compiler-artifact' && artifact.profile?.test && artifact.target?.name === 'o8-next' && artifact.executable) binary = artifact.executable;
    } catch { /* Compiler diagnostics stay private. */ }
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 600000);
  try {
    const [code] = await once(child, 'exit');
    if (code !== 0 || !binary) fail('Could not build native test workload');
    return realpath(binary);
  } finally { clearTimeout(timer); lines.close(); await stop(child); }
}
async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  child.kill('SIGTERM');
  try { await exited; } finally { clearTimeout(timer); }
}
async function native(binary, origin, token, output) {
  const child = spawn(binary, ['ui::speed_receipt::paired_speed_receipt', '--exact', '--ignored', '--test-threads=1', '--nocapture'], {
    cwd: root, env: { ...process.env, O8_NEXT_API_TOKEN: token, O8_NEXT_SPEED_SERVER: origin, O8_NEXT_SPEED_OUTPUT: output }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostics = '';
  child.stderr.on('data', bytes => { diagnostics = (diagnostics + String(bytes)).slice(-8192); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 60000);
  try {
    const [code] = await once(child, 'exit');
    if (timedOut || code !== 0) {
      if (process.env.O8_SPEED_DIAGNOSTICS) console.error('[next-speed] native failure:', diagnostics.split('\n').filter((line, index, lines) => /panicked|assertion|left:|right:|not implemented|unsupported/.test(line) || /panicked/.test(lines[index - 1] ?? '')).map(line => line.replace(/\/(?:home|Users|root)\/\S+/g, '<runtime-path>')).join('\n'));
      fail('Native benchmark failed or timed out');
    }
    return JSON.parse(await readFile(output, 'utf8'));
  } finally { clearTimeout(timer); await stop(child); }
}
async function startHost(token) {
  const child = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--composer', '--paired-speed'], {
    cwd: root, env: { ...process.env, O8_NEXT_API_TOKEN: token }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: child.stdout });
  let readyCleanup;
  try {
    const ready = new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture timeout')), 30000);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('fixture exited')));
      lines.on('line', line => {
        try {
          const data = JSON.parse(line);
          if (data.origin) { clearTimeout(timer); resolveReady(data); }
        } catch { /* Private host diagnostics are drained, never included. */ }
      });
      readyCleanup = () => clearTimeout(timer);
    });
    // Keep draining stdout after readiness; production diagnostics can follow it.
    const data = await ready;
    return { child, origin: data.origin };
  } catch {
    await stop(child);
    fail('Disposable fixture host failed');
  } finally { readyCleanup?.(); }
}
const frames = page => page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
async function current(histories) {
  const built = await build({ absWorkingDir: root, bundle: true, write: false, format: 'iife', platform: 'browser', minify: true, minifyIdentifiers: false,
    alias: { '@': join(root, 'src') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}', 'process.env.NEXT_RUNTIME': '"browser"' },
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React, {useEffect,useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {ThemeProvider} from './src/lib/theme/context';
      import {ChatMessageList} from './src/components/desktop/thoughts/chat-panel/ChatMessageList';
      import {ComposerArea} from './src/components/desktop/thoughts/chat-panel/ComposerArea';
      const histories = ${JSON.stringify(histories)};
      const noop = () => {};
      function Session({index,active}) {
        const [input,setInput] = useState(''); const messages=histories[index];
        return <section data-session={index} style={{display:active?'flex':'none',flex:1,minHeight:0,flexDirection:'column'}}>
          <ChatMessageList active={active} threadId={'paired-speed-'+index} displayMessages={messages} displayWaiting isOrchestratorMode
            activeTargetLabel="Fixture" activeTargetColor="var(--t-accent)" thoughtsMutedGlass="transparent"
            thoughtsElevatedBorder="none" thoughtsElevatedShadow="none" emptyStateFallback={null}/>
          <ComposerArea activeComposer={active} showBrain={false} input={input} onInputChange={setInput} isOrchestratorMode displayWaiting
            chatMessages={messages} activeTargetLabel="Fixture" targetAgentExists thoughtsBodyBackground="transparent" enhancing={false}
            preEnhanceInput={null} onEnhance={noop} onUndoEnhance={noop} onSubmit={noop} onStop={noop} onSlashCommand={noop}
            modelLabel="Fixture" modelId="pi" activeBackend="pi" effort="medium" onEffortChange={noop} adaptiveEnabled={false}
            displayMessagesCount={messages.length} hasAssistantActivity composerMode="solo"/>
        </section>;
      }
      function Fixture() {
        const [active,setActive]=useState(0);
        useEffect(()=>{window.__speedActive=active},[active]);
        return <main style={{width:1200,height:816,display:'flex',flexDirection:'column'}}>
          <nav>{[0,1].map(index=><button data-switch={index} key={index} onClick={()=>setActive(index)}>Session {index}</button>)}</nav>
          {[0,1].map(index=><Session key={index} index={index} active={index===active}/>)}</main>;
      }
      createRoot(document.getElementById('root')).render(<ThemeProvider><Fixture/></ThemeProvider>);
    ` } });
  const measured = await launchMeasuredBrowser(resolveBrowserPath(), `o8-paired-speed-${process.pid}`);
  try {
    const page = await measured.browser.newPage({ viewport: { width: viewport[0], height: viewport[1] }, deviceScaleFactor: scaleFactor, reducedMotion: 'reduce' });
    let pageError = false;
    page.on('pageerror', error => { pageError = true; if (process.env.O8_SPEED_DIAGNOSTICS) console.error('[next-speed] browser error:', error.stack?.split('\n').slice(0, 7).join('\n').replace(/\/(?:home|Users|root)\/\S+/g, '<runtime-path>')); });
    await page.route('**/*', route => route.fulfill({ json: { groups: [], visualizations: [], settings: {} } }));
    await page.goto('http://fixture.invalid');
    await page.setContent('<html><body style="margin:0;font:13px system-ui"><div id="root"></div></body></html>');
    await page.addScriptTag({ content: built.outputFiles[0].text });
    if (process.env.O8_SPEED_DIAGNOSTICS) console.error('[next-speed] browser mounted', JSON.stringify(await page.evaluate(() => ({ ids: [...document.querySelectorAll('[data-o8-message-id]')].slice(0, 3).map(el => el.getAttribute('data-o8-message-id')), textLength: document.body.textContent.length }))));
    if (pageError) fail('Current UI fixture render failed');
    const prewarmedSessionIds = [];
    for (const [index, id] of ids.entries()) {
      await page.locator('[data-switch="' + index + '"]').click();
      await page.waitForFunction(target => window.__speedActive === target, index);
      await page.locator('section[data-session="' + index + '"] [data-o8-message-id="' + histories[index].at(-1).id + '"]').waitFor({ state: 'visible' });
      await frames(page);
      prewarmedSessionIds.push(id);
    }
    const setup = await page.evaluate(() => ({ viewport: [innerWidth, innerHeight], scaleFactor: devicePixelRatio, active: window.__speedActive }));
    const switchStartSessionId = ids[setup.active];
    if (!validSetup({ ...setup, prewarmedSessionIds, switchStartSessionId })) fail('Current UI viewport or warmup differed');
    const switches = [];
    for (let i = 0; i < 10; i++) {
      const target = i % 2;
      const pending = page.evaluate(index => new Promise(resolveSwitch => {
        let start = null;
        const timeout = setTimeout(() => resolveSwitch(null), 5000);
        document.addEventListener('click', event => { start = event.timeStamp; }, { once: true, capture: true });
        const poll = () => {
          if (start !== null && window.__speedActive === index) requestAnimationFrame(() => requestAnimationFrame(() => {
            clearTimeout(timeout); resolveSwitch(performance.now() - start);
          }));
          else requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      }), target);
      await page.locator('[data-switch="' + target + '"]').click();
      const value = await pending;
      if (!Number.isFinite(value)) fail('Current UI switch did not paint');
      switches.push(value);
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const taskMs = async () => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'TaskDuration').value * 1000;
    const scrolls = [];
    for (let i = 0; i < 50; i++) {
      const before = await taskMs();
      const moved = await page.evaluate(bottom => {
        const host = document.querySelector('[data-o8-active-chat="true"]');
        const max = host.scrollHeight - host.clientHeight;
        host.scrollTop = bottom ? max : 0;
        return max > 0;
      }, i % 2 === 0);
      if (!moved) fail('Current UI fixture must actually scroll');
      await frames(page);
      scrolls.push(await taskMs() - before);
    }
    await page.locator(composer).focus();
    const keys = [];
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => { window.__speedInputArmed = false; });
      const pending = page.evaluate(observeComposerKeystroke, { selector: composer, readySignal: '__speedInputArmed' });
      await page.waitForFunction(() => window.__speedInputArmed === true);
      await page.keyboard.press('a');
      const result = await pending;
      if (!Number.isFinite(result.durationMs)) fail('Current UI input did not paint');
      keys.push(result.durationMs);
    }
    if (await page.locator(composer).inputValue() !== 'a'.repeat(20) || pageError) fail('Current UI fixture input or render failed');
    captureOwnedProcessTree(measured.inventory);
    const live = snapshotProcessInventory();
    const pids = [...measured.inventory.processes.keys()].filter(pid => live.has(pid));
    if (!pids.length) fail('Browser process memory unavailable');
    const memory = execFileSync('ps', ['-p', pids.join(','), '-o', 'rss='], { encoding: 'utf8' })
      .trim().split(/\s+/).reduce((sum, kib) => sum + Number(kib), 0) / 1024;
    return { viewport: setup.viewport, scaleFactor: setup.scaleFactor,
      conditions: conditions(prewarmedSessionIds, switchStartSessionId, 'retained-mounted-session-components'),
      keystrokeToPaintMs: keys, scrollFrameCostMs: scrolls, switchTimeMs: switches, memoryMiB: memory,
      endpoint: 'Production ChatMessageList and ComposerArea; trusted browser input to next-frame observation; scroll TaskDuration through two animation frames',
      memoryScope: 'Owned browser process tree RSS; fixture server and harness excluded' };
  } finally { await closeMeasuredBrowser(measured); }
}
function validate(value, count) { return Array.isArray(value) && value.length === count && value.every(v => Number.isFinite(v) && v >= 0); }
async function main() {
  const args = options();
  const binary = await nativeBinary(args['--binary']);
  const output = resolve(args['--output']);
  await mkdir(dirname(output), { recursive: true });
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'o8-paired-speed-')));
  const token = randomBytes(32).toString('hex');
  let host;
  const temporary = output + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    host = await startHost(token);
    const histories = await Promise.all(ids.map(async id => {
      const response = await fetch(host.origin + '/api/mobile/history?sessionKey=llm-chat:' + id + '&limit=100&page=1', { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) fail('Fixture history unavailable');
      return (await response.json()).transcript;
    }));
    const entries = histories.map(history => history.map(({ id, role, text }) => ({ id, role, text })));
    const next = await native(binary, host.origin, token, join(directory, 'native.json'));
    if (!isDeepStrictEqual(next.fixtureEntries, entries)) fail('Native fixture differed from current UI');
    if (!validSetup(next)) fail('Native viewport or warmup differed');
    if (!next.offscreen || !next.composerPaintAcknowledged || !next.sessionContentPaintAcknowledged
      || !validate(next.keyToFrameMs, 20) || !validate(next.scrollFrameMs, 50) || !validate(next.sidebarSwitchToFirstFrameMs, 10)
      || !Number.isFinite(next.idleMemoryMiB) || next.idleMemoryMiB <= 0) fail('Native evidence was incomplete');
    const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    const web = await current(histories);
    if (!validate(web.keystrokeToPaintMs, 20) || !validate(web.scrollFrameCostMs, 50) || !validate(web.switchTimeMs, 10)
      || !Number.isFinite(web.memoryMiB) || web.memoryMiB <= 0) fail('Current UI evidence was incomplete');
    const receipt = { schema: 'o8/next-speed/v1', platform: process.platform, viewport,
      fixture: { digest, sessionIds: ids, entries: entries.map(history => history.length) },
      current: { ...web, fixtureDigest: digest },
      next: { viewport: next.viewport, scaleFactor: next.scaleFactor,
        conditions: conditions(next.prewarmedSessionIds, next.switchStartSessionId, 'production-history-read-on-each-selection'), fixtureDigest: digest, keystrokeToPaintMs: next.keyToFrameMs, scrollFrameCostMs: next.scrollFrameMs,
        switchTimeMs: next.sidebarSwitchToFirstFrameMs, memoryMiB: next.idleMemoryMiB,
        endpoint: 'GPUI TestAppContext with no-op text system; in-process keystrokes to changed-composer CPU paint; scroll first CPU draw; switch includes production history reads',
        buildMode: next.release ? 'release' : 'debug',
        memoryScope: 'Native test process RSS; fixture server and script excluded' },
      limits: 'Browser production-component fixture and native CPU scene measurements; endpoints and memory scopes differ. No display scanout, installed desktop, or real account measurements.' };
    await writeFile(temporary, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, output);
    console.log('[next-speed] Wrote paired fixture receipt');
  } finally { await stop(host?.child); await rm(directory, { recursive: true, force: true }); await rm(temporary, { force: true }); }
}
main().catch(error => { console.error('[next-speed]', error.safe ? error.message : 'Could not complete paired fixture receipt'); if (process.env.O8_SPEED_DIAGNOSTICS) console.error('[next-speed] failure kind:', error.name, String(error.message).split('\n')[0].replace(/\/(?:home|Users|root)\/\S+/g, '<runtime-path>')); process.exitCode = 1; });
