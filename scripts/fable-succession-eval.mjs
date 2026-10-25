#!/usr/bin/env node
/**
 * Fable succession eval (2026-07-02, expires with Fable on 2026-07-07).
 *
 * Runs REAL o8 adjudications — operator approval cards from ~/.o8/cortex-ide.db,
 * each a compact (~1KB artifact → APPROVE/REJECT) pair — through claude-fable-5
 * AND claude-opus-4-8, and measures disagreement. The number this produces
 * (Fable↔Opus decision-agreement on real o8 artifacts) tells us how much
 * judge-panel scaffolding the post-Fable window needs. Only measurable while
 * both models exist.
 *
 * Transports:
 *   --transport cli  (default) one-shot `claude` REPL spawns — Max-subscription
 *                    billed, $0 marginal. Mirrors o8's one-shot-repl.ts pattern
 *                    (stream-json in/out, NEVER `-p`/`--print` — #1066).
 *   --transport api  direct /v1/messages with O8_FABLE_ANTHROPIC_API_KEY —
 *                    exact token metering, temperature 0. Needs credits.
 *
 * Usage:
 *   node scripts/fable-succession-eval.mjs --dry-run
 *   node scripts/fable-succession-eval.mjs --limit 30
 *   node scripts/fable-succession-eval.mjs --transport api --limit 30
 */

import { execFileSync, spawn, childEnvironment } from './lib/runtime-payer.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildApprovalAdjudicationPromptV1 as buildPrompt,
  buildCachedApprovalAdjudicationPartsV1 as buildCachedParts,
} from '../src/lib/prompts/v1/approval-adjudication.mjs';

const ARGS = process.argv.slice(2);
const flag = (name) => ARGS.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = ARGS.indexOf(`--${name}`);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : fallback;
};

const TRANSPORT = opt('transport', 'cli');
// --cached (api transport only): stable doctrine prefix as a cache_control
// system block. First call per model writes the cache (1.25x), the rest read
// it at 0.1x — the production window shape.
const CACHED = flag('cached');
const LIMIT = Number(opt('limit', '30'));
const CONCURRENCY = Number(opt('concurrency', '4'));
const DRY_RUN = flag('dry-run');
const MODELS = opt('models', 'claude-fable-5,claude-opus-4-8').split(',');
const DB = join(homedir(), '.o8', 'cortex-ide.db');
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'research', 'fable-succession');
// Hard spend ceiling for the API transport (input+output, rough premium pricing).
const API_MAX_CALLS = Number(opt('max-api-calls', '80'));

// ── 1. Load real adjudication pairs ──────────────────────────────────────────

function scrubVerdictLeakage(text) {
  return (text || '')
    // "Approved. 2 findings:" / "Rejected: ..." verdict prefixes
    .replace(/^\s*(approved|rejected|changes requested)[.:]?\s*/i, '')
    // "[note/accepted]" resolution halves inside finding tags
    .replace(/\[(\w+)\/(accepted|rejected|fixed|dismissed)\]/gi, '[$1]');
}

function loadPairs() {
  const rows = JSON.parse(execFileSync('sqlite3', ['-json', DB,
    `SELECT id, source, runtime, title, description, summary, risk, tool_name, command, status
     FROM approvals WHERE status IN ('approved','rejected') ORDER BY created_at DESC;`,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }) || '[]');

  const seenShape = new Map(); // title-group → count (cap 3 per family so one card type can't dominate)
  const pairs = [];
  for (const row of rows) {
    const family = row.title.slice(0, 30);
    const used = seenShape.get(family) ?? 0;
    if (used >= 3 && row.title !== 'Orchestrator review') continue;
    if (row.title === 'Orchestrator review' && used >= 6) continue;

    const description = scrubVerdictLeakage(row.description).slice(0, 700);
    const summary = scrubVerdictLeakage(row.summary).slice(0, 200);
    // Skip artifacts that still telegraph the verdict after scrubbing.
    if (/^(approved|rejected)\b/i.test(description)) continue;

    seenShape.set(family, used + 1);
    pairs.push({
      id: row.id,
      operatorDecision: row.status.toUpperCase() === 'APPROVED' ? 'APPROVE' : 'REJECT',
      artifact: [
        `KIND: ${row.title}`,
        `SOURCE: ${row.source} / runtime ${row.runtime}`,
        `RISK: ${row.risk}`,
        row.tool_name ? `TOOL: ${row.tool_name}` : null,
        row.command ? `COMMAND: ${String(row.command).slice(0, 200)}` : null,
        `SUMMARY: ${summary}`,
        `DETAIL: ${description}`,
      ].filter(Boolean).join('\n'),
    });
  }

  // Balance: interleave rejects through the list, then cap at LIMIT.
  const approves = pairs.filter((p) => p.operatorDecision === 'APPROVE');
  const rejects = pairs.filter((p) => p.operatorDecision === 'REJECT');
  const balanced = [];
  const rApp = Math.max(1, Math.round(approves.length / Math.max(1, rejects.length)));
  let a = 0, r = 0;
  while ((a < approves.length || r < rejects.length) && balanced.length < LIMIT) {
    for (let k = 0; k < rApp && a < approves.length && balanced.length < LIMIT; k++) balanced.push(approves[a++]);
    if (r < rejects.length && balanced.length < LIMIT) balanced.push(rejects[r++]);
  }
  return balanced;
}

