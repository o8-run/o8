import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-harness-real-path-'));
const repoDir = mkdtempSync(join(os.tmpdir(), 'o8-harness-repo-'));
const secondRepoDir = mkdtempSync(join(os.tmpdir(), 'o8-harness-import-'));
const WS_TOKEN = 'operator-harness-token-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

function initRepo(path: string): void {
  execFileSync('git', ['init', '-b', 'main', path]);
  execFileSync('git', ['-C', path, 'config', 'user.email', 'harness@example.com']);
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Harness Test']);
  writeFileSync(join(path, 'AGENTS.md'), '# Test instructions\nKeep the widget typed.\n');
  writeFileSync(join(path, 'widget.ts'), 'export function renderWidget(value: string) { return value.trim(); }\n');
  execFileSync('git', ['-C', path, 'add', 'AGENTS.md', 'widget.ts']);
  execFileSync('git', ['-C', path, 'commit', '-m', 'init']);
}

initRepo(repoDir);
initRepo(secondRepoDir);

const reviewer = vi.hoisted(() => ({
  calls: 0,
  mode: 'approve' as 'approve' | 'tool',
  sessionThreadIds: [] as Array<string | null | undefined>,
  prompts: [] as string[],
  turnOptions: [] as Array<{
    permissionMode?: string;
    toolProfile?: string;
    threadId?: string | null;
    signal?: AbortSignal;
  }>,
}));

vi.mock('@/lib/lane/orchestrator-backends/registry', () => ({
  getActiveReviewerBackend: () => ({
    id: 'codex',
    label: 'Codex test reviewer',
    ensureSession: (_repo: string, _agent?: string, threadId?: string | null) => {
      reviewer.sessionThreadIds.push(threadId);
      return { status: 'ready' };
    },
    sendTurn: async (
      _repo: string,
      prompt: string,
      onEvent: (event: unknown) => void,
      options: (typeof reviewer.turnOptions)[number],
    ) => {
      reviewer.calls += 1;
      reviewer.prompts.push(prompt);
      reviewer.turnOptions.push(options);
      if (reviewer.mode === 'tool') {
        onEvent({ type: 'tool_use', name: 'Read', input: { path: 'tests/bench/governance/manifest.json' } });
        return;
      }
      onEvent({
        type: 'text',
        text: JSON.stringify({ verdict: 'approve', summary: 'Patch satisfies the supplied contract. I ran it successfully.', findings: [], runEvidence: { status: 'run' } }),
      });
    },
  }),
}));

const harnessRoute = await import('@/app/api/harness/route');
const { evaluateDiff } = await import('@/lib/harness/evaluator');
const { createLane } = await import('@/lib/lane/registry');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const { closeDb } = await import('@/lib/db');

