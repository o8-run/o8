import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { OrchestratorBackend } from '@/lib/lane/orchestrator-backends/types';

const launchRuntimeSurface = vi.hoisted(() => vi.fn(async () => ({
  ok: true,
  surfaceId: 'claude-code:fallback-seam',
  note: 'launched',
})));

vi.mock('@/lib/runtime/actions', () => ({ launchRuntimeSurface }));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-quota-fallback-'));
writeFileSync(join(dataDir, 'worker-token'), 'quota-fallback-worker-token\n', 'utf8');
writeFileSync(join(dataDir, 'ws-token'), 'quota-fallback-ws-token\n', 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { handleCodexJsonLine } = await import('@/lib/lane/codex-orchestrator-events');
const { createLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { runReviewerTurnWithQuotaFallback } = await import('@/lib/lane/review-quota-fallback');
const {
  buildCrossHouseFallbackMessage,
  resolveCrossHouseFallbackForQuota,
} = await import('@/lib/orchestrator/cross-house-policy');
const { handleWorkerRuntimeFailure } = await import('@/lib/dispatch/worker-quota-fallback');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { listRoleRoutingReceipts } = await import('@/lib/operator/role-routing-ledger');
const { listInboxItems } = await import('@/lib/supervisor/inbox');
const { composeSupervisorInboxCardCopy } = await import('@/lib/inbox/card-copy');
const { submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service/review');
const { assessDurableApprovedReview } = await import('@/lib/lane/durable-review-approval');
const { listApprovalsForContext } = await import('@/lib/approvals/store');

function fakeBackend(
  id: 'codex' | 'claude',
  sendTurn: OrchestratorBackend['sendTurn'],
): OrchestratorBackend {
  return {
    id,
    label: id === 'codex' ? 'Codex' : 'Claude',
    peekSession: () => ({ sessionName: `test-${id}`, status: 'ready' }),
    ensureSession: () => ({ sessionName: `test-${id}`, status: 'ready' }),
    sendTurn,
  };
}

describe('cross-house quota fallback real paths', () => {
  it('routes a real Codex CLI quota frame through the ws-server policy seam', () => {
    const events: Array<{ type: string; error?: string }> = [];
    handleCodexJsonLine(JSON.stringify({
      type: 'turn.failed',
      error: {
        code: 'usage_limit_reached',
        message: 'You have hit your usage limit. Try again when it resets.',
      },
    }), { threadId: null, cost: null }, (event) => events.push(event), { isLocalModel: false });

    const error = events.find((event) => event.type === 'error')?.error;
    const fallback = resolveCrossHouseFallbackForQuota(error, {
      role: 'orchestrator',
      backend: 'codex',
      model: 'gpt-5.6-sol',
      subscriptionProfile: 'both',
    });

    expect(fallback).toMatchObject({
      action: 'handoff',
      fromHouse: 'openai',
      toHouse: 'anthropic',
      toBackend: 'claude',
      modelTier: 'frontierOrchestrator',
    });
    expect(buildCrossHouseFallbackMessage(fallback!)).toContain('Anthropic');
  });

  it('reruns the full auto-review turn and persists its visible fallback event', async () => {
    const lane = createLane({
      repoPath: '/tmp/o8-review-quota-seam',
      branch: 'inline/review-quota-seam',
      runtime: 'codex',
      packetId: `pkt-review-quota-${Date.now()}`,
    });
    const codex = fakeBackend('codex', vi.fn(async (_repo, _prompt, onEvent) => {
      onEvent({ type: 'text', text: 'partial review that must be discarded' });
      onEvent({ type: 'error', code: 'usage_limit_reached', error: 'You have hit your usage limit. Try again when it resets.' });
    }));
    const claude = fakeBackend('claude', vi.fn(async (_repo, prompt, onEvent, options) => {
      expect(prompt).toBe('Review the complete packet.');
      expect(options?.model).toBeTruthy();
      // A real backend reports the route it ran on; the receipt's effective route comes only from this.
      onEvent({ type: 'turn_receipt', leadModel: options!.model!, effort: 'medium' });
      onEvent({ type: 'text', text: 'complete cross-house review' });
      onEvent({ type: 'done', cost: null });
    }));

    const result = await runReviewerTurnWithQuotaFallback({
      laneId: lane.id,
      repoPath: lane.repoPath,
      threadId: `auto-review-${lane.id}`,
      surface: 'auto-review',
      prompt: 'Review the complete packet.',
      initialBackend: codex,
      backendResolver: () => claude,
    });

    expect(result).toMatchObject({
      ok: true,
      backend: 'claude',
      text: 'complete cross-house review',
    });
    expect(result.text).not.toContain('partial review');
    expect(getLaneEvents(lane.id).find((event) => event.verb === 'review_fallback')).toMatchObject({
      payload: {
        surface: 'auto-review',
        status: 'retrying',
        fromHouse: 'openai',
        toHouse: 'anthropic',
      },
    });
    expect(listRoleRoutingReceipts({ role: 'review', repoPath: lane.repoPath })[0]).toMatchObject({
      requested: { backend: 'codex' },
      effective: { backend: 'claude' },
      status: 'fallback',
      fallbackReason: expect.any(String),
    });
  });

  it('reports reviewer contention as structured transient unavailability', async () => {
    const lane = createLane({
      repoPath: '/tmp/o8-review-busy-seam',
      branch: 'inline/review-busy-seam',
      runtime: 'codex',
      packetId: `pkt-review-busy-${Date.now()}`,
    });
    const sendTurn = vi.fn<OrchestratorBackend['sendTurn']>();
    const busyBackend: OrchestratorBackend = {
      ...fakeBackend('codex', sendTurn),
      ensureSession: () => ({ sessionName: 'test-codex-busy', status: 'busy' }),
    };

    const result = await runReviewerTurnWithQuotaFallback({
      laneId: lane.id,
      repoPath: lane.repoPath,
      threadId: `auto-review-${lane.id}`,
      surface: 'auto-review',
      prompt: 'Review the complete packet.',
      initialBackend: busyBackend,
    });

    expect(result).toMatchObject({
      ok: false,
      unavailableReason: 'session_busy',
      errors: ['Codex session busy'],
    });
    expect(sendTurn).not.toHaveBeenCalled();
  });

  it('falls back once when Claude reports disabled subscription access as ordinary text', async () => {
    const lane = createLane({
      repoPath: '/tmp/o8-review-disabled-subscription-seam',
      branch: 'inline/review-disabled-subscription-seam',
      runtime: 'claude-code',
      packetId: `pkt-review-disabled-subscription-${Date.now()}`,
    });
    const claudeSendTurn = vi.fn(async (_repo, _prompt, onEvent) => {
      onEvent({
        type: 'text',
        text: 'Your organization has disabled Claude subscription access for Claude Code.',
      });
      onEvent({ type: 'done', cost: null });
    });
    const codexSendTurn = vi.fn(async (_repo, _prompt, onEvent) => {
      onEvent({ type: 'text', text: 'Codex completed the fallback review.' });
      onEvent({ type: 'done', cost: null });
    });

    const result = await runReviewerTurnWithQuotaFallback({
      laneId: lane.id,
      repoPath: lane.repoPath,
      threadId: `auto-review-${lane.id}`,
      surface: 'auto-review',
      prompt: 'Review the complete packet.',
      initialBackend: fakeBackend('claude', claudeSendTurn),
      backendResolver: () => fakeBackend('codex', codexSendTurn),
    });

    expect(result).toMatchObject({
      ok: true,
      backend: 'codex',
      text: 'Codex completed the fallback review.',
    });
    expect(claudeSendTurn).toHaveBeenCalledTimes(1);
    expect(codexSendTurn).toHaveBeenCalledTimes(1);
    expect(getLaneEvents(lane.id).filter((event) => event.verb === 'review_fallback')).toHaveLength(1);
  });

  it('invalidates a durable approval written by a quota-failed review turn', async () => {
    const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-review-turn-outcome-'));
    execFileSync('git', ['init', '-q'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'quota-test@o8.local'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'o8 quota test'], { cwd: repoPath });
    writeFileSync(join(repoPath, 'fixture.txt'), 'review me\n', 'utf8');
    execFileSync('git', ['add', 'fixture.txt'], { cwd: repoPath });
    execFileSync('git', ['commit', '-qm', 'test: review fixture'], { cwd: repoPath });
    const packetId = `pkt-review-artifact-${Date.now()}`;
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch: 'inline/review-artifact',
      baseBranch: 'master',
      runtime: 'codex',
      packetId,
    });
    const codex = fakeBackend('codex', vi.fn(async (_repo, _prompt, onEvent) => {
      await submitPacketReview({ packetId, approved: true, findings: [] });
      onEvent({ type: 'error', code: 'usage_limit_reached', error: 'You have hit your usage limit.' });
    }));
    const claude = fakeBackend('claude', vi.fn(async (_repo, _prompt, onEvent) => {
      onEvent({ type: 'text', text: 'Fallback review completed without writing a verdict.' });
      onEvent({ type: 'done', cost: null });
    }));

    await runReviewerTurnWithQuotaFallback({
      laneId: lane.id,
      repoPath,
      threadId: `auto-review-${lane.id}`,
      surface: 'auto-review',
      prompt: 'Review the complete packet.',
      initialBackend: codex,
      backendResolver: () => claude,
    });

    const approval = listApprovalsForContext({ packetId, laneId: lane.id })
      .find((candidate) => candidate.toolName === 'orchestrator_review');
    expect(approval).toMatchObject({
      status: 'approved',
      args: {
        reviewTurnOutcome: 'quota_discarded',
        reviewSuperseded: true,
      },
    });
    await expect(assessDurableApprovedReview(lane)).resolves.toMatchObject({
      approved: false,
      reason: 'No durable approved AI review exists.',
    });
  });

  it('turns a runtime-adapter quota exit into a lane event and supervisor card', async () => {
    const packetId = `pkt-worker-quota-${Date.now()}`;
    const lane = createLane({
      repoPath: '/tmp/o8-worker-quota-seam',
      worktreePath: '/tmp/o8-worker-quota-seam',
      branch: 'inline/worker-quota-seam',
      runtime: 'codex',
      packetId,
    });

    const result = await handleWorkerRuntimeFailure({
      laneId: lane.id,
      runtime: 'codex',
      model: 'gpt-5.6-terra',
      surfaceId: 'codex:quota-seam',
      prompt: 'Finish the packet.',
      rawFailure: JSON.stringify({ type: 'turn.failed', error: { code: 'usage_limit_reached' } }),
    });

    expect(result).toMatchObject({ handled: true, action: 'card', toRuntime: 'claude-code' });
    expect(getLaneEvents(lane.id).find((event) => event.verb === 'worker_quota_exhausted')).toMatchObject({
      payload: {
        surfaceId: 'codex:quota-seam',
        fromRuntime: 'codex',
        suggestedRuntime: 'claude-code',
      },
    });
    expect(listInboxItems({ includeAllProjects: true }).find((item) => item.packetId === packetId)).toMatchObject({
      kind: 'worker_quota_exhausted',
      status: 'human_required',
      payload: {
        autoFallbackEnabled: false,
        suggestedRuntime: 'claude-code',
      },
    });
  });

  it('redispatches on the equal-tier runtime when the operator default is enabled', async () => {
    const packetId = `pkt-worker-auto-quota-${Date.now()}`;
    const lane = createLane({
      repoPath: '/tmp/o8-worker-auto-quota-seam',
      worktreePath: '/tmp/o8-worker-auto-quota-seam',
      branch: 'inline/worker-auto-quota-seam',
      runtime: 'codex',
      packetId,
    });
    const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    const { resolveWorkerRouting } = await import('@/lib/agents/routing');
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath: lane.repoPath, packets: [{
      id: packetId, referenceLabel: 'P1', title: 'Quota fixture', summary: '', runtime: 'codex', workspaceTargetPath: lane.repoPath,
      branchTarget: lane.branch, dependencyLabels: [], dependencyPacketIds: [], status: 'running',
      queueState: 'queued', releaseState: 'pending',
      workerRouting: resolveWorkerRouting({ requestedRuntime: 'codex' }),
    }] });
    launchRuntimeSurface.mockClear();
    await updateOperatorDefaults({ crossHouseWorkerFallback: true, subscriptionProfile: 'both' });

    try {
      const result = await handleWorkerRuntimeFailure({
        laneId: lane.id,
        runtime: 'codex',
        model: 'gpt-5.6-terra',
        surfaceId: 'codex:auto-quota-seam',
        prompt: 'Finish the packet automatically.',
        rawFailure: JSON.stringify({ type: 'turn.failed', error: { code: 'usage_limit_reached' } }),
      });

      expect(result).toMatchObject({
        handled: true,
        action: 'redispatched',
        toRuntime: 'claude-code',
        sessionKey: 'claude-code:fallback-seam',
      });
      expect(launchRuntimeSurface).toHaveBeenCalledWith(expect.objectContaining({
        runtime: 'claude-code',
        model: expect.stringContaining('sonnet'),
        existingLaneId: lane.id,
      }));
      expect(getLane(lane.id)).toMatchObject({
        runtime: 'claude-code',
        sessionKey: 'claude-code:fallback-seam',
        status: 'running',
      });
      expect(getLaneEvents(lane.id).find((event) => event.verb === 'worker_fallback')).toBeTruthy();
      const { getTaskPoolTask } = await import('@/lib/tasks/pool');
      const { taskSignal } = await import('@/components/desktop/repo-focus/tabs/control-room/helpers');
      const task = (await getTaskPoolTask(packetId))!;
      expect(task.runtimeSubstitution).toContain('Worker quota fallback from codex to claude-code.');
      expect(taskSignal({ ...task, sourceIssue: task.sourceIssue ?? null })).not.toContain('Worker quota fallback');
      expect((await getTaskPoolTask(packetId))?.workerRouting).toMatchObject({
        requestedRuntime: 'codex', selectedRuntime: 'claude-code',
        reason: expect.stringContaining('quota'),
      });
      expect(listRoleRoutingReceipts({ role: 'recovery', repoPath: lane.repoPath })[0]).toMatchObject({
        requested: { runtime: 'codex' },
        effective: { runtime: 'claude-code' },
        status: 'fallback',
        fallbackReason: expect.any(String),
      });
    } finally {
      await updateOperatorDefaults({ crossHouseWorkerFallback: false });
    }
  });

  it('cards terminally after both worker subscription houses exhaust', async () => {
    const packetId = `pkt-worker-both-quota-${Date.now()}`;
    const lane = createLane({
      repoPath: '/tmp/o8-worker-both-quota-seam',
      worktreePath: '/tmp/o8-worker-both-quota-seam',
      branch: 'inline/worker-both-quota-seam',
      runtime: 'codex',
      packetId,
    });
    launchRuntimeSurface.mockClear();
    await updateOperatorDefaults({ crossHouseWorkerFallback: true, subscriptionProfile: 'both' });

    try {
      const first = await handleWorkerRuntimeFailure({
        laneId: lane.id,
        runtime: 'codex',
        model: 'gpt-5.6-terra',
        surfaceId: 'codex:first-house',
        prompt: 'Finish the packet automatically.',
        rawFailure: JSON.stringify({ type: 'turn.failed', error: { code: 'usage_limit_reached' } }),
      });
      expect(first.action).toBe('redispatched');
      const duplicate = await handleWorkerRuntimeFailure({
        laneId: lane.id,
        runtime: 'codex',
        model: 'gpt-5.6-terra',
        surfaceId: 'codex:first-house',
        prompt: 'Finish the packet automatically.',
        rawFailure: JSON.stringify({ type: 'turn.failed', error: { code: 'usage_limit_reached' } }),
      });
      expect(duplicate).toMatchObject({
        action: 'redispatched',
        sessionKey: 'claude-code:fallback-seam',
      });
      expect(launchRuntimeSurface).toHaveBeenCalledTimes(1);
      for (let index = 0; index < 550; index += 1) {
        recordLaneEvent(lane.id, 'update', 'system', { index, reason: 'terminal-state-window-proof' });
      }

      const second = await handleWorkerRuntimeFailure({
        laneId: lane.id,
        runtime: 'claude-code',
        model: 'claude-sonnet-5',
        surfaceId: 'claude-code:fallback-seam',
        prompt: 'Finish the packet automatically.',
        rawFailure: JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: "You've hit your usage limit",
        }),
      });

      expect(second.action).toBe('card');
      expect(launchRuntimeSurface).toHaveBeenCalledTimes(1);
      expect(getLane(lane.id)?.status).toBe('paused');
      expect(getLaneEvents(lane.id).find((event) => event.verb === 'worker_fallback_terminal')).toMatchObject({
        payload: { status: 'both_houses_exhausted', bothHousesExhausted: true },
      });
      const terminalCard = listInboxItems({ includeAllProjects: true }).find((item) => item.packetId === packetId);
      expect(terminalCard).toMatchObject({
        status: 'human_required',
        payload: {
          bothHousesExhausted: true,
          suggestedRuntime: null,
          suggestedModel: null,
        },
      });
      expect(composeSupervisorInboxCardCopy(terminalCard!).headline).toContain('Both comparable worker subscriptions are exhausted');
    } finally {
      await updateOperatorDefaults({ crossHouseWorkerFallback: false });
    }
  });
});
