import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeCodeStreamJsonParserEvent } from '@/lib/claude-code/stream-json-parser';

const fixture = vi.hoisted(() => ({ binary: '' }));
vi.mock('@/lib/runtimes/shared/cli-locate', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/cli-locate')>(),
  resolveClaudeBinary: () => fixture.binary,
}));

const { askClaudeOneShot } = await import('@/lib/claude-code/one-shot-repl');
const { askClaudeWarm, prewarmClaudeRepl, resetWarmReplPool } = await import('@/lib/claude-code/warm-repl-pool');
const { ensureSession, sendMessage, killSession } = await import('@/lib/claude-code/interactive-session');

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-stream-callers-'));
let caseDir = '';
let ordinal = 0;
let promptOrdinal = 0;
const tabs = new Set<string>();
type Caller = 'one-shot' | 'warm' | 'interactive';
type Outcome = { ok: true; text: string } | { ok: false; error: unknown };

// Real subprocess, fake protocol peer. It reads only synthetic stdin and files
// under its case directory. It never invokes a provider or reads account state.
function writePeer() {
  fixture.binary = path.join(caseDir, 'stream-peer.cjs');
  writeFileSync(fixture.binary, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const root = __dirname;
fs.writeFileSync(path.join(root, 'pid-' + process.pid), String(process.pid));
setTimeout(() => process.exit(70), 10000);
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(JSON.parse(line).message.content);
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } } });
  emit({ type: 'stream_event', event: { type: 'message_stop' } });
  emit({ type: 'system', subtype: 'compact_boundary' });
  emit({ type: 'message_stop' });
  fs.writeFileSync(path.join(root, request.id + '-stopped'), 'ready');
  const gate = setInterval(() => {
    if (!fs.existsSync(path.join(root, request.id + '-release'))) return;
    clearInterval(gate);
    if (request.mode === 'missing') return process.exit(0);
    const failed = request.mode.startsWith('failure');
    const result = { type: 'result', subtype: failed ? 'error_during_execution' : 'success',
      is_error: failed, result: failed ? 'synthetic failure payload' : 'complete-' + request.id,
      session_id: 'synthetic-session' };
    if (request.mode.endsWith('trailing')) {
      process.stdout.write(JSON.stringify(result), () => process.exit(0));
    } else emit(result);
  }, 10);
});
`);
  chmodSync(fixture.binary, 0o700);
}

beforeEach(() => {
  caseDir = path.join(root, `case-${++ordinal}`);
  mkdirSync(caseDir);
  vi.stubEnv('TMPDIR', caseDir);
  vi.stubEnv('TMP', caseDir);
  vi.stubEnv('TEMP', caseDir);
  writePeer();
});

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

afterEach(async () => {
  for (const tab of tabs) killSession(tab);
  tabs.clear();
  resetWarmReplPool();
  vi.unstubAllEnvs();
  const pids = readdirSync(caseDir).filter((name) => name.startsWith('pid-'))
    .map((name) => Number(readFileSync(path.join(caseDir, name), 'utf8')));
  await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 3_000 });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function request(mode: string) {
  const id = `turn-${++promptOrdinal}`;
  return {
    id,
    prompt: JSON.stringify({ id, mode }),
    waitForStop: () => vi.waitFor(() => expect(existsSync(path.join(caseDir, `${id}-stopped`))).toBe(true)),
    release: () => writeFileSync(path.join(caseDir, `${id}-release`), 'go'),
  };
}

function sessionFor(tabId = `test-tab-${ordinal}`) {
  tabs.add(tabId);
  return ensureSession(tabId, caseDir, 'synthetic-model');
}

function start(caller: Caller, prompt: string) {
  const events: ClaudeCodeStreamJsonParserEvent[] = [];
  const opts = { binary: fixture.binary, model: 'synthetic-model', timeoutMs: 5_000 };
  const session = caller === 'interactive' ? sessionFor() : null;
  const work = session
    ? sendMessage(session, prompt, (event) => events.push(event), { timeoutMs: 5_000 }).then(() => {
      const done = events.find((event) => event.type === 'done');
      return done?.type === 'done' ? done.text : '';
    })
    : caller === 'warm' ? askClaudeWarm(prompt, opts) : askClaudeOneShot(prompt, opts);
  let settled = false;
  const outcome: Promise<Outcome> = work.then(
    (text) => { settled = true; return { ok: true, text }; },
    (error: unknown) => { settled = true; return { ok: false, error }; },
  );
  return { outcome, events, session, isSettled: () => settled };
}

describe.skipIf(process.platform === 'win32')('terminal results through real stream callers', () => {
  for (const caller of ['one-shot', 'warm', 'interactive'] as const) {
    it.each(['success', 'success-trailing'])(`${caller} waits through message stops and compaction for %s`, async (mode) => {
      const r = request(mode);
      if (caller === 'warm') prewarmClaudeRepl(fixture.binary, 'synthetic-model');
      const turn = start(caller, r.prompt);
      await r.waitForStop();
      await delay(100);
      expect(turn.isSettled()).toBe(false);
      if (turn.session) expect(turn.session.status).toBe('busy');
      r.release();
      expect(await turn.outcome).toEqual({ ok: true, text: `complete-${r.id}` });
      if (turn.session && mode === 'success') expect(turn.session.status).toBe('ready');
    });

    it.each(['failure', 'failure-trailing', 'missing'])(`${caller} rejects %s instead of returning partial text`, async (mode) => {
      const r = request(mode);
      const turn = start(caller, r.prompt);
      await r.waitForStop();
      r.release();
      expect(await turn.outcome).toMatchObject({ ok: false, error: expect.any(Error) });
      expect(turn.events.some((event) => event.type === 'done')).toBe(false);
      if (turn.session && mode === 'failure') expect(turn.session.status).toBe('ready');
    });
  }

  it('reuses an interactive session after failure without replaying the previous turn', async () => {
    const failed = request('failure');
    const first = start('interactive', failed.prompt);
    await failed.waitForStop();
    failed.release();
    expect(await first.outcome).toMatchObject({ ok: false });
    const next = request('success');
    const second = start('interactive', next.prompt);
    expect(second.session?.proc.pid).toBe(first.session?.proc.pid);
    await next.waitForStop();
    expect(second.isSettled()).toBe(false);
    next.release();
    expect(await second.outcome).toEqual({ ok: true, text: `complete-${next.id}` });
    expect(second.events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(second.session?.sessionId).toBe('synthetic-session');
  });
});