function request(body: Record<string, unknown>, token = WS_TOKEN): NextRequest {
  return new NextRequest('http://localhost:3001/api/harness', {
    method: 'POST',
    headers: {
      host: 'localhost:3001',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function post<T>(body: Record<string, unknown>, token = WS_TOKEN): Promise<T> {
  const response = await harnessRoute.POST(request(body, token));
  const payload = await response.json() as { ok: boolean; result?: T; error?: unknown };
  expect(response.status, JSON.stringify(payload.error)).toBe(200);
  expect(payload.ok).toBe(true);
  return payload.result as T;
}

describe.sequential('harness real path', () => {
  it('persists the grounded feature to contract to sprint to verification loop through the route', async () => {
    const feature = await post<{ id: string; status: string }>({
      action: 'feature_add',
      repoPath: repoDir,
      title: 'Render the widget safely',
      description: 'The widget trims a string and remains typed.',
      priority: 1,
      verificationCommand: ['npm', 'test'],
    });
    expect(feature.status).toBe('failing');

    const unverifiedPass = await harnessRoute.POST(request({
      action: 'feature_status',
      repoPath: repoDir,
      featureId: feature.id,
      status: 'passing',
    }));
    expect(unverifiedPass.status).toBe(400);

    const externalDir = mkdtempSync(join(os.tmpdir(), 'o8-harness-external-'));
    const externalPath = join(externalDir, 'secret.ts');
    writeFileSync(externalPath, 'export function renderForbiddenWidget() { return "secret"; }\n');
    symlinkSync(externalPath, join(repoDir, 'linked-secret.ts'));
    execFileSync('git', ['-C', repoDir, 'add', 'linked-secret.ts']);
    execFileSync('git', ['-C', repoDir, 'commit', '-m', 'track external symlink']);

    const grounding = await post<{
      id: string;
      paths: Array<{ path: string; symbols: string[] }>;
      repositoryInstructions: string[];
    }>({
      action: 'ground',
      repoPath: repoDir,
      task: 'Update renderWidget string trimming and verify the widget behavior.',
      featureId: feature.id,
      acceptanceCriteria: ['renderWidget returns a trimmed string'],
    });
    expect(grounding.paths.some((path) => path.path === 'widget.ts')).toBe(true);
    expect(grounding.paths.find((path) => path.path === 'widget.ts')?.symbols).toContain('renderWidget');
    expect(grounding.repositoryInstructions).toContain('AGENTS.md');

    const symlinkGrounding = await post<{ id: string; paths: Array<{ path: string }> }>({
      action: 'ground',
      repoPath: repoDir,
      task: 'Update renderForbiddenWidget.',
      acceptanceCriteria: ['Do not read through tracked symlinks'],
    });
    expect(symlinkGrounding.paths).not.toContainEqual(expect.objectContaining({ path: 'linked-secret.ts' }));

    closeDb();
    const boot = await post<{ featureSummary: { next: { id: string } }; grounding: { id: string } }>({
      action: 'boot',
      repoPath: repoDir,
    });
    expect(boot.featureSummary.next.id).toBe(feature.id);
    expect(boot.grounding.id).toBe(symlinkGrounding.id);

    const contract = await post<{ id: string; status: string }>({
      action: 'contract_propose',
      repoPath: repoDir,
      featureId: feature.id,
      groundingId: grounding.id,
      generatorTerms: 'Change only widget.ts and add focused verification.',
      evaluatorTerms: 'Reject unrelated files or an untyped return value.',
      acceptanceCriteria: ['renderWidget returns a trimmed string'],
    });
    expect(contract.status).toBe('proposed');
    const invalidContractTransition = await harnessRoute.POST(request({
      action: 'contract_transition',
      repoPath: repoDir,
      contractId: contract.id,
      status: 'verified',
    }));
    expect(invalidContractTransition.status).toBe(409);
    expect(await invalidContractTransition.json()).toMatchObject({
      ok: false,
      error: { code: 'harness_action_failed' },
    });
    const accepted = await post<{ status: string }>({
      action: 'contract_transition',
      repoPath: repoDir,
      contractId: contract.id,
      status: 'accepted',
    });
    expect(accepted.status).toBe('accepted');

    const sprint = await post<{ id: string; status: string; currentFeatureId: string }>({
      action: 'sprint_start',
      repoPath: repoDir,
      contractId: contract.id,
    });
    expect(sprint).toMatchObject({ status: 'active', currentFeatureId: feature.id });

    const verified = await post<{
      checks: Array<{ feature: { status: string } }>;
      sprint: { status: string; currentFeatureId: null };
    }>({
      action: 'verify',
      repoPath: repoDir,
      sprintId: sprint.id,
      results: [{
        featureId: feature.id,
        status: 'passed',
        evidence: 'npm test passed',
        command: ['npm', 'test'],
        exitCode: 0,
      }],
    });
    expect(verified.checks[0].feature.status).toBe('passing');
    expect(verified.sprint).toMatchObject({ status: 'completed', currentFeatureId: null });

    const contracts = await post<{ contracts: Array<{ id: string; status: string }> }>({
      action: 'contract_list',
      repoPath: repoDir,
    });
    expect(contracts.contracts.find((entry) => entry.id === contract.id)?.status).toBe('verified');

    const checksBefore = await post<{ checks: unknown[] }>({
      action: 'feature_checks',
      repoPath: repoDir,
      featureId: feature.id,
    });
    const invalidBatch = await harnessRoute.POST(request({
      action: 'verify',
      repoPath: repoDir,
      results: [
        { featureId: feature.id, status: 'failed', evidence: 'must not persist' },
        { featureId: 'feature-does-not-exist', status: 'passed' },
      ],
    }));
    expect(invalidBatch.status).toBe(404);
    const checksAfter = await post<{ checks: unknown[] }>({
      action: 'feature_checks',
      repoPath: repoDir,
      featureId: feature.id,
    });
    expect(checksAfter.checks).toHaveLength(checksBefore.checks.length);
    const stillPassing = await post<{ features: Array<{ id: string; status: string }> }>({
      action: 'feature_list',
      repoPath: repoDir,
    });
    expect(stillPassing.features.find((entry) => entry.id === feature.id)?.status).toBe('passing');
  });

  it('keeps lifecycle recommendations separate from explicit operator transitions', async () => {
    const measured = await post<{
      measurement: { lift: number };
      component: { lifecycle: string; recommendation: { action: string } };
    }>({
      action: 'harness_measure',
      repoPath: repoDir,
      componentKey: 'blind-second-pass',
      modelId: 'test-model',
      baselineScore: 0.8,
      enabledScore: 0.8,
      sampleCount: 10,
      evidence: { suite: 'paired-test' },
    });
    expect(measured.measurement.lift).toBe(0);
    expect(measured.component).toMatchObject({ lifecycle: 'retained', recommendation: { action: 'candidate' } });

    const invalidLifecycleTransition = await harnessRoute.POST(request({
      action: 'harness_transition',
      repoPath: repoDir,
      componentKey: 'blind-second-pass',
      modelId: 'test-model',
      lifecycle: 'retired',
      reason: 'Skipping the evidence stages must fail.',
    }));
    expect(invalidLifecycleTransition.status).toBe(409);

    for (const lifecycle of ['candidate', 'shadow_only', 'retired']) {
      const component = await post<{ lifecycle: string }>({
        action: 'harness_transition',
        repoPath: repoDir,
        componentKey: 'blind-second-pass',
        modelId: 'test-model',
        lifecycle,
        reason: `Operator accepted ${lifecycle} after paired evidence.`,
      });
      expect(component.lifecycle).toBe(lifecycle);
    }
  });

  it('runs the independent evaluator and exports an importable non-secret bundle', async () => {
    const evaluation = await post<{ verdict: string; reviewerBackend: string }>({
      action: 'evaluate_diff',
      repoPath: repoDir,
      task: 'Keep renderWidget typed.',
      diff: 'diff --git a/widget.ts b/widget.ts\n--- a/widget.ts\n+++ b/widget.ts\n@@ -1 +1 @@\n-export function renderWidget(value: string) { return value.trim(); }\n+export function renderWidget(value: string): string { return value.trim(); }\n',
      acceptanceCriteria: ['Return type is explicit'],
    });
    expect(evaluation).toMatchObject({ verdict: 'approve', reviewerBackend: 'codex', reviewMode: 'read_only', verdictLabel: 'approved, not run', runEvidence: { status: 'not_run' } });
    expect(reviewer.calls).toBe(1);
    const threadId = reviewer.sessionThreadIds.at(-1);
    expect(threadId).toMatch(/^thoughts-harness-evaluate-/);
    expect(reviewer.turnOptions.at(-1)).toMatchObject({
      permissionMode: 'plan',
      toolProfile: 'propose',
      threadId,
    });
    expect(reviewer.prompts.at(-1)).toContain('the repository is intentionally empty');
    expect(reviewer.prompts.at(-1)).toContain('Any tool-use event aborts the review and records no verdict.');
    expect(reviewer.prompts.at(-1)).toContain('Return the JSON verdict now without calling tools.');

    const oversizedEvaluation = await harnessRoute.POST(request({
      action: 'evaluate_diff',
      repoPath: repoDir,
      task: 'Reject oversized input.',
      diff: `+${'x'.repeat(300_001)}`,
    }));
    expect(oversizedEvaluation.status).toBe(400);
    expect(await oversizedEvaluation.json()).toMatchObject({
      ok: false,
      error: { code: 'harness_action_failed' },
    });

    const bundle = await post<{ schema: string; features: unknown[] }>({
      action: 'bundle_export',
      repoPath: repoDir,
    });
    expect(bundle.schema).toBe('o8/harness-bundle/v1');
    expect(bundle.features.length).toBeGreaterThan(0);

    const imported = await post<{ imported: { features: number; contracts: number; measurements: number } }>({
      action: 'bundle_import',
      repoPath: secondRepoDir,
      bundle,
    });
    expect(imported.imported.features).toBeGreaterThan(0);
    expect(imported.imported.contracts).toBeGreaterThan(0);
    expect(imported.imported.measurements).toBeGreaterThan(0);

    const repeated = await post<{
      imported: { features: number; checks: number; groundings: number; contracts: number; measurements: number };
      reusedFeatures: number;
    }>({
      action: 'bundle_import',
      repoPath: secondRepoDir,
      bundle,
    });
    expect(repeated.imported).toMatchObject({
      features: 0,
      checks: 0,
      groundings: 0,
      contracts: 0,
      measurements: 0,
    });
    expect(repeated.reusedFeatures).toBeGreaterThan(0);

    const importedFeatures = await post<{ features: Array<{ title: string }> }>({
      action: 'feature_list',
      repoPath: secondRepoDir,
    });
    expect(importedFeatures.features.some((feature) => feature.title === 'Render the widget safely')).toBe(true);
  });

  it('marks a blind evaluation inconclusive when the reviewer calls a tool', async () => {
    reviewer.mode = 'tool';
    try {
      const evaluation = await evaluateDiff({
        repoPath: repoDir,
        task: 'Review only the supplied patch.',
        diff: 'diff --git a/widget.ts b/widget.ts\n--- a/widget.ts\n+++ b/widget.ts\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n',
        disallowTools: true,
      });

      expect(evaluation.verdict).toBe('inconclusive');
      expect(evaluation.summary).toContain('Blind review protocol breach');
      expect(reviewer.turnOptions.at(-1)?.signal?.aborted).toBe(true);
    } finally {
      reviewer.mode = 'approve';
    }
  });

  it('binds worker writes to their packet repo and sprint while keeping lifecycle mutation operator-only', async () => {
    const packetId = `pkt-harness-${Date.now()}`;
    createLane({
      label: 'harness worker',
      repoPath: repoDir,
      branch: `agent/${packetId}`,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
    });
    const workerToken = mintPacketWorkerToken(packetId);
    const feature = await post<{ id: string }>({
      action: 'feature_add',
      repoPath: repoDir,
      title: 'Worker-owned verification path',
      description: 'The packet records its evidence.',
    });
    const grounding = await post<{ repoPath: string; packetId: string }>({
      action: 'ground',
      repoPath: secondRepoDir,
      task: 'Find the widget implementation.',
      featureId: feature.id,
    }, workerToken);
    expect(grounding).toMatchObject({ repoPath: realpathSync(repoDir), packetId });

    const denied = await harnessRoute.POST(request({
      action: 'harness_transition',
      repoPath: repoDir,
      componentKey: 'blind-second-pass',
      modelId: 'test-model',
      lifecycle: 'retained',
      reason: 'worker should not do this',
    }, workerToken));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ ok: false, error: { code: 'operator_required' } });

    const anonymous = await harnessRoute.POST(new NextRequest('http://localhost:3001/api/harness', {
      method: 'POST',
      headers: { host: 'localhost:3001', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'feature_list', repoPath: repoDir }),
    }));
    expect(anonymous.status).toBe(403);
  });

  it('rejects an oversized route request before parsing or authorization', async () => {
    const oversized = await harnessRoute.POST(new NextRequest('http://localhost:3001/api/harness', {
      method: 'POST',
      headers: {
        host: 'localhost:3001',
        'content-type': 'application/json',
        'content-length': String((8 * 1024 * 1024) + 1),
      },
      body: '{}',
    }));
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      ok: false,
      error: { code: 'request_too_large' },
    });
  });
});
