import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseSessionCost } from './cost-parser';

const roots: string[] = [];

function usageLine(requestId: string, inputTokens: number, outputTokens: number) {
  return JSON.stringify({
    type: 'assistant',
    requestId,
    message: {
      id: `message-${requestId}`,
      model: 'claude-sonnet-5',
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Claude session cost attribution', () => {
  it('includes linked child sessions in cost while preserving a parent-only context reading', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'o8-claude-cost-'));
    roots.push(root);
    const parentPath = path.join(root, 'parent-session.jsonl');
    const childrenPath = path.join(root, 'parent-session', 'subagents');
    await mkdir(childrenPath, { recursive: true });
    await writeFile(parentPath, `${usageLine('request-parent', 100, 10)}\n`, 'utf8');
    await writeFile(
      path.join(childrenPath, 'agent-one.jsonl'),
      `${usageLine('request-child', 50, 5)}\n`,
      'utf8',
    );
    await writeFile(
      path.join(childrenPath, 'agent-replay.jsonl'),
      `${usageLine('request-child', 50, 5)}\n`,
      'utf8',
    );

    const billable = await parseSessionCost(parentPath);
    const contextOnly = await parseSessionCost(parentPath, { includeChildSessions: false });

    expect(billable).toMatchObject({
      inputTokens: 150,
      outputTokens: 15,
      totalCostUsd: 0.00045,
      model: 'claude-sonnet-5',
    });
    expect(contextOnly).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      totalCostUsd: 0.0003,
    });
  });
});
