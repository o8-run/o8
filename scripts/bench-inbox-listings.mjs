import { build } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Real GET handlers and persistence; provider discovery is the fixed fixture boundary.
const root = fileURLToPath(new URL('..', import.meta.url));
const base = process.argv[2] ?? 'origin/main';
const git = (...args) => execFileSync('git', ['-c', 'core.bare=false', ...args], { cwd: root, encoding: 'utf8' });
const baseSha = git('rev-parse', base).trim();
const temporary = mkdtempSync(join(root, '.inbox-listings-benchmark-'));
const data = mkdtempSync(join(tmpdir(), 'o8-inbox-benchmark-'));
try {
  const mainRoot = join(temporary, 'main');
  mkdirSync(mainRoot);
  const archive = execFileSync('git', ['-c', 'core.bare=false', 'archive', baseSha, 'src', 'scripts', 'package.json'], { cwd: root, maxBuffer: 100 * 1024 * 1024 });
  const extracted = spawnSync('tar', ['-x', '-C', mainRoot], { input: archive });
  if (extracted.status !== 0) throw new Error('Could not extract baseline source');
  const fixturePlugin = {
    name: 'fixture-inventory',
    setup(builder) {
      builder.onResolve({ filter: /runtime\/inventory$/ }, () => ({ path: 'fixture', namespace: 'inbox-benchmark' }));
      builder.onLoad({ filter: /.*/, namespace: 'inbox-benchmark' }, () => ({
        contents: `export function invalidateRuntimeInventoryCache() {}
          export async function getRuntimeInventorySnapshot() {
            return { agents: globalThis.inboxBenchmarkAgents, generatedAt: '2026-01-01T00:00:00.000Z',
              meta: { mode: 'live', sourceLabel: 'Fixture', mirrorMode: 'current-session-first' },
              squads: [], events: [], artifacts: [] };
          }`, loader: 'js',
      }));
    },
  };
  await build({
    stdin: { contents: `export { GET as mainInventory } from '@/app/api/runtime/inventory/route';
      export { GET as mainHistory } from '@/app/api/v2/chat-history/list/route';
      export { closeDb as closeMainDb } from '@/lib/db';`, loader: 'ts', resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external',
    outfile: join(temporary, 'baseline.cjs'),
    alias: { '@': mainRoot + '/src', 'server-only': root + '/tests/stubs/server-only.ts' },
    plugins: [fixturePlugin],
  });
  const entry = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { NextRequest } from 'next/server';
import { createLane } from '@/lib/lane/registry';
import { closeDb } from '@/lib/db';
import type { AgentSummary } from '@/lib/fleet/types';
import { inboxSubject, observeInboxRuntimeRun } from '@/lib/inbox/store';
import { mainInventory, mainHistory, closeMainDb } from '${temporary}/baseline.cjs';
import { GET as branchInventory } from '@/app/api/runtime/inventory/route';
import { GET as branchHistory } from '@/app/api/v2/chat-history/list/route';

const data = process.env.CORTEX_IDE_DATA_DIR;
const agents = globalThis.inboxBenchmarkAgents = Array.from({ length: 40 }, (_, i) => ({
  id: 'bench-' + i, name: 'Worker ' + i, squadId: 'standalone', runtime: 'codex',
  model: 'gpt-5', currentTask: 'Review the implementation and report results.',
  sessionKey: 'codex:bench-' + i, workspace: process.cwd(), branch: 'bench-' + i,
  status: 'idle', approvalStatus: 'none', lastEventAt: '2026-01-01T00:00:00.000Z',
  context: { usedPercent: 25, trend: 'stable' }, alerts: 0,
  runtimeSurface: {
    id: 'codex:bench-' + i, runtime: 'codex', kind: 'runtime-session',
    ownership: 'owned', title: 'Worker ' + i, sourceLabel: 'Codex',
    capabilities: { attach: true, readTail: true, sendInput: true, interrupt: true,
      resize: false, diffContext: true, reviewContext: true },
    lifecycle: { lastRunStartedAt: '2026-01-01T00:00:00.000Z' },
  },
} satisfies AgentSummary));

for (let i = 0; i < 200; i++) {
  createLane({ repoPath: process.cwd(), branch: 'bench-' + i, runtime: 'codex',
    sessionKey: 'codex:bench-' + (i % 40), baseCommit: 'a'.repeat(40) });
}
mkdirSync(join(data, 'chat-history'), { recursive: true });
for (let i = 0; i < 500; i++) {
  writeFileSync(join(data, 'chat-history', 'thoughts-bench-' + i + '.json'), JSON.stringify({
    repoPath: process.cwd(), title: 'Conversation ' + i, savedAt: '2026-01-01T00:00:00.000Z',
    messages: [{ id: 'u', role: 'user', content: 'Question ' + i, timestamp: 1 },
      { id: 'a', role: 'assistant', content: 'Answer ' + i, timestamp: 2 }],
  }));
}
for (const agent of agents) {
  observeInboxRuntimeRun(inboxSubject('runtime', agent.sessionKey, agent.workspace),
    agent.runtimeSurface.lifecycle.lastRunStartedAt);
}
(async () => {
  const results = [];
  for (const [name, main, branch, url, field, count] of [
    ['inventory', mainInventory, branchInventory, 'http://localhost/api/runtime/inventory', 'agents', 40],
    ['history', mainHistory, branchHistory,
      'http://localhost/api/v2/chat-history/list?include=orchestrator&limit=500', 'conversations', 500],
  ]) {
    const samples = [[], []];
    for (let i = 0; i < 220; i++) {
      for (const n of (i % 2 ? [1, 0] : [0, 1])) {
        const request = new NextRequest(url);
        const start = performance.now();
        const response = await [main, branch][n](request);
        const elapsed = performance.now() - start;
        const body = await response.json();
        if (response.status !== 200 || body[field].length !== count) throw new Error('Invalid fixture response');
        if (i >= 20) samples[n].push(elapsed);
      }
    }
    const stats = samples.map(times => {
      times.sort((a, b) => a - b);
      return { p50: times[99], p95: times[189] };
    });
    const allowed = Object.fromEntries(['p50', 'p95'].map(percentile => [percentile,
      stats[0][percentile] + Math.max(stats[0][percentile] * 0.1, 5)]));
    results.push({ name, requests: 200, warmup: 20, main: stats[0], branch: stats[1], allowed,
      withinBudget: Object.fromEntries(['p50', 'p95'].map(percentile => [percentile, stats[1][percentile] <= allowed[percentile]])) });
  }
  writeFileSync('${temporary}/measurements.json', JSON.stringify(results));
  closeDb();
  closeMainDb();
  process.exit(0); // Imported server modules can own background timers.
})().catch(error => { console.error(error); process.exit(1); });
`;
  await build({
    stdin: { contents: entry, loader: 'ts', resolveDir: root }, bundle: true,
    platform: 'node', format: 'cjs', target: 'node22', packages: 'external',
    outfile: join(temporary, 'benchmark.cjs'),
    alias: { '@': root + '/src', 'server-only': root + '/tests/stubs/server-only.ts' },
    plugins: [fixturePlugin],
    external: [join(temporary, 'baseline.cjs')],
  });
  const env = { ...process.env, NODE_ENV: 'test', CORTEX_IDE_DATA_DIR: data };
  for (const key of ['O8_DATA_DIR', 'O8_API_TOKEN', 'O8_WORKER_TOKEN', 'O8_SPECTATOR_TOKEN']) delete env[key];
  const result = spawnSync(process.execPath, [join(temporary, 'benchmark.cjs')], {
    cwd: root, env, encoding: 'utf8', timeout: 300_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Benchmark child failed');
  console.log(JSON.stringify({
    baseSha,
    methodology: 'Independent baseline source graph at baseSha; bundled Node 22 GET handler wall time; 20 warmups and 200 request-by-request interleaved samples per version; alternating pair order; response validation outside the timer; fixed discovery snapshot and real SQLite/history files',
    results: JSON.parse(readFileSync(join(temporary, 'measurements.json'), 'utf8')),
  }, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
}
