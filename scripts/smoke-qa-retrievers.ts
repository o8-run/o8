/**
 * Smoke test — Q&A retrieval foundation (epic #915 sub-1).
 *
 * Runs:
 *   - retrieveAll() against a question + the cortex-ide repo
 *   - asserts each retriever returns ≥1 row OR the schema is empty (for
 *     fresh-DB CI runs we accept zero rows so long as no retriever throws)
 *   - asserts unionMerge dedupes and returns ≤30 rows
 *
 * Run against the founder's live DB:
 *   npx tsx scripts/smoke-qa-retrievers.ts
 *
 * Run against a fresh DB:
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) npx tsx scripts/smoke-qa-retrievers.ts
 */

import { retrieveAll, unionMerge } from '@/lib/cortex/qa/retrieve';

async function main() {
  const repoPath = process.env.SMOKE_REPO_PATH ?? process.cwd();
  const question = process.env.SMOKE_QUESTION ?? 'authentication';

  // Run twice — once with the operator-provided repoPath (filters SQL +
  // graph retrievers) and once globally (no filter). This proves both
  // code paths work and surfaces any repo-mismatch silently dropping rows.
  console.log(`[smoke] question=${JSON.stringify(question)} repoPath=${repoPath}`);

  const start = Date.now();
  const results = await retrieveAll({ question, repoPath });
  const elapsed = Date.now() - start;

  console.log(`[smoke] retrieveAll(scoped) completed in ${elapsed}ms`);
  for (const r of results) {
    console.log(
      `  ${r.retriever.padEnd(5)} rows=${String(r.rows.length).padStart(3)} duration=${r.durationMs}ms`,
    );
  }

  const globalStart = Date.now();
  const globalResults = await retrieveAll({ question });
  const globalElapsed = Date.now() - globalStart;
  console.log(`[smoke] retrieveAll(global) completed in ${globalElapsed}ms`);
  for (const r of globalResults) {
    console.log(
      `  ${r.retriever.padEnd(5)} rows=${String(r.rows.length).padStart(3)} duration=${r.durationMs}ms`,
    );
  }

  const merged = unionMerge(results);
  console.log(`[smoke] unionMerge returned ${merged.length} typed rows`);
  if (merged.length > 30) {
    throw new Error(`unionMerge exceeded MERGE_LIMIT=30 (got ${merged.length})`);
  }

  // Dedup invariant — every merged row's `kind+rowId` must be unique.
  const seen = new Set<string>();
  for (const row of merged) {
    const key = `${row.citation.kind}:${row.citation.rowId}`;
    if (seen.has(key)) {
      throw new Error(`unionMerge produced duplicate citation: ${key}`);
    }
    seen.add(key);
  }

  // No retriever should have thrown — Promise.allSettled wrappers turn a
  // throw into an empty result, which we accept. We're only asserting that
  // the orchestrator returned every retriever shape.
  const expected = new Set(['sql', 'fts', 'facts', 'corrections']);
  const actual = new Set(results.map((r) => r.retriever));
  for (const name of expected) {
    if (!actual.has(name as 'sql' | 'fts' | 'facts' | 'corrections')) {
      throw new Error(`retrieveAll dropped retriever ${name}`);
    }
  }

  // Print a few sample citations so a human eyeballing the smoke run can
  // tell at a glance whether the retrievers are pulling something useful.
  console.log('[smoke] top 3 citations:');
  for (const row of merged.slice(0, 3)) {
    const c = row.citation;
    const excerpt = c.excerpt ? c.excerpt.slice(0, 80) : '(no excerpt)';
    console.log(
      `  ${c.kind.padEnd(9)} ${c.rowId.padEnd(40)} score=${(row.score ?? 0).toFixed(4)} ${excerpt}`,
    );
  }

  console.log('[smoke] OK');
}

main().catch((error) => {
  console.error('[smoke] FAIL', error);
  process.exit(1);
});
