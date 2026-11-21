import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import retainedRuleTokens from './retained-rule-tokens.json';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-prompt-audit-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKER_SANDBOX = '0';

const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
const { buildOrchestratorSystemPrompt } = await import('@/lib/lane/orchestrator-system-prompt');
const { buildAutoReviewPromptV1, buildBlindSecondPassPromptV1 } = await import('@/lib/prompts/v1');
const { TASK_CONTROL_TOOLS } = await import('@/lib/mcp/task-control-tools');
const { CORTEX_WORKER_TOOLS } = await import('@/lib/mcp/cortex-worker-tools');

const sizes: Record<string, number> = {};
function measure(name: string, prompt: string): string {
  sizes[name] = Math.ceil(prompt.length / 4);
  return prompt;
}

afterAll(() => {
  if (process.env.O8_PROMPT_AUDIT_OUTPUT) {
    writeFileSync(process.env.O8_PROMPT_AUDIT_OUTPUT, `${JSON.stringify(sizes, null, 2)}\n`);
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const shouting = /\b(?:CRITICAL|IMPORTANT|MUST|NEVER|ALWAYS|EXACTLY)\b|Do NOT|You may NOT/;

function packet(readOnly: boolean, ui = false): OrchestratorPacket {
  return {
    id: `pkt-audit-${readOnly}-${ui}`, referenceLabel: 'PKT-1',
    title: ui ? 'Fix button layout' : 'Fix scoped behavior',
    summary: 'Trace the entry point, preserve unrelated work, and verify the result.',
    workspaceTargetPath: null, branchTarget: 'main', runtime: 'codex',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued',
    releaseState: 'pending', status: 'queued', taskContractRequired: !readOnly,
    launchContext: readOnly ? {
      source: 'cli', presentation: 'split', repoContext: 'transient', workMode: 'read-only',
    } : undefined,
  };
}

describe('prompt audit: required rules survive real renderers', () => {
  it.each(retainedRuleTokens)('retains every source token apart from prose emphasis in $file', ({ file, tokensSha256 }) => {
    const tokens = readFileSync(file, 'utf8').toLowerCase()
      .replaceAll('critical', 'required').replaceAll('hard rules', 'rules')
      .match(/[a-z0-9_]+/g)!.join(' ');
    expect(createHash('sha256').update(tokens).digest('hex')).toBe(tokensSha256);
  });
  it.each([false, true])('renders worker scope, authority and evidence (readOnly=%s)', async (readOnly) => {
    const prompt = measure(`worker-${readOnly ? 'read' : 'write'}`, await buildPacketPrompt(packet(readOnly), []));
    for (const rule of ['real entry point', 'scope', 'authority', 'Outcome, Evidence, Residual, and Decision',
      '800-line', '<self-review>', '"evidence"', '"residual"', '"decision"']) {
      expect(prompt.toLowerCase(), rule).toContain(rule.toLowerCase());
    }
    if (readOnly) {
      expect(prompt).toContain('Do not edit');
      expect(prompt).toContain('finding_ready');
      expect(prompt).not.toContain('git commit');
    } else {
      for (const rule of ['git diff main...HEAD', 'commit', 'two', 'partial', 'invariant',
        'every production path', 'expand-scope', 'task-contract', 'immutable', 'processConstraints',
        '800-line maximum', 'explicit waivers', 'o8 run --', 'before editing that path',
        'Style-only lint warnings are advisory', 'warnings that reveal real breakage',
        'set `decision: "partial"`', 'passed: false', 'authority remains',
        'verification passed', 'an exhausted retry', 'not commit a one-site patch',
        'Do not report completion without the self-review block.',
        'check `git status` before committing',
        'commit every file you created or changed for this task, including new untracked files',
        'Do not commit generated artifacts or files outside the task.',
        'Every file-backed requirement ID must appear in smallestRoute',
        'Never map a process constraint to a changed file as proof', '## Deviations']) {
        expect(prompt.toLowerCase(), rule).toContain(rule.toLowerCase());
      }
      expect(prompt.match(/Uncommitted changes/g)).toHaveLength(1);
    }
    expect(prompt).not.toMatch(shouting);
  });

  it('keeps sandbox and visual-proof limits in UI workers', async () => {
    const prompt = measure('worker-ui', await buildPacketPrompt(packet(false, true), []));
    for (const rule of ['Do not start Next.js/Tauri dev servers', 'operator follow-up', '--before', '--after',
      '--clip', '--full-page', '--hover', '--click', '--label']) expect(prompt.toLowerCase(), rule).toContain(rule.toLowerCase());
    expect(prompt).not.toMatch(shouting);
  });

  it.each(['claude', 'codex', 'pi'] as const)('renders scoped orchestrator authority (%s)', (backend) => {
    const prompt = measure(`orchestrator-${backend}`, buildOrchestratorSystemPrompt('/repo', {
      backend, firstRunClarify: false,
    }));
    const solo = measure(`orchestrator-${backend}-solo`, buildOrchestratorSystemPrompt('/repo', {
      backend, firstRunClarify: false, mcpServers: false,
    }));
    for (const rule of ['Outcome, Evidence, Residual, and Decision', 'submit_review', 'approve_and_merge',
      'SCOPE', 'GUARD', 'COMPLETENESS', 'requestedEffort', 'credentials', 'holdMerges',
      'Read-only and diagnostic requests remain non-mutating', 'catalog is not proof',
      'Never merge directly', 'Never skip the review step', 'Do not modify saved runtime pools',
      'do not repair a capability refusal by giving them an operator credential',
      'explicit instruction not to merge', 'The tool can add a restriction but cannot remove one',
      'unknown deliveries', 'Observation does not authorize steering unrelated sessions',
      'A refused pin is a blocker', 'do not create replacement packets',
      'does not impose a hold on the builder packet', 'approval HEAD',
      'side-effecting commands; read-only limits you to inspection',
      'npm run typecheck:fast', 'npm run typecheck:tsc', 'gh uses the operator', 'never use it for bulk listing or polling',
      'second skeptical pass', 'do not default to reject', 'Resolved unknowns',
      'o8 packet report --event huddle', 'stops before editing',
      'Claim only dispatches that happened', 'governance']) expect(prompt.toLowerCase(), rule).toContain(rule.toLowerCase());
    expect(prompt).not.toContain('more than 2 sequential read');
    const verdictTemplate = prompt.split('\n').find((line) => line.startsWith('VERDICT #'));
    expect(verdictTemplate).toBe('VERDICT #<issue>: <approve | reject | needs-follow-up>');
    expect(verdictTemplate).toMatch(/VERDICT\s*[#-]/);
    expect(prompt).toContain('You are the orchestrator for o8: the fleet-level brain');
    expect(prompt).toContain("`directivesApplied: ['<directive-title-or-filename>', ...]`: names");
    expect(prompt).toContain('`directivesViolated: [{directive, file, line, snippet?}, ...]`: names');
    expect(prompt).not.toMatch(shouting);
    expect(solo).not.toContain('cortex_launch_agent');
    expect(solo).toContain('scope and authority');
  });

  it.each([false, true])('renders independent review constraints (contract=%s)', (contractArmed) => {
    const taskContract = contractArmed ? {
      version: 1 as const,
      requirements: [{ id: 'R1', source: 'Fix behavior', expectedBehavior: 'Scoped behavior works',
        productionPath: 'entry -> handler', verification: 'entry test' }],
      smallestRoute: [{ path: 'src/handler.ts', requirements: ['R1'], reason: 'Owns behavior' }],
      processConstraints: [{ id: 'P1', source: 'Preserve scope', expectedBehavior: 'Only scoped writes',
        verification: 'command evidence' }], exclusions: [],
    } : undefined;
    const common = { diffSummary: 'src/handler.ts changed', taskContract, taskContractRequired: contractArmed };
    const review = measure(`review-${contractArmed}`, buildAutoReviewPromptV1({
      ...common, lane: { id: 'lane-1', label: 'Audit', branch: 'fix/audit', packetId: 'pkt-1' },
      depth: 'standard', worktreePath: '/repo', selfReviewSection: 'Claimed ready', deviationsEntries: [],
    }));
    const blind = measure(`review-blind-${contractArmed}`, buildBlindSecondPassPromptV1({
      ...common, laneLabel: 'Audit', branch: 'fix/audit', packetId: 'pkt-1', cwd: '/repo', highRiskReasons: ['scope'],
    }));
    for (const prompt of [review, blind]) {
      for (const rule of ['SCOPE', 'GUARD', 'COVERAGE', 'COMPLETENESS', 'INVARIANT:', 'SITE:',
        'Reviewer limitation:', 'process evidence']) expect(prompt.toLowerCase(), rule).toContain(rule.toLowerCase());
      if (contractArmed) for (const rule of ['R1', 'P1', 'MINIMALITY', 'PROCESS']) expect(prompt.toLowerCase(), rule).toContain(rule.toLowerCase());
      expect(prompt.toLowerCase()).toContain('actual call path');
      expect(prompt).not.toMatch(shouting);
    }
    if (contractArmed) expect(review).toContain('reviewedHeadSha must equal contractCoverageEvidence.headSha');
    expect(review).toContain('Operator follow-up:');
    for (const rule of ['partition=NONE', 'any guard is INERT', 'COVERAGE box is unchecked',
      'COMPLETENESS site is uncovered', 'list every uncovered `SITE:` line',
      'Tool failures are reviewer limitations, not packet defects',
      'Never invent process citations', 'process evidence at the reviewed HEAD',
      '--supplement-process-evidence', '--expected-sha <HEAD>', 'Never attempt a merge after a rejected or unrecorded verdict',
      'status "deferred" and approved=false', 'do not merge when the requested outcome is PR publication only']) {
      expect(review, rule).toContain(rule);
    }
    expect(review).toContain('only when the requested next action is a merge');
    expect(blind).toContain('Do not call submit_review');
    expect(blind).toContain('Do not call lane_command');
    expect(blind).toContain('SECOND_PASS_VERDICT: agree');
    expect(blind).toContain('SECOND_PASS_VERDICT: disagree');
  });

  it('retains tool-local payer policy, stop authority and correction limits', () => {
    for (const tool of [...TASK_CONTROL_TOOLS, ...CORTEX_WORKER_TOOLS]) {
      measure(`tool-${tool.name}`, tool.description);
    }
    const launch = TASK_CONTROL_TOOLS.find((tool) => tool.name === 'o8_launch_task')!.description;
    for (const rule of ['explicitly asks', 'taskId and contractHash', 'read-only', 'provider-default reasoning',
      'configured API credit', 'no native fallback', 'never retry', 'Cannot approve, merge or release']) {
      expect(launch, rule).toContain(rule);
    }
    const stop = TASK_CONTROL_TOOLS.find((tool) => tool.name === 'o8_stop_task')!.description;
    expect(stop).toContain('explicit user Stop request');
    expect(stop).toContain('Revokes further provider requests');
    const correction = CORTEX_WORKER_TOOLS.find((tool) => tool.name === 'cortex_correct_workers')!.description;
    for (const rule of ['explicit no-merge', 'acceptance, not model acknowledgement', 'never blindly repeated',
      'Does not change runtime, model, permissions or workspace']) expect(correction, rule).toContain(rule);
  });
});
