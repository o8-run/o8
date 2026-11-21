/**
 * Session-rule inheritance through the REAL dispatch path (#1329).
 *
 * The end-to-end chain is: orchestrator turn block teaches the model its
 * thread id (session-rules-prompt.test.ts pins that) → the model passes
 * `orchestratorThreadId` on create_mission → MCP handler / API route forward
 * it verbatim into `createMission` (this service function — the single entry
 * both surfaces call) → every packet is stamped → `buildPacketPrompt` injects
 * the thread's rules into the worker prompt. This suite pins the service half
 * with a real temp git repo: the id lands on the PERSISTED packet (not just a
 * direct function arg) and the persisted packet's worker prompt carries the
 * binding block.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

// db/index.ts + control-plane resolve the data dir at module load — set first.
process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(os.tmpdir(), 'o8-mission-rules-'));

const { addSessionRule } = await import('@/lib/db/session-rules-store');
const { createMission } = await import('./mission');
const { currentMissionState } = await import('./shared');
const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');

// createMission prepares branches against a real repo — give it one.
const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-mission-repo-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
git('init', '--initial-branch=main');
git('-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '--allow-empty', '-m', 'init');

describe('createMission stamps orchestratorThreadId onto persisted packets', () => {
  it('carries the thread id from CreateMissionInput to the packet, and the packet prompt inherits the rules', async () => {
    addSessionRule('thoughts-e2e', 'never bypass the review gate');

    const result = await createMission({
      issues: [{ number: 90001, title: 'inline: test task', body: 'do the thing', url: '' }],
      repoPath,
      runtime: 'codex',
      constraints: '',
      orchestratorThreadId: 'thoughts-e2e',
      launchContext: {
        source: 'mcp',
        presentation: 'split',
        repoContext: 'transient',
        caller: 'test orchestrator',
      },
    });
    expect(result.missionId).toBeTruthy();
    expect(result.packets).toHaveLength(1);

    // The PERSISTED packet (post normalize round-trip) carries the id.
    const persisted = currentMissionState();
    const packet = persisted.packets.find((candidate) => candidate.id === result.packets[0]!.id);
    expect(packet).toBeDefined();
    expect(packet!.orchestratorThreadId).toBe('thoughts-e2e');
    expect(packet!.dispatcher).toEqual({ surface: 'orchestrator', id: 'thoughts-e2e' });
    expect(packet!.launchContext).toMatchObject({
      caller: 'test orchestrator',
      parentThreadId: 'thoughts-e2e',
    });
    expect(packet!.taskContractRequired).toBe(true);
    expect(packet!.taskContractSource).toBe('default');

    // And the worker prompt built from that persisted packet inherits the rules.
    const prompt = await buildPacketPrompt(packet!, persisted.packets);
    expect(prompt).toContain('<Operator session rules (binding)>');
    expect(prompt).toContain('- never bypass the review gate');
    expect(prompt).toContain('Pre-edit task contract:');
  });

  it('omits the field when the input carries no thread id', async () => {
    const result = await createMission({
      issues: [{ number: 90002, title: 'inline: threadless task', body: '', url: '' }],
      repoPath,
      runtime: 'codex',
      constraints: '',
    });
    const persisted = currentMissionState();
    const packet = persisted.packets.find((candidate) => candidate.id === result.packets[0]!.id);
    expect(packet).toBeDefined();
    expect(packet!.orchestratorThreadId).toBeUndefined();
    expect(packet!.dispatcher).toEqual({ surface: 'operator', id: 'desktop' });
  });

  it('persists an opt-in quality-search seed with one sealed contract', async () => {
    const taskContract = {
      version: 1 as const,
      requirements: [{
        id: 'R1',
        source: 'do the thing',
        expectedBehavior: 'The thing is done.',
        productionPath: 'entry -> implementation',
        verification: 'focused test',
      }],
      smallestRoute: [{
        path: 'src/implementation.ts',
        requirements: ['R1'],
        reason: 'The implementation owns the behavior.',
      }],
      exclusions: [],
    };
    const result = await createMission({
      issues: [{ number: 90003, title: 'inline: searched task', body: 'do the thing', url: '' }],
      repoPath,
      runtime: 'codex',
      constraints: '',
      qualitySearch: { taskContract },
    });
    const persisted = currentMissionState();
    const packet = persisted.packets.find((candidate) => candidate.id === result.packets[0]!.id);

    expect(packet?.taskContract).toEqual(taskContract);
    // Quality search remains explicitly armed with its sealed contract.
    expect(packet?.taskContractRequired).toBe(true);
    expect(packet?.taskContractSource).toBe('explicit');
    expect(packet?.qualitySearch).toEqual({
      version: 1,
      role: null,
      repairAttempts: 0,
      receipt: null,
    });

    await expect(createMission({
      issues: [{ number: 90004, title: 'inline: unsupported search', body: 'do the thing', url: '' }],
      repoPath,
      runtime: 'antigravity',
      constraints: '',
      qualitySearch: { taskContract },
    })).rejects.toThrow('not supported by the selected worker runtime');

    await expect(createMission({
      issues: [{ number: 90005, title: 'inline: contradictory search', body: 'do the thing', url: '' }],
      repoPath,
      runtime: 'codex',
      constraints: '',
      taskContract: 'off',
      qualitySearch: { taskContract },
    })).rejects.toThrow('Quality search already uses a sealed contract and cannot be combined with taskContract: "off".');
  });
});
