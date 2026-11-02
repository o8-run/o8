#!/usr/bin/env node
// Real dashboard and persisted history, with an owned, deterministic live turn.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { WebSocketServer } from 'ws';
import { buildFixturePlan, materializeFixture } from './interactions/fixtures.mjs';
import { resolveBrowserPath } from './measure-browser-boot.mjs';
import { freePort, healthy, launch, stop } from '../speed/common.mjs';

const evidence = process.env.O8_READING_POSITION_EVIDENCE
  ? path.resolve(process.env.O8_READING_POSITION_EVIDENCE) : fs.mkdtempSync(path.join(os.tmpdir(), 'o8-reading-proof-'));
fs.mkdirSync(evidence, { recursive: true });
const plan = buildFixturePlan(1, 5016);
plan.repos[0].defaultBranch = 'main';
plan.tabs = ['a', 'b'].map(name => ({ id: `reading-${name}`, label: `Reading ${name.toUpperCase()}`,
  kind: 'orchestrator', mode: 'fleet', orchestratorThreadId: `thoughts-reading-${name}` }));
const fixture = materializeFixture(plan);
const statePath = path.join(fixture.dataDir, 'terminal-states/tile-root.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.activeTabId = plan.tabs[0].id;
fs.writeFileSync(statePath, JSON.stringify(state));
for (const name of ['a', 'b']) {
  const messages = Array.from({ length: 240 }, (_, index) => ({ id: `${name}-${index}`, role: index % 2 ? 'assistant' : 'user',
    content: `Reading ${name.toUpperCase()} message ${index}.\n\n${'Keep this passage in view while reviewing the conversation. '.repeat(index % 2 ? 5 : 1)}`,
    timestamp: 1790812800000 + index * 10000 }));
  // The persisted shape after compaction retains narrative alongside its summary.
  messages.splice(160, 0, { id: `${name}-compaction`, role: 'system', content: 'Context compaction event', type: 'compaction',
    timestamp: 1790814395000, compaction: { source: 'summary', trigger: 'manual', timestamp: 1790814395000,
      compactedThroughId: `${name}-159`, summarizedMessageIds: messages.slice(0, 160).map(entry => entry.id),
      summary: 'Earlier requests and completed answers remain in chronological order.' } });
  for (const message of messages) {
    message.type ??= 'message';
    message.pinned = false;
    message.timestampLabel = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  fs.writeFileSync(path.join(fixture.dataDir, 'chat-history', `thoughts-reading-${name}.json`), JSON.stringify({
    title: `Reading ${name.toUpperCase()}`, repoPath: fixture.repoDir, repoName: fixture.repoNames[0],
    backend: 'claude', model: 'claude-code', savedAt: new Date().toISOString(), messages,
  }));
}
const token = 'reading-position-fixture-token-5016';
fs.writeFileSync(path.join(fixture.dataDir, 'ws-token'), token, { mode: 0o600 });
const apiPort = await freePort();
const socket = new WebSocketServer({ host: '127.0.0.1', port: await freePort() });
await new Promise(resolve => socket.once('listening', resolve));
const subscriptions = new Map();
let seq = 0;
let live = false;
const event = (ws, threadId, name, data) => ws.send(JSON.stringify({ channel: 'orchestrator', event: name,
  data: { threadId, repoPath: fixture.repoDir, backend: 'codex', ...data }, seq: ++seq }));
socket.on('connection', ws => {
  ws.on('close', () => subscriptions.delete(ws));
  ws.on('message', bytes => {
    const message = JSON.parse(String(bytes));
    if (message.type === 'ping') ws.send(JSON.stringify({ channel: 'pong', event: 'pong' }));
    if (message.type === 'orchestrator-subscribe') {
      subscriptions.set(ws, message.threadId);
      event(ws, message.threadId, 'status', { status: live ? 'busy' : 'ready', snapshot: true });
    }
  });
  ws.send(JSON.stringify({ channel: 'system', event: 'connected', data: { bootId: 'reading-fixture' } }));
});
const env = { ...process.env, NODE_ENV: 'development', O8_DATA_DIR: fixture.dataDir, CORTEX_IDE_DATA_DIR: fixture.dataDir,
  CORTEX_IDE_DB_PATH: path.join(fixture.dataDir, 'fixture.db'), CORTEX_IDE_REPO_ROOT: fixture.repoDir,
  PORT: String(apiPort), O8_API_PORT: String(apiPort), O8_WS_PORT: String(socket.address().port), WS_TOKEN: token };
for (const key of ['__NEXT_PRIVATE_STANDALONE_CONFIG', 'O8_PACKAGED_APP', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'CLERK_PUBLISHABLE_KEY', 'NODE_OPTIONS']) delete env[key];
const next = launch(['node_modules/next/dist/bin/next', 'dev', '-p', String(apiPort), '-H', '127.0.0.1'], env, path.join(evidence, 'next.log'));
let browser; let context;
const checks = [];
const errors = [];
try {
  await healthy(`http://127.0.0.1:${apiPort}/api/panel/status`, next, token);
  // Compile the real setup route before mounting its ten-second recovery gate.
  const setup = await fetch(`http://127.0.0.1:${apiPort}/api/setup/config`, { headers: { Authorization: `Bearer ${token}` } });
  const setupConfig = await setup.json();
  assert.equal(setupConfig.setupComplete, true);
  for (const name of ['a', 'b']) {
    const record = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'chat-history', `thoughts-reading-${name}.json`), 'utf8'));
    const seeded = await fetch(`http://127.0.0.1:${apiPort}/api/v2/chat-history`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tabId: `thoughts-reading-${name}`, ...record }) });
    assert.equal(seeded.status, 200);
    await seeded.arrayBuffer();
    const history = await fetch(`http://127.0.0.1:${apiPort}/api/v2/chat-history?tabId=thoughts-reading-${name}&limit=60`,
      { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(history.status, 200);
    await history.arrayBuffer();
  }
  for (const endpoint of ['/api/panel/projects', '/api/panel/repos', '/api/panel/workspaces',
    '/api/panel/terminal-state?scope=tile-root', '/api/panel/operator-defaults?include=values',
    '/api/panel/operator-defaults?include=presentation', '/api/panel/ws-info',
    '/api/v2/chat-history/list?include=orchestrator&archived=include', '/api/telemetry/config']) {
    const response = await fetch(`http://127.0.0.1:${apiPort}${endpoint}`, { headers: { Authorization: `Bearer ${token}` } });
    await response.arrayBuffer();
  }
  browser = await chromium.launch({ executablePath: resolveBrowserPath(), headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { Authorization: `Bearer ${token}` }, recordVideo: { dir: evidence, size: { width: 1440, height: 900 } } });
  await context.addInitScript(({ port, repoId }) => {
    Object.defineProperty(window, '__O8_WS_PORT__', { get: () => port, set: () => {}, configurable: true });
    sessionStorage.setItem('cortex-global-repo-id', repoId);
  }, { port: socket.address().port, repoId: fixture.repoNames[0] });
  // No provider discovery, prewarming or model calls are needed for a viewport regression.
  await context.route('**/api/runtime/inventory**', route => route.fulfill({ json: { agents: [] } }));
  await context.route('**/api/runtime/prewarm**', route => route.fulfill({ json: { ok: true } }));
  await context.route('**/api/setup/config', route => route.fulfill({ json: setupConfig }));
  await context.route('**/api/v2/chat-history**', async route => {
    try {
      const response = await route.fetch({ timeout: 60000 });
      await route.fulfill({ response });
    } catch {
      // Reload aborts an in-flight backfill request along with its old page.
      await route.abort('aborted').catch(() => {});
    }
  });
  const page = await context.newPage();
  page.on('requestfailed', request => fs.appendFileSync(path.join(evidence, 'network.log'),
    `${new URL(request.url()).pathname} ${request.failure()?.errorText}\n`));
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const row = id => page.locator(`[data-o8-message-id="${id}"]`).first();
  const scroller = name => page.locator(`[data-o8-chat-thread="thoughts-reading-${name}"]`).first();
  const position = id => row(id).evaluate(element => {
    const host = element.closest('.thoughts-scroll');
    const rect = element.getBoundingClientRect(); const bounds = host.getBoundingClientRect();
    return { id: element.getAttribute('data-o8-message-id'), offset: rect.top - bounds.top,
      visible: rect.bottom > bounds.top && rect.top < bounds.bottom, top: host.scrollTop, height: host.scrollHeight };
  });
  const check = (name, passed, detail) => {
    checks.push({ name, passed, detail });
    fs.writeFileSync(path.join(evidence, 'checks.json'), JSON.stringify(checks, null, 2));
    console.log(name, passed ? 'PASS' : 'FAIL', JSON.stringify(detail));
  };
  const reload = async name => {
    const deadline = Date.now() + 10000;
    while (JSON.parse(fs.readFileSync(statePath, 'utf8')).activeTabId !== `reading-${name}` && Date.now() < deadline) {
      await page.waitForTimeout(100);
    }
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).activeTabId, `reading-${name}`, 'active conversation must be persisted before reload');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 });
  };
  const loaded = async name => {
    try { await row(`${name}-200`).waitFor({ state: 'attached', timeout: 25000 }); }
    catch {
      // A cold development bundle can outlast history's six-second deadline.
      await reload(name);
      await row(`${name}-200`).waitFor({ state: 'attached', timeout: 60000 });
    }
    await frames(); await page.waitForTimeout(600);
    const deadline = Date.now() + 20000;
    while (![...subscriptions.values()].includes(`thoughts-reading-${name}`) && Date.now() < deadline) await page.waitForTimeout(50);
    assert([...subscriptions.values()].includes(`thoughts-reading-${name}`), 'fixture WebSocket must be subscribed before live output');
  };
  const read = async id => {
    await row(id).locator('xpath=ancestor::*[contains(@class, "thoughts-scroll")]').hover();
    await page.mouse.wheel(0, -1);
    await frames();
    await row(id).evaluate(element => {
      element.scrollIntoView({ block: 'start' });
      const host = element.closest('.thoughts-scroll');
      host.scrollTop -= 75;
      host.dispatchEvent(new Event('scroll'));
    });
    await frames(); await page.waitForTimeout(500);
    return position(id);
  };
  const bottom = async name => {
    await scroller(name).hover();
    await page.mouse.wheel(0, 100000);
    await page.waitForTimeout(300);
    await frames();
  };
  const atBottom = name => scroller(name).evaluate(element => ({ gap: element.scrollHeight - element.scrollTop - element.clientHeight }));
  await page.goto(`http://127.0.0.1:${apiPort}/dashboard`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await loaded('a');
  const before = await read('a-200');
  await page.screenshot({ path: path.join(evidence, 'before-reload.png') });
  await reload('a');
  await loaded('a');
  const after = await position('a-200');
  await page.screenshot({ path: path.join(evidence, 'after-reload.png') });
  check('reload keeps the same compacted-history message and offset', before.visible && after.visible && Math.abs(after.offset - before.offset) < 5, { before, after });
  assert(checks[0].passed, 'Reload moved the reading anchor');
  const readingA = await read('a-210');
  await page.locator('[data-o8-workspace-tab="reading-b"]').first().click();
  await loaded('b');
  const readingB = await read('b-220');
  await page.locator('[data-o8-workspace-tab="reading-a"]').first().click(); await loaded('a');
  const returnedA = await position('a-210');
  check('switching chats keeps A position', returnedA.visible && Math.abs(readingA.offset - returnedA.offset) < 5, { readingA, returnedA });
  await page.locator('[data-o8-workspace-tab="reading-b"]').first().click(); await loaded('b');
  const returnedB = await position('b-220');
  check('switching chats keeps B position', returnedB.visible && Math.abs(readingB.offset - returnedB.offset) < 5, { readingB, returnedB });
  await reload('b'); await loaded('b');
  check('reload keeps B independent of A', (await position('b-220')).visible, await position('b-220'));
  await bottom('b');
  await reload('b'); await loaded('b');
  check('bottom reader reopens at bottom', (await atBottom('b')).gap <= 4, await atBottom('b'));
  live = true;
  const emit = (name, data) => { for (const [ws, thread] of subscriptions) if (thread === 'thoughts-reading-b') event(ws, thread, name, data); };
  emit('status', { status: 'busy' });
  for (let index = 0; index < 12; index++) {
    emit('output', { assistantMessageId: 'reading-live', text: `Live output ${index}. ${'Follow the growing answer. '.repeat(8)}\n\n` });
    await page.waitForTimeout(120);
  }
  await row('reading-live').waitFor({ state: 'attached' }); await page.waitForTimeout(1000);
  check('live turn follows the bottom', (await atBottom('b')).gap <= 4, await atBottom('b'));
  const duringLive = await read('b-220');
  for (let index = 12; index < 20; index++) {
    emit('output', { assistantMessageId: 'reading-live', text: `Live output ${index}. ${'Keep the reader on history. '.repeat(8)}\n\n` });
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(700);
  const liveAfter = await position('b-220');
  check('live turn preserves a history reader', liveAfter.visible && Math.abs(liveAfter.offset - duringLive.offset) < 5, { duringLive, liveAfter });
  await reload('b'); await loaded('b');
  const liveReload = await position('b-220');
  check('reload during a live turn keeps a history reader', liveReload.visible && Math.abs(liveReload.offset - liveAfter.offset) < 5, { liveAfter, liveReload });
  await bottom('b');
  emit('output', { assistantMessageId: 'reading-live', text: '\n\nReturned to the bottom.\n\n'.repeat(10) });
  await page.waitForTimeout(1000);
  check('returning to bottom resumes following', (await atBottom('b')).gap <= 4, await atBottom('b'));
  await reload('b'); await loaded('b');
  emit('output', { assistantMessageId: 'reading-live-after-reload', text: 'Output continues after reload.\n\n'.repeat(30) });
  await row('reading-live-after-reload').waitFor({ state: 'attached' }); await page.waitForTimeout(1000);
  check('reload during a live turn keeps bottom following', (await atBottom('b')).gap <= 4, await atBottom('b'));
  const storedPositions = () => page.evaluate(() => Object.keys(localStorage)
    .filter(key => key.startsWith('o8:transcript-reading:v1:'))
    .map(key => ({ key, record: JSON.parse(localStorage.getItem(key)) })));
  await page.locator('[data-o8-workspace-tab="reading-a"]').first().click(); await loaded('a');
  await read('a-210');
  const aSaved = (await storedPositions()).find(item => JSON.parse(item.key.slice('o8:transcript-reading:v1:'.length))[2] === 'thoughts-reading-a');
  assert(aSaved?.record.anchor?.rows.length);
  const missingIds = aSaved.record.anchor.rows.map(row => row.id);
  const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const historyUrl = `http://127.0.0.1:${apiPort}/api/v2/chat-history`;
  const full = await fetch(`${historyUrl}?tabId=thoughts-reading-a`, { headers }).then(response => response.json());
  const surviving = full.messages.filter(message => !missingIds.includes(message.id));
  const savedIndex = full.messages.findIndex(message => message.id === missingIds[0]);
  const expectedNeighbor = surviving[Math.min(savedIndex, surviving.length - 1)].id;
  const replaced = await fetch(historyUrl, { method: 'POST', headers,
    body: JSON.stringify({ ...full, tabId: 'thoughts-reading-a', replace: true, messages: surviving }) });
  assert.equal(replaced.status, 200); await replaced.arrayBuffer();
  const readback = await fetch(`${historyUrl}?tabId=thoughts-reading-a`, { headers }).then(response => response.json());
  assert(readback.messages.every(message => !missingIds.includes(message.id)));
  await reload('a'); await loaded('a'); await page.waitForTimeout(1000);
  const neighbor = await position(expectedNeighbor);
  const settled = (await storedPositions()).find(item => item.key === aSaved.key)?.record;
  check('missing anchor resolves to its saved-order neighbor and retires stale identities', neighbor.visible
    && settled?.anchor?.rows.length > 0
    && settled.anchor.rows.every(row => surviving.some(message => message.id === row.id)), { missingIds, expectedNeighbor, neighbor, settled });
  const resumed = await read('a-220');
  const resumedStore = (await storedPositions()).find(item => item.key === aSaved.key)?.record;
  check('ordinary scrolling saves again after a missing-anchor fallback', Math.abs(resumedStore.top - resumed.top) < 2, { resumed, resumedStore });

  // The sidebar owns the real confirmation and DELETE route. Delete B while
  // inactive, then A while active, and check teardown cannot recreate either.
  for (const name of ['b', 'a']) {
    const deleted = page.waitForResponse(response => response.request().method() === 'DELETE'
      && response.url().includes(`/api/v2/chat-history?tabId=thoughts-reading-${name}`));
    await page.getByRole('button', { name: new RegExp(`^Reading ${name.toUpperCase()} ·`) }).first().click({ button: 'right' });
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').filter({ hasText: 'from chat history?' }).waitFor();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    assert.equal((await deleted).status(), 200);
    await page.waitForTimeout(800);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    const leftovers = (await storedPositions()).filter(item => JSON.parse(item.key.slice('o8:transcript-reading:v1:'.length))[2] === `thoughts-reading-${name}`);
    check(`deleting ${name === 'b' ? 'inactive' : 'active'} chat removes its reading records`, leftovers.length === 0
      && !fs.existsSync(path.join(fixture.dataDir, 'chat-history', `thoughts-reading-${name}.json`)), { leftovers });
  }
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 }); await page.waitForTimeout(1000);
  const leftovers = (await storedPositions()).filter(item => ['thoughts-reading-a', 'thoughts-reading-b']
    .includes(JSON.parse(item.key.slice('o8:transcript-reading:v1:'.length))[2]));
  check('deleted reading records stay absent after reload and unmount', leftovers.length === 0, leftovers);
  check('dashboard has no uncaught errors', errors.length === 0, errors);
  await page.waitForTimeout(500);
  fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ checks, apiPort, wsPort: socket.address().port,
    messagesPerThread: 241, summarizedMessages: 160, errors, limits: 'Real dashboard, persisted paginated history, authored post-compaction fixture and deterministic WebSocket turn. No model or native app.' }, null, 2));
  assert(checks.every(value => value.passed), 'Reading-position dashboard regression failed');
} catch (error) {
  const page = context?.pages()[0];
  if (page) {
    await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(evidence, 'failure.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable'));
  }
  throw error;
} finally {
  await context?.close(); await browser?.close();
  for (const ws of socket.clients) ws.terminate();
  await new Promise(resolve => socket.close(resolve));
  await stop(next);
  fs.rmSync(fixture.dataDir, { recursive: true, force: true });
}
