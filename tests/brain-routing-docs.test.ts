import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

// This documentation contract reads the real model list without resolving a
// route, sending requests, or opening the spend store.
vi.mock('@/lib/cortex/qa/llm/brain-spend', () => ({
  assertUnderBrainDailyCap: vi.fn(), recordBrainOpenRouterSpend: vi.fn(),
}));
vi.mock('@/lib/cortex/qa/llm/inference-route', () => ({
  O8_MANAGED_TEXT_MODEL: 'openai/gpt-6-luna',
  managedTextModelOptions: vi.fn(), openRouterTextModels: vi.fn(), resolveOpenRouterRoute: vi.fn(),
}));

import { OPENROUTER_FALLBACK_MODELS } from '@/lib/cortex/qa/llm/openrouter-adapter';

it('documents Brain fallback order separately from the free text fallback', () => {
  const doc = readFileSync(join(process.cwd(), 'docs/user/brain-routing.md'), 'utf8');
  const row = doc.split('\n').find(line => line.startsWith('| Brain (`callOpenRouter`) |'));
  expect(row, 'Brain needs its own paid fallback row').toBeDefined();
  const models = [...row!.matchAll(/`([\w.-]+\/[\w.:-]+)`/g)].map(match => match[1]);
  expect(models).toEqual(OPENROUTER_FALLBACK_MODELS);
  expect(row).toMatch(/\bpaid\b/i);
  expect(doc).not.toContain('The `$0` fallback stays in place.');
});
