// Deterministic provider boundary only. Production review, mutation and routes
// still read/write the owned fixture repository. Never launch a paid model.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export function defaultClaudeBin() { return 'owned-fixture-provider'; }
export function prewarmClaudeRepl() {}
export async function askClaudeWarm(prompt: string) {
  const root = process.env.O8_FILES_FIXTURE_ROOT!;
  appendFileSync(join(root, 'provider-prompts.jsonl'), JSON.stringify(prompt) + '\n');
  if (existsSync(join(root, 'provider-error'))) throw new Error('Fixture review unavailable');
  if (prompt.includes('Continue one o8.md margin-note thread.')) return 'Keep this change scoped to the named anchor.';
  const custom = join(root, 'review-annotations.json');
  return existsSync(custom) ? readFileSync(custom, 'utf8') : '[{"kind":"comment","anchor":"The draft line.","body":"Check the fixture acceptance evidence."}]';
}
export async function callCodex(prompt: string) { return askClaudeWarm(prompt); }
