/**
 * The standing deviations clause (#1490) rides in every worker prompt.
 *
 * buildPacketPrompt is the single documented injection chokepoint, so pinning
 * the clause here proves every dispatch path carries it.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import type { OrchestratorPacket } from './types';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-pkt-dev-'));

const { buildPacketPrompt } = await import('./packet-prompt');
const { packetImplementationNotesPath } = await import('./packet-deviations');

function minimalPacket(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: `pkt-dev-${Math.random().toString(36).slice(2)}`,
    referenceLabel: 'PKT-1',
    title: 'feat: test packet',
    summary: 'Test packet summary',
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

describe('buildPacketPrompt deviations clause', () => {
  it('always includes the standing deviations clause', async () => {
    const packet = minimalPacket();
    const prompt = await buildPacketPrompt(packet, []);
    expect(prompt).toContain(packetImplementationNotesPath(packet.id));
    expect(prompt).toContain('ignored, per-packet artifact');
    expect(prompt).not.toContain('implementation-notes.md file at the worktree root');
  });
});

it('teaches detached heavy steps only to writable packets', async () => {
  expect(await buildPacketPrompt(minimalPacket(), [])).toContain('Run heavy steps detached');
  const packet = minimalPacket({ launchContext: { workMode: 'read-only' } as OrchestratorPacket['launchContext'] });
  expect(await buildPacketPrompt(packet, [])).not.toContain('Heavy steps:');
});

it('omits heavy-step queue instructions for confined workers', async () => {
  vi.stubEnv('O8_WORKER_SANDBOX', 'on');
  try { expect(await buildPacketPrompt(minimalPacket(), [])).not.toContain('Heavy steps:'); }
  finally { vi.unstubAllEnvs(); }
});
