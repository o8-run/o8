import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { askClaudeOneShot } from '@/lib/claude-code/one-shot-repl';

const dirs: string[] = [];

function fakeClaude(lines: unknown[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'o8-fake-claude-'));
  dirs.push(dir);
  const binary = path.join(dir, 'claude');
  const rows = lines.map((line) => `printf '%s\\n' '${JSON.stringify(line)}'`).join('\n');
  writeFileSync(binary, `#!/bin/sh\n${rows}\nexec sleep 30\n`);
  chmodSync(binary, 0o755);
  return binary;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('askClaudeOneShot with a background agent', () => {
  it('returns what the turn said when the agent outlives the timeout', async () => {
    const binary = fakeClaude([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Started the agent.' }] } },
      { type: 'system', subtype: 'task_started', tool_use_id: 'a1', is_backgrounded: true, task_type: 'local_agent' },
      { type: 'result', subtype: 'success', result: 'Started the agent.' },
    ]);
    await expect(askClaudeOneShot('go', { binary, model: 'haiku', timeoutMs: 1_000 })).resolves.toBe('Started the agent.');
  });
});
