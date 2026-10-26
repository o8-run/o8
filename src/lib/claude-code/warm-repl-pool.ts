import { childEnvironment } from '@/lib/providers/spawn-environment';
import { credentialPolicyFingerprint } from '@/lib/providers/credential-policy';
import { providerSpawnEnvironment } from '@/lib/providers/spawn-environment';
/**
 * Warm REPL pool for brain Q&A `claude` spawns (2026-06-11 brain perf pass).
 *
 * The one-shot REPL (#1124) spawns a fresh `claude --input-format stream-json`
 * process per call — measured 6-9s of bootstrap inside the packaged app before
 * the model even runs, paid TWICE per uncached question (classify + compose).
 * This pool pre-pays that bootstrap in the background:
 *
 *   - Processes are SINGLE-USE: each serves exactly one prompt, then dies.
 *     No conversation state ever bleeds between questions — semantics are
 *     identical to the one-shot, only the spawn timing moves.
 *   - After a proc is taken, a replacement is spawned in the background so
 *     the next question finds a warm one (bootstrap overlaps user think-time).
 *   - QA spawns add `--strict-mcp-config` with an empty config: the brain
 *     never uses tools, and skipping the user's global MCP servers saves
 *     ~1.1s per spawn (measured) and stops forking MCP children per question.
 *   - Billing is unchanged: same no-`-p` REPL flags, subscription pool
 *     (#1066/#1124 guard still applies via buildOneShotArgs).
 *
 * Guardrails (this pool is also a abuse bound, not just a speedup):
 *   - MAX_LIVE_PROCS caps every live `claude` this module owns (idle + busy).
 *     Before the pool, a looping agent could fork unbounded processes.
 *   - TURN_CONCURRENCY gates simultaneous turns; excess callers queue FIFO
 *     and give up when their own timeout expires.
 *   - Idle procs are reaped after IDLE_REAP_MS so an unused brain costs zero.
 */

import 'server-only';

import { spawn, type ChildProcessWithoutNullStreams } from '@/lib/providers/child-process';
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { buildOneShotArgs } from './one-shot-repl';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import {
  createClaudeCodeStreamJsonParser,
  type ClaudeCodeStreamJsonParserEvent,
} from './stream-json-parser';

const MAX_IDLE_PER_KEY = 1;
const MAX_LIVE_PROCS = 4;
const TURN_CONCURRENCY = 3;
const IDLE_REAP_MS = 10 * 60_000;

// ── Empty MCP config (written once per process) ──────────────────────────────

let emptyMcpConfigPath: string | null = null;

function getEmptyMcpConfigPath(): string | null {
  if (emptyMcpConfigPath) return emptyMcpConfigPath;
  try {
    const p = join(os.tmpdir(), `o8-qa-empty-mcp-${process.pid}.json`);
    writeFileSync(p, '{"mcpServers":{}}', 'utf8');
    emptyMcpConfigPath = p;
  } catch {
    emptyMcpConfigPath = null; // spawn without the strip — slower, still correct
  }
  return emptyMcpConfigPath;
}

// ── Warm process bookkeeping ──────────────────────────────────────────────────

interface WarmProc {
  child: ChildProcessWithoutNullStreams;
  /** Parsed events that arrived before a consumer attached. */
  buffered: ClaudeCodeStreamJsonParserEvent[];
  /** Consumer notification — set while a turn is draining events. */
  onEvent: ((evt: ClaudeCodeStreamJsonParserEvent) => void) | null;
  onClose: ((code: number | null, signal: string | null) => void) | null;
  dead: boolean;
  spawnedAt: number;
  reapTimer: ReturnType<typeof setTimeout> | null;
  flushParser: () => ClaudeCodeStreamJsonParserEvent[];
  stderr: string;
}

const idlePools = new Map<string, WarmProc[]>();
let liveProcCount = 0;

function poolKey(binary: string, model: string, effort?: string): string {
  // No-effort callers key EXACTLY as before (byte-identical) so their warm
  // hits are unaffected; an effort'd proc gets a distinct key so it can never
  // be handed to a no-effort caller.
  return `${binary}\x00${model}\x00${effort ?? ''}\x00${credentialPolicyFingerprint('claude-code')}`;
}

