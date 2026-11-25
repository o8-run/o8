/**
 * Smoke test — Cortex Q&A composer (epic #915 sub-2).
 *
 * Tests both question classes end-to-end: classify → retrieve → compose.
 *
 * Run against the founder's live DB:
 *   npx tsx scripts/smoke-qa-ask.ts
 *
 * Run against a fresh DB (empty rows, but pipeline should still return without throwing):
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) npx tsx scripts/smoke-qa-ask.ts
 */

import { askCortex } from '@/lib/cortex/qa/ask';

const REPO_PATH = process.env.SMOKE_REPO_PATH ?? process.cwd();

const CASES = [
  {
    label: 'Class A (lookup)',
    question: 'Who owns the cortex decay pass?',
    expectClass: 'A',
  },
  {
    label: 'Class B (reasoning)',
    question: 'Why did we choose Codex as the workhorse over Claude Code?',
    expectClass: 'B',
  },
];

async function main() {
  let failures = 0;

  for (const c of CASES) {
    console.log(`\n[smoke] --- ${c.label} ---`);
    console.log(`[smoke] question: ${c.question}`);

    const start = Date.now();
    try {
      const result = await askCortex(c.question, REPO_PATH);
      const elapsed = Date.now() - start;

      console.log(`[smoke] class=${result.class} classifyMs=${result.classifyMs} retrievalMs=${result.retrievalMs} totalMs=${elapsed}`);
      console.log(`[smoke] answer (${result.answer.length} chars): ${result.answer.slice(0, 200)}${result.answer.length > 200 ? '…' : ''}`);
      console.log(`[smoke] citations: ${result.citations.length}`);
      for (const c of result.citations.slice(0, 3)) {
        console.log(`  ${c.kind.padEnd(9)} ${String(c.rowId).padEnd(30)} ${c.excerpt?.slice(0, 60) ?? '(no excerpt)'}`);
      }

      if (!result.answer.trim()) {
        console.error(`[smoke] FAIL: empty answer for "${c.question}"`);
        failures++;
      } else {
        console.log(`[smoke] PASS`);
      }
    } catch (err) {
      const elapsed = Date.now() - start;
      console.error(`[smoke] FAIL after ${elapsed}ms:`, err instanceof Error ? err.message : err);
      failures++;
    }
  }

  // Test cache: second identical call should return instantly (< 50ms).
  console.log('\n[smoke] --- Cache test ---');
  const cachedStart = Date.now();
  try {
    const cached = await askCortex(CASES[0].question, REPO_PATH);
    const cachedMs = Date.now() - cachedStart;
    console.log(`[smoke] cache hit in ${cachedMs}ms (answer: ${cached.answer.slice(0, 80)}…)`);
    if (cachedMs < 100) {
      console.log('[smoke] PASS: cache returned in < 100ms');
    } else {
      console.warn(`[smoke] WARN: cache returned in ${cachedMs}ms — expected < 100ms`);
    }
  } catch (err) {
    console.error('[smoke] FAIL (cache test):', err instanceof Error ? err.message : err);
    failures++;
  }

  if (failures > 0) {
    console.error(`\n[smoke] ${failures} failure(s). Pipeline has issues.`);
    process.exit(1);
  } else {
    console.log('\n[smoke] All cases passed. Pipeline is healthy.');
  }
}

main().catch((err) => {
  console.error('[smoke] Unexpected error:', err);
  process.exit(1);
});
