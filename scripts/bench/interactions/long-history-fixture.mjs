import { createHash } from 'node:crypto';

// Path-free and independent of clocks, randomness and host state.
export function longHistoryFixture(session = 0) {
  const kinds = ['prose', 'markdown', 'code', 'diff', 'tool-output'];
  const messages = Array.from({ length: 5000 }, (_, index) => {
    const kind = kinds[Math.floor(index / 2) % kinds.length];
    const content = {
      prose: 'The worker is checking the conversation history. Preserve the selected text, the draft, and the reading position. '.repeat(4),
      markdown: '## Inspection\n\n**Result:** keep the existing behavior.\n\n- Read the input\n- Check the output\n\n| Stage | State |\n| --- | --- |\n| Inspect | Complete |\n\n> Changes remain scoped.\n',
      code: '```typescript\nexport function summarize(values: number[]) {\n  const total = values.reduce((sum, value) => sum + value, 0);\n  return { total, count: values.length };\n}\n```\n',
      diff: '```diff\ndiff --git a/src/sample.ts b/src/sample.ts\n--- a/src/sample.ts\n+++ b/src/sample.ts\n@@ -1,2 +1,2 @@\n-export const limit = 10;\n+export const limit = 20;\n export const ready = true;\n```\n',
      'tool-output': '```text\n$ npm test -- sample.test.ts\nRUN deterministic fixture\n ✓ reads input\n ✓ preserves output\nTest Files  1 passed (1)\nTests       2 passed (2)\nExit code: 0\n```\n',
    }[kind];
    return { id: `s${session}-history-${index}`, role: index % 2 ? 'assistant' : 'user',
      text: `Message ${index}: ${kind}\n\n${content}`, timestamp: 1700000000000 + index * 1000 };
  });
  const payload = JSON.stringify(messages);
  return { messages, payloadBytes: Buffer.byteLength(payload), digest: createHash('sha256').update(payload).digest('hex'),
    complexity: { messages: 5000, turns: 2500, messagesPerKind: 1000, kinds, fencedBlocks: 3000, tables: 1000 } };
}
