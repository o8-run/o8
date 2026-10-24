// A workload lane of transcript-tab-reuse, sharing its production-component,
// browser-ownership, input observation and statistics entry points.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveBrowserPath } from '../measure-browser-boot.mjs';
import { launchMeasuredBrowser, closeMeasuredBrowser } from './browser-runtime.mjs';
import { distribution } from './statistics.mjs';
import { instrumentationInitScript, observeComposerKeystroke } from './page-instrumentation.mjs';
import { longHistoryFixture } from './long-history-fixture.mjs';

const composer = 'textarea[data-o8-active-composer="true"]';
const option = (key, fallback) => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const metrics = async cdp => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(entry => [entry.name, entry.value]));

function profileSummary(profile) {
  const byId = new Map(profile.nodes.map(node => [node.id, node]));
  const totals = new Map();
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const node = byId.get(profile.samples[i]);
    const name = node?.callFrame.functionName || '(anonymous)';
    totals.set(name, (totals.get(name) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000);
  }
  return [...totals].map(([functionName, selfMs]) => ({ functionName, selfMs: +selfMs.toFixed(2) }))
    .sort((a, b) => b.selfMs - a.selfMs).slice(0, 15);
}

async function switchTo(page, index) {
  await page.evaluate(() => {
    window.__switchStart = null;
    document.addEventListener('click', event => { if (event.target.closest('[data-switch]')) window.__switchStart = event.timeStamp; }, { once: true, capture: true });
  });
  const pending = page.evaluate(index => new Promise(resolve => {
    const deadline = performance.now() + 30000;
    const poll = () => {
      if (performance.now() > deadline) { resolve(null); return; }
      if (window.__switchStart !== null && document.querySelector(`[data-session="${index}"] [data-o8-active-chat="true"]`)) {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - window.__switchStart)));
      } else requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }), index).then(value => ({ value }), error => ({ error }));
  // Match an app-authored control directly. Role resolution across thousands
  // of copy buttons can itself force otherwise skipped transcript layout.
  await page.locator('[data-switch]').nth(index).click();
  const result = await pending;
  if (result.error) throw result.error;
  if (!Number.isFinite(result.value)) throw new Error('Conversation switch did not paint within 30000 ms');
  return result.value;
}

async function scrollSample(page) {
  const data = await page.evaluate(async () => {
    const host = document.querySelector('[data-o8-active-chat="true"]');
    const started = performance.now();
    const times = [];
    let last;
    // Traverse the complete history, including every content type, in both
    // directions. Native scrolling still owns layout and paint.
    for (let i = 0; i < 240; i++) {
      await new Promise(resolve => requestAnimationFrame(now => { if (last !== undefined) times.push(now - last); last = now; resolve(); }));
      const fraction = i < 120 ? i / 119 : (239 - i) / 119;
      host.scrollTop = fraction * (host.scrollHeight - host.clientHeight);
    }
    return { started, times };
  });
  await page.waitForTimeout(100); // PerformanceObserver delivery, outside the measured window.
  return page.evaluate(data => ({ framesMs: data.times,
    longTasks: window.__o8Interactions.longTasks.filter(task => task.startTime >= data.started),
  }), data);
}