function spawnWarmProc(binary: string, model: string, effort?: string): WarmProc | null {
  if (liveProcCount >= MAX_LIVE_PROCS) return null;

  const args = [...buildOneShotArgs(model, effort)];
  const mcpStrip = getEmptyMcpConfigPath();
  if (mcpStrip) args.push('--strict-mcp-config', '--mcp-config', mcpStrip);

  let child: ChildProcessWithoutNullStreams;
  try {
    const launch = cliInvocation(binary, args);
    child = spawn(launch.command, launch.args, {
      windowsHide: true,
      cwd: os.tmpdir(),
      env: providerSpawnEnvironment(childEnvironment({ runtimeId: 'claude-code', env: { FORCE_COLOR: '0', NO_COLOR: '1', O8_MANAGED_SESSION: '1' } }), { runtimeId: 'claude-code' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }

  liveProcCount += 1;
  const parser = createClaudeCodeStreamJsonParser();

  const proc: WarmProc = {
    child,
    buffered: [],
    onEvent: null,
    onClose: null,
    dead: false,
    spawnedAt: Date.now(),
    reapTimer: null,
    flushParser: () => parser.flush(),
    stderr: '',
  };

  child.stdout.on('data', (chunk: Buffer) => {
    for (const evt of parser.pushChunk(chunk.toString('utf8'))) {
      if (proc.onEvent) proc.onEvent(evt);
      else proc.buffered.push(evt);
    }
  });
  // Keep a bounded diagnostic for workers that reject arguments before a result.
  child.stderr.on('data', (chunk: Buffer) => { proc.stderr = (proc.stderr + chunk.toString('utf8')).slice(-4_096); });
  child.on('error', () => { markDead(proc); });
  child.on('close', (code, signal) => {
    markDead(proc);
    proc.onClose?.(code, signal ?? null);
  });

  return proc;
}

function markDead(proc: WarmProc): void {
  if (proc.dead) return;
  proc.dead = true;
  liveProcCount = Math.max(0, liveProcCount - 1);
  if (proc.reapTimer) clearTimeout(proc.reapTimer);
  // If it died while idle, drop it from its pool eagerly.
  for (const procs of idlePools.values()) {
    const idx = procs.indexOf(proc);
    if (idx !== -1) procs.splice(idx, 1);
  }
}

function killProc(proc: WarmProc): void {
  try { proc.child.kill(); } catch { /* already dead */ }
  markDead(proc);
}

/** Add one idle proc for `key` if below the idle/live caps. */
function refill(binary: string, model: string, effort?: string): void {
  const key = poolKey(binary, model, effort);
  const pool = idlePools.get(key) ?? [];
  idlePools.set(key, pool);
  if (pool.length >= MAX_IDLE_PER_KEY) return;

  const proc = spawnWarmProc(binary, model, effort);
  if (!proc) return;
  pool.push(proc);
  proc.reapTimer = setTimeout(() => {
    const idx = pool.indexOf(proc);
    if (idx !== -1) {
      pool.splice(idx, 1);
      killProc(proc);
      console.info(`[qa][warm-repl] reaped idle ${model} proc after ${IDLE_REAP_MS / 60_000}min`);
    }
  }, IDLE_REAP_MS);
  proc.reapTimer.unref?.();
  console.info(`[qa][warm-repl] pre-warming ${model} (live=${liveProcCount})`);
}

/** Pop a healthy idle proc for `key`, or null. */
function takeIdle(binary: string, model: string, effort?: string): WarmProc | null {
  const pool = idlePools.get(poolKey(binary, model, effort));
  while (pool && pool.length > 0) {
    const proc = pool.shift()!;
    if (proc.reapTimer) clearTimeout(proc.reapTimer);
    if (!proc.dead && proc.child.exitCode === null) return proc;
    killProc(proc);
  }
  return null;
}

// ── Turn concurrency gate ─────────────────────────────────────────────────────

let activeTurns = 0;
const turnWaiters: Array<() => void> = [];

async function acquireTurnSlot(timeoutMs: number): Promise<() => void> {
  if (activeTurns < TURN_CONCURRENCY) {
    activeTurns += 1;
    return release;
  }
  await new Promise<void>((resolve, reject) => {
    const waiter = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      const idx = turnWaiters.indexOf(waiter);
      if (idx !== -1) turnWaiters.splice(idx, 1);
      reject(new Error(`[qa][warm-repl] no turn slot within ${timeoutMs}ms (${activeTurns} active)`));
    }, timeoutMs);
    turnWaiters.push(waiter);
  });
  activeTurns += 1;
  return release;

  function release(): void {
    activeTurns = Math.max(0, activeTurns - 1);
    const next = turnWaiters.shift();
    if (next) next();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface AskClaudeWarmOptions {
  /** Explicit `claude` binary path. Caller resolves; we don't probe. */
  binary: string;
  /** Model arg passed via `--model`. */
  model: string;
  /**
   * Optional reasoning effort passed via `--effort` (skipped when unset or
   * 'adaptive'). Also keys the pool, so an effort'd proc is never handed to a
   * no-effort caller (and no-effort callers key exactly as before).
   */
  effort?: string;
  /** Whole-turn timeout (slot wait + generation). Default 300s. */
  timeoutMs?: number;
  /** Streaming hook — called with each text delta as the model generates. */
  onDelta?: (text: string) => void;
  /**
   * Live policy consulted at the moment of the speculative replacement refill.
   * The requested proc (warm hit or cold spawn) is always served — this only
   * decides whether to pre-spawn the NEXT idle proc. Omitting it keeps the
   * pre-#2521 "always refill" behavior for non-Brain callers; Brain adapters
   * pass a predicate so an opt-out (or a managed-only route) landing while a
   * call is queued suppresses the replacement.
   */
  refillPolicy?: () => boolean;
}

/**
 * Fire-and-forget: make sure a warm proc exists for this binary+model so the
 * next `askClaudeWarm` skips the bootstrap. Safe to call on every question.
 */
export function prewarmClaudeRepl(binary: string, model: string, effort?: string): void {
  try { refill(binary, model, effort); } catch { /* never block the pipeline on warm-up */ }
}

/**
 * One-shot turn against a (preferably pre-warmed) REPL proc. Identical
 * semantics to `askClaudeOneShot` — one user frame in, full text out, proc
 * torn down after — plus optional `onDelta` streaming.
 */
export async function askClaudeWarm(prompt: string, opts: AskClaudeWarmOptions): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const releaseSlot = await acquireTurnSlot(timeoutMs);

  let proc = takeIdle(opts.binary, opts.model, opts.effort);
  const warm = proc !== null;
  if (proc) {
    console.info(`[qa][warm-repl] warm hit for ${opts.model} (age ${((Date.now() - proc.spawnedAt) / 1000).toFixed(1)}s)`);
  } else {
    proc = spawnWarmProc(opts.binary, opts.model, opts.effort);
    if (!proc) {
      releaseSlot();
      throw new Error(`[qa][warm-repl] live-proc cap reached (${MAX_LIVE_PROCS}) — refusing to spawn`);
    }
    console.info(`[qa][warm-repl] cold spawn for ${opts.model} (live=${liveProcCount})`);
  }

  // Replace the proc we just consumed so the NEXT question finds a warm one.
  // Done before the turn runs: the replacement bootstraps while we generate.
  // Only when the caller's live policy still permits speculative warmup — the
  // predicate is evaluated HERE, after any queue wait, so an opt-out that lands
  // while a call is queued wins (#2521). Non-Brain callers omit the policy and
  // keep the pre-#2521 behavior.
  if (!opts.refillPolicy || opts.refillPolicy()) {
    refill(opts.binary, opts.model, opts.effort);
  }

  try {
    return await runTurn(proc, prompt, timeoutMs, warm, opts.onDelta);
  } finally {
    killProc(proc);
    releaseSlot();
  }
}

function runTurn(
  proc: WarmProc,
  prompt: string,
  timeoutMs: number,
  warm: boolean,
  onDelta?: (text: string) => void,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let deltaText = '';
    let settled = false;

    const finish = (err: Error | null, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve((text ?? '').trim());
    };

    const timer = setTimeout(() => {
      finish(new Error(`[qa][warm-repl] timed out after ${timeoutMs}ms (${warm ? 'warm' : 'cold'})`));
    }, timeoutMs);

    const handleEvent = (evt: ClaudeCodeStreamJsonParserEvent) => {
      if (evt.type === 'delta') {
        deltaText += evt.text;
        onDelta?.(evt.text);
      } else if (evt.type === 'done') {
        finish(evt.isError ? new Error(evt.text.trim() || proc.stderr.trim() || 'Worker returned a failed result.') : null, evt.text || deltaText);
      }
    };

    // Drain anything that arrived while the proc idled (init banners etc.),
    // then attach live.
    for (const evt of proc.buffered) handleEvent(evt);
    proc.buffered.length = 0;
    proc.onEvent = handleEvent;
    proc.onClose = (code, signal) => {
      // The parser may hold a trailing unterminated line containing `done`.
      for (const evt of proc.flushParser()) handleEvent(evt);
      if (settled) return;
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      finish(new Error(proc.stderr.trim() || `[qa][warm-repl] exited before result (${suffix})`));
    };

    if (proc.dead || proc.child.exitCode !== null) {
      finish(new Error(proc.stderr.trim() || '[qa][warm-repl] proc died before the turn started'));
      return;
    }

    const payload = `${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`;
    try {
      proc.child.stdin.write(payload, 'utf8', (writeErr?: Error | null) => {
        if (writeErr) finish(writeErr);
        else proc.child.stdin.end();
      });
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Test-only: kill everything and reset counters. */
export function resetWarmReplPool(): void {
  for (const pool of idlePools.values()) {
    for (const proc of [...pool]) killProc(proc);
    pool.length = 0;
  }
  idlePools.clear();
  liveProcCount = 0;
  activeTurns = 0;
  turnWaiters.length = 0;
}

/** Test-only queue snapshot for deterministic admission assertions. */
export function getWarmReplPoolTestState(): { activeTurns: number; queuedTurns: number } {
  return { activeTurns, queuedTurns: turnWaiters.length };
}