// ── 2. Transports ─────────────────────────────────────────────────────────────

const NATIVE_DENY = ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'];

function askViaCli(prompt, model) {
  const bin = process.env.O8_CLAUDE_BIN || 'claude';
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'bypassPermissions',
    '--include-partial-messages',
    '--model', model,
    '--disallowedTools', ...NATIVE_DENY, // decision purity — mirrors the fable window
  ];
  if (args.includes('-p') || args.includes('--print')) throw new Error('print flag forbidden (#1066)');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: tmpdir(), // NOT the repo — avoids loading .mcp.json / repo settings
      env: childEnvironment({ runtimeId: 'claude-code', env: { FORCE_COLOR: '0', NO_COLOR: '1', O8_MANAGED_SESSION: '1' } }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* dead */ }
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`cli timeout (${model})`)), 180_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.type === 'result') {
          const usage = evt.usage ?? {};
          finish(null, {
            text: String(evt.result ?? '').trim(),
            inputTokens: usage.input_tokens ?? null,
            outputTokens: usage.output_tokens ?? null,
            costUsd: evt.total_cost_usd ?? null,
          });
        }
      }
    });
    child.on('error', (err) => finish(err));
    child.on('close', () => finish(new Error(`cli closed without result (${model})`)));
    child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } })}\n`);
  });
}

let apiCalls = 0;
async function askViaApi(prompt, model, cachedArtifact) {
  const key = process.env.O8_FABLE_ANTHROPIC_API_KEY || readEnvLocalKey();
  if (!key) throw new Error('O8_FABLE_ANTHROPIC_API_KEY not set');
  if (++apiCalls > API_MAX_CALLS) throw new Error(`api call ceiling hit (${API_MAX_CALLS})`);
  // No explicit temperature — thinking-enabled models (fable-5) reject temp!=1.
  // max_tokens leaves room for thinking blocks before the 3-line decision.
  const body = cachedArtifact !== undefined
    ? (() => {
        const parts = buildCachedParts(cachedArtifact);
        return { model, max_tokens: 1500, system: parts.system, messages: [{ role: 'user', content: parts.user }] };
      })()
    : { model, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] };
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`api ${res.status}: ${data?.error?.message ?? 'unknown'}`);
  return {
    text: (data.content ?? []).map((b) => b.text ?? '').join('').trim(),
    inputTokens: data.usage?.input_tokens ?? null,
    outputTokens: data.usage?.output_tokens ?? null,
    cacheCreationTokens: data.usage?.cache_creation_input_tokens ?? null,
    cacheReadTokens: data.usage?.cache_read_input_tokens ?? null,
    costUsd: null,
  };
}

function readEnvLocalKey() {
  try {
    const envLocal = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local'), 'utf8');
    return envLocal.match(/^O8_FABLE_ANTHROPIC_API_KEY=(.+)$/m)?.[1]?.trim() ?? null;
  } catch { return null; }
}

// ── 4. Run + score ────────────────────────────────────────────────────────────

function parseDecision(text) {
  const decision = text.match(/DECISION:\s*(APPROVE|REJECT)/i)?.[1]?.toUpperCase() ?? null;
  const confidence = Number(text.match(/CONFIDENCE:\s*(\d{1,3})/i)?.[1] ?? NaN);
  const why = text.match(/WHY:\s*(.+)/i)?.[1]?.trim() ?? '';
  return { decision, confidence: Number.isFinite(confidence) ? confidence : null, why };
}

async function pool(items, worker, size) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }));
  return results;
}

async function main() {
  const pairs = loadPairs();
  console.log(`[eval] ${pairs.length} pairs (${pairs.filter((p) => p.operatorDecision === 'APPROVE').length} approve / ${pairs.filter((p) => p.operatorDecision === 'REJECT').length} reject) · transport=${TRANSPORT} · models=${MODELS.join(' vs ')}`);
  if (DRY_RUN) {
    for (const p of pairs) console.log(`  - [${p.operatorDecision}] ${p.artifact.split('\n')[0]} (${p.artifact.length} chars)`);
    console.log(`[eval] dry run — would make ${pairs.length * MODELS.length} calls`);
    return;
  }

  const ask = TRANSPORT === 'api' ? askViaApi : askViaCli;
  const useCache = CACHED && TRANSPORT === 'api';
  // Prime the cache serially (one call per model) so concurrent calls don't
  // race the cache write and all bill cache_creation at 1.25x.
  if (useCache) {
    for (const model of MODELS) {
      try {
        const prime = await askViaApi('', model, pairs[0].artifact);
        console.log(`[eval] cache primed for ${model}: creation=${prime.cacheCreationTokens} read=${prime.cacheReadTokens}`);
      } catch (err) {
        console.log(`[eval] cache prime failed for ${model}: ${err.message}`);
      }
    }
  }
  const jobs = pairs.flatMap((pair) => MODELS.map((model) => ({ pair, model })));
  let done = 0;
  const raw = await pool(jobs, async (job) => {
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await ask(buildPrompt(job.pair.artifact), job.model, useCache ? job.pair.artifact : undefined);
        break;
      } catch (err) {
        if (attempt === 1) result = { text: `ERROR: ${err.message}`, inputTokens: null, outputTokens: null, costUsd: null };
      }
    }
    done += 1;
    process.stdout.write(`\r[eval] ${done}/${jobs.length} calls`);
    return { pairId: job.pair.id, model: job.model, ...result, ...parseDecision(result.text) };
  }, CONCURRENCY);
  console.log('');

  // Score
  const byPair = new Map();
  for (const r of raw) {
    if (!byPair.has(r.pairId)) byPair.set(r.pairId, {});
    byPair.get(r.pairId)[r.model] = r;
  }
  const [mA, mB] = MODELS;
  let both = 0, agree = 0, aMatchesOp = 0, bMatchesOp = 0, scored = 0;
  const rows = [];
  for (const pair of pairs) {
    const res = byPair.get(pair.id) ?? {};
    const a = res[mA], b = res[mB];
    const row = {
      id: pair.id,
      operator: pair.operatorDecision,
      [mA]: a?.decision ?? 'ERROR',
      [`${mA}-conf`]: a?.confidence ?? null,
      [mB]: b?.decision ?? 'ERROR',
      [`${mB}-conf`]: b?.confidence ?? null,
      whyA: a?.why ?? '', whyB: b?.why ?? '',
    };
    rows.push(row);
    if (a?.decision && b?.decision) {
      both += 1;
      if (a.decision === b.decision) agree += 1;
    }
    if (a?.decision) { scored += 1; if (a.decision === pair.operatorDecision) aMatchesOp += 1; }
    if (b?.decision && b.decision === pair.operatorDecision) bMatchesOp += 1;
  }

  const tokens = raw.reduce((acc, r) => ({
    in: acc.in + (r.inputTokens ?? 0),
    out: acc.out + (r.outputTokens ?? 0),
    cacheCreated: acc.cacheCreated + (r.cacheCreationTokens ?? 0),
    cacheRead: acc.cacheRead + (r.cacheReadTokens ?? 0),
  }), { in: 0, out: 0, cacheCreated: 0, cacheRead: 0 });
  const summary = {
    ranAt: new Date().toISOString(),
    transport: TRANSPORT,
    cached: useCache,
    models: MODELS,
    pairs: pairs.length,
    scoredBoth: both,
    agreementRate: both ? +(agree / both * 100).toFixed(1) : null,
    [`${mA}VsOperator`]: scored ? +(aMatchesOp / scored * 100).toFixed(1) : null,
    [`${mB}VsOperator`]: both ? +(bMatchesOp / both * 100).toFixed(1) : null,
    totalTokens: tokens,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = join(OUT_DIR, `run-${TRANSPORT}-${stamp}.json`);
  writeFileSync(outFile, JSON.stringify({ summary, rows, raw }, null, 2));
  console.log('[eval] summary:', JSON.stringify(summary, null, 2));
  console.log(`[eval] full results → ${outFile}`);
  const disagreements = rows.filter((r) => r[mA] !== 'ERROR' && r[mB] !== 'ERROR' && r[mA] !== r[mB]);
  if (disagreements.length) {
    console.log(`[eval] ${disagreements.length} disagreement(s):`);
    for (const d of disagreements) console.log(`  - ${d.id}: ${mA}=${d[mA]}(${d[`${mA}-conf`]}) vs ${mB}=${d[mB]}(${d[`${mB}-conf`]}) | operator=${d.operator}`);
  }
}

main().catch((err) => { console.error('[eval] fatal:', err); process.exit(1); });