export async function runLongHistory() {
  const runs = Number(option('samples', '3'));
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('Use --samples=1..10');
  const output = path.resolve(option('output', 'tests/bench/latest/long-history.json'));
  const injectedDelayMs = Number(option('inject-delay-ms', '0'));
  const fixtures = [longHistoryFixture(0), longHistoryFixture(1)];
  const sourceRef = option('source-ref', null);
  const sources = new Map();
  for (const file of [
    'src/components/desktop/transcript/TranscriptNavigator.tsx',
    'src/components/desktop/transcript/TranscriptTurns.tsx',
    'src/components/desktop/thoughts/chat-panel/ChatMessageList.tsx',
  ]) {
    const name = path.basename(file, '.tsx');
    sources.set(name, sourceRef ? execFileSync('git', ['show', `${sourceRef}:${file}`], {encoding: 'utf8'}) : await fs.readFile(file, 'utf8'));
  }
  const receipt = { schema: 'o8/transcript-long-history/v1', label: option('label', 'observation'),
    surface: 'browser receipt: production ChatMessageList and ComposerArea',
    head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceRef: sourceRef ?? 'workspace', node: process.version, logicalCpus: availableParallelism(), viewport: {width: 1100, height: 800}, runs, injectedDelayMs,
    fixture: fixtures.map(({ messages: _messages, ...identity }) => identity),
    limits: 'Chromium component fixture, not full-dashboard or installed macOS acceptance. Cold means first component mount with in-memory history; server loading/transfer and persisted cold restoration are unavailable. Paint uses the existing next-frame observation, not display scanout. CPU profiles sample combined JS/render work; separate React commit, highlighting and paint attribution are unavailable.',
    targets: { warmSwitchMs: 100, coldSwitchMs: 300, keystrokeP95Ms: 16, scrollLongTaskMs: 50 },
    observations: [], errors: [],
  };
  let measured;
  try {
    await fs.mkdir(path.dirname(output), { recursive: true });
    receipt.sourceDigest = createHash('sha256').update(sources.get('TranscriptNavigator')).update(sources.get('TranscriptTurns')).update(sources.get('ChatMessageList')).digest('hex');
    const built = await build({ absWorkingDir: process.cwd(), bundle: true, write: false, format: 'iife', platform: 'browser', minify: true, minifyIdentifiers: !process.argv.includes('--profile-input'),
      plugins: [{name: 'transcript-source-ref', setup(plugin) {
        plugin.onLoad({filter: /\/(TranscriptNavigator|TranscriptTurns|ChatMessageList)\.tsx$/}, args => ({loader: 'tsx', contents: sources.get(path.basename(args.path, '.tsx'))}));
      }}],
      alias: { '@': path.resolve('src') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}', 'process.env.NEXT_RUNTIME': '"browser"' },
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React, { useEffect, useRef, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { ChatMessageList } from './src/components/desktop/thoughts/chat-panel/ChatMessageList';
        import { ComposerArea } from './src/components/desktop/thoughts/chat-panel/ComposerArea';
        import { ThemeProvider } from './src/lib/theme/context';
        const histories = ${JSON.stringify(fixtures.map(fixture => fixture.messages))};
        const noop = () => {};
        function Session({ index, active, messages }) {
          const [input, setInput] = useState('Draft ' + index);
          return <section data-session={index} style={{ display: active ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <ChatMessageList active={active} threadId={'long-history-' + index} displayMessages={messages} displayWaiting
              isOrchestratorMode activeTargetLabel="Fixture" activeTargetColor="var(--t-accent)"
              thoughtsMutedGlass="transparent" thoughtsElevatedBorder="none" thoughtsElevatedShadow="none" emptyStateFallback={null} />
            <ComposerArea activeComposer={active} showBrain={false} input={input} onInputChange={setInput} isOrchestratorMode displayWaiting
              chatMessages={messages} activeTargetLabel="Fixture" targetAgentExists thoughtsBodyBackground="transparent" enhancing={false}
              preEnhanceInput={null} onEnhance={noop} onUndoEnhance={noop} onSubmit={noop} onStop={noop} onSlashCommand={noop}
              modelLabel="Fixture" modelId="pi" activeBackend="pi" effort="medium" onEffortChange={noop} adaptiveEnabled={false}
              displayMessagesCount={messages.length} hasAssistantActivity composerMode="solo" />
          </section>;
        }
        function Fixture() {
          const [active, setActive] = useState(0);
          const [visited, setVisited] = useState([0]);
          const [messages, setMessages] = useState(histories);
          const [mode, setMode] = useState('paused');
          useEffect(() => {
            window.__setStreamMode = setMode;
            if (mode === 'paused') return;
            let tick = 0;
            const timer = setInterval(() => {
              const session = mode === 'foreground' ? active : 1 - active;
              tick++;
              window.__streamTicks = (window.__streamTicks ?? 0) + 1;
              window.__streamExpectedSuffix ??= ['', ''];
              window.__streamExpectedSuffix[session] += ' tick-' + tick;
              setMessages(previous => previous.map((entries, index) => index !== session ? entries
                : entries.map((entry, i) => i !== 4999 ? entry : {...entry, text: entry.text + ' tick-' + tick})));
            }, 50);
            return () => clearInterval(timer);
          }, [mode, active]);
          return <main style={{ width: 1000, height: 720, display: 'flex', flexDirection: 'column' }}>
            <nav>{[0, 1].map(index => <button data-switch key={index} onClick={() => { setActive(index); setVisited(previous => previous.includes(index) ? previous : [...previous, index]); }}>Session {index}</button>)}</nav>
            {visited.map(index => <Session key={index} index={index} active={index === active} messages={messages[index]} />)}
          </main>;
        }
        createRoot(document.getElementById('root')).render(<ThemeProvider><Fixture /></ThemeProvider>);
      ` } });
    measured = await launchMeasuredBrowser(resolveBrowserPath(), `o8-long-history-${process.pid}`);
    receipt.browser = measured.browser.version();
    for (let run = 0; run < runs; run++) {
      const context = await measured.browser.newContext({ viewport: { width: 1100, height: 800 }, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        page.on('pageerror', error => receipt.errors.push(error.message));
        await page.route('**/*', route => route.fulfill({ json: { groups: [], visualizations: [], settings: {} } }));
        await page.addInitScript(instrumentationInitScript, { injectedDelayMs: 0 });
        await page.goto('http://fixture.invalid');
        await page.setContent('<html><head><style>body{margin:0;font:14px system-ui}*{box-sizing:border-box;scrollbar-width:none}textarea{min-height:60px}</style></head><body><div id="root"></div></body></html>');
        const cdp = await context.newCDPSession(page);
        await cdp.send('Performance.enable'); await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
        const initialMetrics = await metrics(cdp);
        await page.addScriptTag({ content: built.outputFiles[0].text });
        await page.locator('[data-o8-message-id="s0-history-4999"]').waitFor({ state: 'attached', timeout: 120000 });
        await frames(page);
        console.log('[long-history] mounted run', run);
        const coldSwitchMs = await switchTo(page, 1);
        const coldProfile = profileSummary((await cdp.send('Profiler.stop')).profile);
        console.log('[long-history] cold', JSON.stringify({run, coldSwitchMs, coldProfile}));
        await switchTo(page, 0);
        const scroller = page.locator('[data-o8-active-chat="true"]');
        await scroller.evaluate(element => { element.scrollTop = 300; });
        await page.locator(composer).fill('Retained fixture draft');
        await page.locator(composer).evaluate(element => element.setSelectionRange(2, 9));
        await frames(page);
        const scrollTop = await scroller.evaluate(element => element.scrollTop);
        const warmSwitchMs = [];
        await cdp.send('Profiler.start');
        for (const index of [1, 0, 1, 0, 1, 0]) warmSwitchMs.push(await switchTo(page, index));
        const warmProfile = profileSummary((await cdp.send('Profiler.stop')).profile);
        const restored = await page.locator(composer).evaluate(element => ({ draft: element.value, start: element.selectionStart, end: element.selectionEnd }));
        const scrollRestored = Math.abs(await scroller.evaluate(element => element.scrollTop) - scrollTop) < 1;
        await cdp.send('Profiler.start');
        const scroll = await scrollSample(page);
        const scrollProfile = profileSummary((await cdp.send('Profiler.stop')).profile);
        console.log('[long-history] scrolled run', run);
        const inputs = {};
        for (const mode of ['background', 'foreground']) {
          await page.evaluate(mode => { window.__setStreamMode(mode); }, mode);
          await page.waitForTimeout(200);
          if (process.argv.includes('--profile-input')) await cdp.send('Profiler.start');
          const before = await metrics(cdp);
          const ticksBefore = await page.evaluate(() => window.__streamTicks ?? 0);
          const samples = [];
          for (let key = 0; key < 30; key++) {
            const pending = page.evaluate(observeComposerKeystroke, composer);
            await page.evaluate(() => true);
            await page.keyboard.press('o');
            samples.push(await pending);
            await page.keyboard.press('Backspace');
          }
          const inputProfile = process.argv.includes('--profile-input') ? profileSummary((await cdp.send('Profiler.stop')).profile) : null;
          const after = await metrics(cdp);
          inputs[mode] = { samples, inputProfile, ticks: await page.evaluate(() => window.__streamTicks) - ticksBefore,
            taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
            heapBytes: after.JSHeapUsedSize };
        }
        await page.evaluate(() => window.__setStreamMode('paused'));
        // Deliberately block the trusted key handler: the same observer and
        // latency gate must reject this control.
        await page.locator(composer).evaluate((element, delay) => element.addEventListener('keydown', () => {
          window.__injectedDelayApplications = (window.__injectedDelayApplications ?? 0) + 1;
          const until = performance.now() + delay; while (performance.now() < until) { /* sensitivity control */ }
        }, { once: true }), injectedDelayMs || 80);
        const controlPending = page.evaluate(observeComposerKeystroke, composer);
        await page.evaluate(() => true); await page.keyboard.press('o');
        const control = await controlPending;
        control.injectedDelayApplications = await page.evaluate(() => window.__injectedDelayApplications);
        const finalMetrics = await metrics(cdp);
        // Hidden presentation is allowed to defer DOM work. Verify every delta
        // through the real reveal path, outside the measured input/counter lane.
        for (const session of [1, 0]) {
          await switchTo(page, session);
          await page.waitForFunction(session => {
            const suffix = window.__streamExpectedSuffix?.[session] ?? '';
            return document.querySelector('[data-o8-message-id="s' + session + '-history-4999"]')?.textContent.includes(suffix.trimStart());
          }, session, {timeout: 10000});
        }
        const streamTailCorrect = true;
        const selectionCopied = await page.evaluate(() => {
          const element = document.querySelector('[data-o8-message-id="s0-history-1"]');
          const range = document.createRange(); range.selectNodeContents(element);
          const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          const selected = selection.toString().includes('Message 1: prose');
          selection.removeAllRanges(); return selected;
        });
        await page.locator(composer).focus();
        await page.keyboard.press('End');
        const beforeSelection = await page.locator(composer).evaluate(element => element.selectionStart);
        await page.keyboard.press('Shift+ArrowLeft');
        const keyboardSelection = await page.locator(composer).evaluate((element, before) => element === document.activeElement
          && element.selectionStart === before - 1 && element.selectionEnd === before, beforeSelection);
        // Exercise the real message-copy action; the clipboard is a fixture sink.
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable: true,
          value: {writeText: async text => { window.__copiedMessage = text; }} }));
        const copy = page.locator('[data-o8-message-id="s0-history-1"]').getByRole('button', {name: 'Copy message'});
        await copy.click();
        const copyCorrect = await page.evaluate(() => window.__copiedMessage?.includes('Message 1: prose') === true);
        const prompt = page.locator('[data-session="0"] [aria-label^="Jump to prompt 2001:"]');
        await prompt.focus(); await page.keyboard.press('Enter'); await frames(page);
        const jumpCorrect = await page.locator('[data-o8-message-id="s0-history-4000"]').evaluate(element => {
          const host = element.closest('[data-o8-active-chat]');
          return Math.abs(element.getBoundingClientRect().top - host.getBoundingClientRect().top) < 100;
        });
        receipt.observations.push({ run, coldSwitchMs, warmSwitchMs, scroll, inputs, control,
          restored, scrollRestored, streamTailCorrect, selectionCopied, keyboardSelection, copyCorrect, jumpCorrect, coldProfile, warmProfile, scrollProfile,
          taskMs: (finalMetrics.TaskDuration - initialMetrics.TaskDuration) * 1000,
          heapBytes: finalMetrics.JSHeapUsedSize, layoutMs: finalMetrics.LayoutDuration * 1000, styleMs: finalMetrics.RecalcStyleDuration * 1000,
          mountedMessages: await page.locator('[data-o8-message-id]').count() });
        await fs.writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
        console.log('[long-history] completed run', run);
      } finally { await context.close(); }
    }
    receipt.summary = {
      coldSwitchMs: distribution(receipt.observations.map(row => row.coldSwitchMs)),
      warmSwitchMs: distribution(receipt.observations.flatMap(row => row.warmSwitchMs)),
      scrollFrameMs: distribution(receipt.observations.flatMap(row => row.scroll.framesMs)),
      scrollLongTasks: receipt.observations.flatMap(row => row.scroll.longTasks),
      backgroundKeyMs: distribution(receipt.observations.flatMap(row => row.inputs.background.samples.map(sample => sample.durationMs))),
      foregroundKeyMs: distribution(receipt.observations.flatMap(row => row.inputs.foreground.samples.map(sample => sample.durationMs))),
    };
    receipt.falsification = { delayMs: injectedDelayMs || 80, gateMs: 16, budgetFailed: receipt.observations.every(row => Number.isFinite(row.control.durationMs) && row.control.durationMs >= 16) };
    receipt.correct = receipt.errors.length === 0 && receipt.observations.every(row => row.scrollRestored
      && row.restored.draft === 'Retained fixture draft' && row.restored.start === 2 && row.restored.end === 9
      && row.streamTailCorrect && row.selectionCopied && row.keyboardSelection && row.copyCorrect && row.jumpCorrect
      && ['foreground', 'background'].every(mode => row.inputs[mode].samples.length === 30 && row.inputs[mode].samples.every(sample => Number.isFinite(sample.durationMs)))
      && row.inputs.background.ticks > 0 && row.inputs.foreground.ticks > 0 && row.control.durationMs > 50);
    if (option('baseline', '')) {
      const baseline = JSON.parse(await fs.readFile(path.resolve(option('baseline', '')), 'utf8'));
      if (JSON.stringify(baseline.fixture) !== JSON.stringify(receipt.fixture) || baseline.runs !== runs) throw new Error('Baseline workload identity differs');
      receipt.baselineRelative = Object.fromEntries(['coldSwitchMs', 'warmSwitchMs', 'scrollFrameMs', 'backgroundKeyMs', 'foregroundKeyMs'].map(metric => [metric, {
        before: baseline.summary[metric].p95, after: receipt.summary[metric].p95,
        ratio: +(receipt.summary[metric].p95 / baseline.summary[metric].p95).toFixed(3),
        nonRegressing: receipt.summary[metric].p95 <= baseline.summary[metric].p95,
      }]));
    }
    receipt.targetsMet = (!receipt.baselineRelative || Object.values(receipt.baselineRelative).every(metric => metric.nonRegressing)) && receipt.correct && receipt.summary.coldSwitchMs.max < 300 && receipt.summary.warmSwitchMs.max < 100
      && receipt.summary.backgroundKeyMs.p95 < 16 && receipt.summary.foregroundKeyMs.p95 < 16
      && receipt.summary.scrollLongTasks.every(task => task.duration <= 50);
    if (!receipt.correct || (process.argv.includes('--check') && !receipt.targetsMet)) process.exitCode = 1;
  } catch (error) { receipt.error = error.message; process.exitCode = 1; }
  finally {
    if (measured) {
      receipt.browserCleanup = await closeMeasuredBrowser(measured);
      const survivors = receipt.browserCleanup.survivors;
      if (survivors.length) {
        try {
          const states = execFileSync('ps', ['-o', 'pid=,stat=', '-p', survivors.map(row => row.pid).join(',')], {encoding: 'utf8'});
          receipt.browserCleanup.survivorStates = states.trim().split('\n').map(line => {
            const [pid, state] = line.trim().split(/\s+/); return {pid: Number(pid), state};
          });
        } catch { receipt.browserCleanup.survivorStates = []; }
      }
    }
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
    console.log('[long-history]', JSON.stringify({ correct: receipt.correct, targetsMet: receipt.targetsMet, summary: receipt.summary && { ...receipt.summary, scrollLongTasks: { count: receipt.summary.scrollLongTasks.length, maxMs: Math.max(0, ...receipt.summary.scrollLongTasks.map(task => task.duration)) } }, error: receipt.error }));
  }
}
