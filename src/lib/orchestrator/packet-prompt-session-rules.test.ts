/**
 * Worker inheritance of session rules through buildPacketPrompt (#1329).
 *
 * buildPacketPrompt is the single documented injection chokepoint (Brain
 * teaching block precedent) — every dispatch path (mission, task pool, rerun)
 * funnels through it. These tests pin that a packet stamped with the
 * dispatching thread's `orchestratorThreadId` carries the "Operator session
 * rules (binding)" block in its worker prompt, and that thread-less / rule-less
 * packets stay untouched.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import type { OrchestratorPacket } from './types';

// db/index.ts resolves the data dir at module load — set it BEFORE importing.
process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-pkt-rules-'));

const { addSessionRule } = await import('@/lib/db/session-rules-store');
const { buildPacketPrompt } = await import('./packet-prompt');

function minimalPacket(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: `pkt-rules-${Math.random().toString(36).slice(2)}`,
    referenceLabel: 'PKT-1',
    title: 'feat: test packet',
    summary: 'Test packet summary',
    // Null keeps buildPacketPrompt off the context-block/learned-rules
    // paths — this suite only pins the session-rules block.
    workspaceTargetPath: null,
    branchTarget: 'main',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    ...overrides,
  };
}

describe('buildPacketPrompt session-rule inheritance', () => {
  it('injects the dispatching thread\'s rules into the worker prompt', async () => {
    addSessionRule('thoughts-dispatch', 'do not touch generated files');
    const prompt = await buildPacketPrompt(
      minimalPacket({ orchestratorThreadId: 'thoughts-dispatch' }),
      [],
    );
    expect(prompt).toContain('<Operator session rules (binding)>');
    expect(prompt).toContain('- do not touch generated files');
    // Sanity: the block rides ABOVE the packet body so the worker reads the
    // constraints before the task.
    expect(prompt.indexOf('<Operator session rules (binding)>')).toBeLessThan(prompt.indexOf('Packet: feat: test packet'));
  });

  it('leaves the prompt clean when the packet has no originating thread', async () => {
    const prompt = await buildPacketPrompt(minimalPacket(), []);
    expect(prompt).not.toContain('Operator session rules (binding)');
  });

  it('leaves the prompt clean when the thread has no rules', async () => {
    const prompt = await buildPacketPrompt(
      minimalPacket({ orchestratorThreadId: 'thoughts-no-rules' }),
      [],
    );
    expect(prompt).not.toContain('Operator session rules (binding)');
  });
});
