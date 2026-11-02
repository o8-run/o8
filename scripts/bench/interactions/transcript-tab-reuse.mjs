#!/usr/bin/env node
// Production transcript components; four retained sessions with fixture output.
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright-core';
import { resolveBrowserPath } from '../measure-browser-boot.mjs';
import { launchMeasuredBrowser, closeMeasuredBrowser } from './browser-runtime.mjs';
import { percentile } from './statistics.mjs';
import { runLongHistory } from './long-history.mjs';

if (process.argv.includes('--long-history')) {
  await runLongHistory();
} else {

const option = (key, fallback) => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const engine = option('engine', 'chromium');
const output = path.resolve(option('output', 'tests/bench/latest/transcript-tab-reuse.json'));
const expectReuse = process.argv.includes('--expect-reuse');
const forceInvalidation = process.argv.includes('--force-row-invalidation');
if (!['chromium', 'webkit'].includes(engine)) throw new Error('Use --engine=chromium|webkit.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const directory = await mkdtemp(path.join(tmpdir(), 'o8-transcript-reuse-'));
let browser; let measured;
const errors = [];
const observations = [];
try {
  const built = await build({ absWorkingDir: root, bundle: true, write: false, format: 'iife', platform: 'browser', minify: true,
    alias: { '@': path.join(root, 'src') }, define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
    plugins: [{ name: 'render-observation', setup(plugin) {
      plugin.onLoad({ filter: /DesktopAgentMessage\.tsx$/ }, async args => {
        const source = await readFile(args.path, 'utf8');
        const marker = '}: DesktopAgentMessageProps) {';
        if (source.split(marker).length !== 2) throw new Error('Missing production row observation seam');
        return { loader: 'tsx', contents: source.replace(marker, `${marker}
          const counts = window.__transcriptRowRenders ?? (window.__transcriptRowRenders = {});
          counts[entry.id] = (counts[entry.id] ?? 0) + 1;
        `) };
      });
      if (forceInvalidation) plugin.onLoad({ filter: /chat-panel\/ChatMessageList\.tsx$/ }, async args => {
        const source = await readFile(args.path, 'utf8');
        const marker = 'animateStreaming={animateLatestAssistant && index === lastAssistantIndex}';
        if (source.split(marker).length !== 2) throw new Error('Missing production row invalidation seam');
        return { loader: 'tsx', contents: source.replace(marker, 'animateStreaming={active}') };
      });
    } }],
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React, { useEffect, useRef, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ChatMessageList } from './src/components/desktop/thoughts/chat-panel/ChatMessageList';
      const histories = Array.from({length: 4}, (_, s) => Array.from({length: 80}, (_, i) => ({
        id: i === 79 ? 's' + s + '-live' : 's' + s + '-old-' + i,
        role: i % 2 ? 'assistant' : 'user',
        text: i % 2 ? '**Completed answer ' + i + '**\\n\\n' + 'Keep the draft and transcript position. '.repeat(12) : 'Request ' + i,
      })));
      function Fixture() {
        const [active, setActive] = useState(0);
        const activeRef = useRef(active); activeRef.current = active;
        const [messages, setMessages] = useState(histories);
        useEffect(() => {
          let tick = 0;
          const timer = setInterval(() => { tick++;
            setMessages(previous => previous.map((entries, s) => s !== activeRef.current && tick % 20 !== 0 ? entries
              : entries.map((entry, i) => i === 79 ? {...entry, text: 'Live session ' + s + ' tick ' + tick} : entry)));
          }, 50);
          return () => clearInterval(timer);
        }, []);
        return <main style={{width: 1000, height: 650, display: 'flex', flexDirection: 'column'}}>
          <nav>{[0,1,2,3].map(index => <button key={index} onClick={() => setActive(index)}>Session {index}</button>)}</nav>
          {[0,1,2,3].map(index => <section key={index} data-session={index}
            style={{display: index === active ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0}}>
            <ChatMessageList active={index === active} threadId={'fixture-session-' + index} displayMessages={messages[index]}
              displayWaiting={true} isOrchestratorMode={true} activeTargetLabel="Fixture" activeTargetColor="var(--t-accent)"
              thoughtsMutedGlass="transparent" thoughtsElevatedBorder="none" thoughtsElevatedShadow="none" emptyStateFallback={null} />
            <textarea defaultValue={'Draft ' + index} />
          </section>)}
        </main>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    ` } });
  if (engine === 'chromium') { measured = await launchMeasuredBrowser(resolveBrowserPath(), `o8-turn-reuse-${process.pid}`); browser = measured.browser; }
  else browser = await webkit.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 750 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/*', route => route.fulfill({ json: { groups: [], visualizations: [] } }));
  await page.setContent('<html><head><style>:root{--t-text:#eee;--t-text-secondary:#bbb;--t-text-muted:#aaa;--t-divider:#333;--t-accent:#89a;--cortex-chat-gutter:16px}body{background:#151515;color:#eee;font:14px system-ui}*{scrollbar-width:none}::-webkit-scrollbar{display:none}</style></head><body><div id="root"></div></body></html>');
  await page.addScriptTag({ content: built.outputFiles[0].text });
  await page.locator('[data-o8-message-id="s0-old-1"]').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // Each retained transcript must establish its real canvas/resize metrics
  // before measuring reuse, rather than counting first-visibility layout work.
  for (const index of [1,2,3,0]) { await page.getByRole('button', { name: 'Session ' + index, exact: true }).click(); await frames(); }
  const scroller = page.locator('[data-o8-chat-thread="fixture-session-0"]');
  await scroller.evaluate(element => { element.scrollTop = 300; });
  await page.locator('[data-session="0"] textarea').fill('Retained fixture draft');
  await page.locator('[data-session="0"] textarea').evaluate(element => element.setSelectionRange(2, 9));
  const initialScroll = await scroller.evaluate(element => element.scrollTop);
  const original = await scroller.elementHandle();
  const cdp = engine === 'chromium' ? await page.context().newCDPSession(page) : null;
  if (cdp) await cdp.send('Performance.enable');
  const taskTime = async () => cdp ? (await cdp.send('Performance.getMetrics')).metrics.find(value => value.name === 'TaskDuration').value * 1000 : null;
  for (let sample = 0; sample < 3; sample++) {
    await page.evaluate(() => { window.__transcriptRowRenders = {}; window.__reuseFrames = [];
      const epoch = window.__reuseEpoch = (window.__reuseEpoch ?? 0) + 1;
      let last = performance.now();
      const frame = now => { if (window.__reuseEpoch !== epoch) return;
        window.__reuseFrames.push(now - last); last = now; requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    });
    const before = await taskTime();
    const started = performance.now();
    for (const index of [1,0,2,0,3,0]) { await page.getByRole('button', { name: 'Session ' + index, exact: true }).click(); await frames(); }
    const after = await taskTime();
    const data = await page.evaluate(() => { window.__reuseEpoch++;
      return { closedRowRenders: Object.entries(window.__transcriptRowRenders).filter(([id]) => /-old-([0-9]+)$/.test(id) && Number(id.match(/-old-([0-9]+)$/)[1]) < 78).reduce((sum, [, count]) => sum + count, 0),
        framesOver34ms: window.__reuseFrames.filter(ms => ms > 34).length, maxFrameMs: Math.max(...window.__reuseFrames) };
    });
    observations.push({ sample, elapsedMs: performance.now() - started, taskMs: before === null ? null : after - before, ...data });
    if (Math.abs(await scroller.evaluate(element => element.scrollTop) - initialScroll) > 1) throw new Error('Transcript scroll moved');
  }
  const retained = await original.evaluate(element => element === document.querySelector('[data-o8-chat-thread="fixture-session-0"]'));
  const draftRetained = await page.locator('[data-session="0"] textarea').inputValue() === 'Retained fixture draft';
  const selectionRetained = await page.locator('[data-session="0"] textarea').evaluate(element => element.selectionStart === 2 && element.selectionEnd === 9);
  await page.waitForFunction(() => document.querySelector('[data-o8-message-id="s0-live"]')?.textContent.includes('Live session 0 tick'));
  if (option('screenshot', '')) await page.screenshot({ path: path.resolve(option('screenshot', '')) });
  const passed = !errors.length && retained && draftRetained && selectionRetained
    && (!expectReuse || observations.every(value => value.closedRowRenders === 0));
  const receipt = { engine, passed, expectReuse, forceInvalidation, retained, draftRetained, selectionRetained, observations, errors,
    medianTaskMs: percentile(observations.map(value => value.taskMs), 0.5),
    medianElapsedMs: percentile(observations.map(value => value.elapsedMs), 0.5),
    workload: { sessions: 4, entriesPerSession: 80, visibleCadenceMs: 50, hiddenCadenceMs: 1000, switchesPerSample: 6, samples: 3 },
    limits: 'Production transcript components with instrumented row bodies and fixture output. Existing interaction-harness browser ownership/statistics. Component visibility changes, not full dashboard subscriptions or native acceptance. WebKit TaskDuration is unavailable.' };
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log('[transcript-tab-reuse]', JSON.stringify(receipt));
  if (!passed) process.exitCode = 1;
} finally {
  if (errors.length) console.error('[transcript-tab-reuse] browser errors', JSON.stringify(errors));
  if (measured) await closeMeasuredBrowser(measured); else await browser?.close();
  await rm(directory, { recursive: true, force: true });
}

}
