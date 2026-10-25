import { hasForgottenPacketOutcome } from '@/lib/cortex/outcome-exclusion';
import { readMemoryRevision } from '@/lib/cortex/memory-revision';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readClaudeCodeWorkerProfileSync } from '@/lib/claude-code/worker-profile';
import { buildContextBlock } from '@/lib/codebase-memory/build-context';
import { buildPacketCorrectionsSection } from '@/lib/cortex/operator-corrections';
import { resolvePacketAlignment } from '@/lib/orchestrator/alignment-access';
import { BRAIN_PROMPT_SECTION, resolvePacketBrainEnabled } from '@/lib/orchestrator/brain-access';
import { renderEdgeCaseSections } from '@/lib/dispatch/edge-case-surfacer';
import { renderReadBudgetSections } from '@/lib/dispatch/read-budget';
import { getTopRulesForPacket, readRepoScopedRules } from '@/lib/dispatch/rules-store';
import { readPacketAttemptLearnings, type AttemptLearning } from '@/lib/orchestrator/attempt-log';
import { readPacketCompletionContext } from '@/lib/orchestrator/context-relay';
import { buildPacketSpecPromptSection } from '@/lib/orchestrator/packet-spec';
import {
  buildPacketTaskContractInstructions,
  buildSealedPacketTaskContractInstructions,
} from '@/lib/orchestrator/packet-task-contract';
import { buildQualitySearchRolePrompt } from '@/lib/orchestrator/quality-search';
import { buildSessionRulesBlock } from '@/lib/orchestrator/session-rules-prompt';
import {
  buildPacketCompletionInstructions,
} from '@/lib/orchestrator/self-review';
import { buildWorkerOutcomeOwnershipPromptV1 } from '@/lib/prompts/v1';
import {
  resolveWorkerMcpInjection,
  workerMcpInjectionSupported,
} from '@/lib/mcp/worker-injection';
import { workerSandboxEnabled } from '@/lib/runtimes/shared/owned-session/sandbox';
import { pathWithNodeRuntime } from '@/lib/util/node-on-path';
import {
  buildDeviationsClause,
  packetImplementationNotesPath,
} from '@/lib/orchestrator/packet-deviations';
import type { OrchestratorPacket, PacketContext } from '@/lib/orchestrator/types';
import { truncateText } from '@/lib/util/text';

import { buildProjectVerificationPrompt } from './project-verification-prompt';
import { buildPreservationEnvelope, checkFileSizeThresholds } from './preservation-envelope';

function formatChangedFiles(changedFiles: string[]) {
  if (changedFiles.length === 0) {
    return 'none recorded';
  }
  if (changedFiles.length <= 6) {
    return changedFiles.join(', ');
  }
  return `${changedFiles.slice(0, 6).join(', ')} (+${changedFiles.length - 6} more)`;
}

function formatInlinePromptList(items: string[], maxItems = 4) {
  if (items.length === 0) {
    return '';
  }
  if (items.length <= maxItems) {
    return items.join('; ');
  }
  return `${items.slice(0, maxItems).join('; ')} (+${items.length - maxItems} more)`;
}

const CLAUDE_CODE_SKILL_BOUNDARY = 'Claude Code skills are unavailable in this dispatched worker. Do not invoke user or repository skills; only operator-allowlisted skill instructions embedded in this prompt apply.';
const MAX_ALLOWLISTED_SKILL_PROMPT_CHARS = 32_000;

function buildClaudeCodeSkillSections(packet: OrchestratorPacket): string[] {
  if (packet.runtime !== 'claude-code') return [];
  const sections = [CLAUDE_CODE_SKILL_BOUNDARY];
  const repoPath = packet.workspaceTargetPath?.trim();
  if (!repoPath) return sections;

  let remainingChars = MAX_ALLOWLISTED_SKILL_PROMPT_CHARS;
  for (const skillName of readClaudeCodeWorkerProfileSync().repoSkillAllowlist ?? []) {
    if (remainingChars <= 0) break;
    const skillPath = path.join(repoPath, '.claude', 'skills', skillName, 'SKILL.md');
    try {
      const instructions = readFileSync(skillPath, 'utf8').trim();
      if (!instructions) continue;
      const bounded = truncateText(instructions, Math.min(8_000, remainingChars));
      sections.push(`Operator-allowlisted repository skill "${skillName}":\n${bounded}`);
      remainingChars -= bounded.length;
    } catch (error) {
      console.warn(`[claude-code-skills] Unable to load allowlisted skill ${skillName}:`, error);
    }
  }
  return sections;
}

function formatPacketReviewFallback(packet: OrchestratorPacket): string[] {
  const review = packet.review;
  if (!review) {
    return [];
  }

  const findings = review.findings.map((finding) => {
    const location = typeof finding.line === 'number' ? `${finding.file}:${finding.line}` : finding.file;
    const fixSuggestion = finding.fixSuggestion ? ` Fix suggestion: ${finding.fixSuggestion}` : '';
    return `${location} [${finding.severity}] ${finding.description}${fixSuggestion} -> ${finding.resolution}`;
  });

  return [
    `Dependency review verdict: ${review.approved ? 'approved' : 'changes requested'}`,
    review.summary ? `Review summary: ${truncateText(review.summary, 800)}` : null,
    findings.length > 0 ? `Review findings: ${truncateText(findings.join(' | '), 1_000)}` : null,
  ].filter((value): value is string => Boolean(value));
}

function formatContextReviewFindings(reviewFindings: PacketContext['reviewFindings']) {
  if (!reviewFindings || reviewFindings.length === 0) {
    return '';
  }

  return formatInlinePromptList(
    reviewFindings.map((finding) => {
      const location = finding.file && finding.file !== 'unknown'
        ? (typeof finding.line === 'number' ? `${finding.file}:${finding.line}` : finding.file)
        : null;
      const description = truncateText(finding.description, 180);
      const fixSuggestion = finding.fixSuggestion ? ` Fix: ${truncateText(finding.fixSuggestion, 120)}` : '';
      return location ? `${location} ${description}${fixSuggestion}` : `${description}${fixSuggestion}`;
    }),
    3,
  );
}

function buildReviewLessonSections(
  dependencyTitle: string,
  context: PacketContext,
): string[] {
  const sections: string[] = [];

  if (context.reviewFindings && context.reviewFindings.length > 0) {
    sections.push(
      `Lessons from prior agents: Agent working on '${dependencyTitle}' had ${context.reviewFindings.length} review finding${context.reviewFindings.length === 1 ? '' : 's'} caught during review: ${formatContextReviewFindings(context.reviewFindings)}. Watch for similar patterns.`,
    );
  }

  if (context.patterns && context.patterns.length > 0) {
    sections.push(
      `Patterns to follow: ${formatInlinePromptList(context.patterns.map((pattern) => truncateText(pattern, 180)), 4)}`,
    );
  }

  if (context.conflictZones && context.conflictZones.length > 0) {
    sections.push(
      `Conflict zone warnings: Files modified by dependency: ${formatInlinePromptList(context.conflictZones, 4)}`,
    );
  }

  return sections;
}

function extractAttemptLearningErrors(typecheckOutput?: string): string[] {
  if (!typecheckOutput?.trim()) {
    return [];
  }

  const seen = new Set<string>();
  return typecheckOutput
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => truncateText(line.trim(), 220, { normalizeWhitespace: true }))
    .filter((line) => line.length > 0 && /error\b/i.test(line))
    .filter((line) => {
      if (seen.has(line)) {
        return false;
      }
      seen.add(line);
      return true;
    })
    .slice(0, 3);
}

function buildAttemptLearningSections(learnings: AttemptLearning[]): string[] {
  return [...learnings]
    .sort((left, right) => left.attempt - right.attempt)
    .flatMap((learning) => {
      const keyErrors = extractAttemptLearningErrors(learning.typecheckOutput);
      return [
        `Attempt ${learning.attempt}: ${truncateText(learning.summary, 500, { normalizeWhitespace: true })}`,
        keyErrors.length > 0 ? `Key errors: ${truncateText(keyErrors.join(' | '), 1_000)}` : null,
        learning.filesChanged.length > 0 ? `Files implicated: ${formatInlinePromptList(learning.filesChanged, 4)}` : null,
      ].filter((value): value is string => Boolean(value));
    });
}

function buildLearnedRuleSection(
  packet: OrchestratorPacket,
  packetType: string,
): string | null {
  const repoPath = packet.workspaceTargetPath?.trim();
  if (!repoPath) {
    return null;
  }

  try {
    const seen = new Set<string>();
    const rules = [
      ...readRepoScopedRules(repoPath).map((ruleText) => ({ ruleText, source: 'file' as const })),
      ...getTopRulesForPacket({
        repoPath,
        packetType,
        limit: 5,
      }),
    ].flatMap((rule) => {
      const ruleText = truncateText(rule.ruleText, 200, { normalizeWhitespace: true });
      const normalizedRuleText = ruleText.toLowerCase();
      if (!ruleText || seen.has(normalizedRuleText)) {
        return [];
      }
      seen.add(normalizedRuleText);
      return [`- ${ruleText}`];
    });

    if (rules.length === 0) {
      return null;
    }

    return truncateText([
      'Learned guardrails for this repo (from past reviews):',
      ...rules,
    ].join('\n'), 800);
  } catch (error) {
    console.warn('[learned-rules] fetch failed:', error);
    return null;
  }
}

const UI_PACKET_PATH_PATTERNS = [
  /^src\/app\//,
  /^src\/components\//,
  /^src\/lib\/desktop\//,
  /^src\/lib\/mobile\//,
  /^src\/lib\/panel\//,
  /^src-tauri\//,
];

const UI_PACKET_TEXT_PATTERN = /\b(?:ui|ux|desktop|mobile|dashboard|panel|modal|popover|settings|button|tab|layout|component|render|visual|dismiss|open\/close|browser|webview|tauri|safari)\b/i;

function normalizePromptPath(value: string): string {
  return value.trim().replace(/^\.\//, '').split(':')[0] ?? '';
}

function collectPacketPaths(packet: OrchestratorPacket): string[] {
  return [
    ...(packet.predictedFiles ?? []),
    ...(packet.allowedFiles ?? []),
    ...(packet.readBudget?.requiredReads ?? []),
    ...(packet.edgeCaseSites?.map((site) => site.location) ?? []),
  ].map(normalizePromptPath).filter(Boolean);
}

function packetLooksUiShaped(packet: OrchestratorPacket): boolean {
  const packetPaths = collectPacketPaths(packet);
  if (packetPaths.some((filePath) => UI_PACKET_PATH_PATTERNS.some((pattern) => pattern.test(filePath)))) {
    return true;
  }

  const scopeText = [
    packet.title,
    packet.summary,
    packet.issue?.body,
    ...packetPaths,
  ].filter((value): value is string => Boolean(value)).join('\n');

  return UI_PACKET_TEXT_PATTERN.test(scopeText);
}

function buildSandboxVerificationSections(packet: OrchestratorPacket): string[] {
  if (!packetLooksUiShaped(packet)) {
    return [];
  }

  return [
    'Sandbox-aware UI verification:',
    '- This packet is UI-shaped. Do not start Next.js/Tauri dev servers, attach to a browser, load `/dashboard`, or wait on click-through smoke tests from inside the packet sandbox.',
    '- Verify with `npm run typecheck`, targeted lint on changed files when practical, and diff/static review. Lint warnings remain advisory unless they reveal real breakage.',
    '- If a real DOM/browser smoke is still needed, list it as an operator follow-up instead of keeping the lane running.',
    '- Do not claim a smoke test was performed unless an actual command or browser interaction completed in the transcript.',
  ];
}

async function buildDependencyContextSections(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
): Promise<string[]> {
  if (packet.dependencyPacketIds.length === 0) {
    return [];
  }

  const packetById = new Map(allPackets.map((candidate) => [candidate.id, candidate]));
  const results = await Promise.allSettled(
    packet.dependencyPacketIds.map(async (dependencyPacketId) => {
      const dependencyPacket = packetById.get(dependencyPacketId);
      const context = await readPacketCompletionContext(dependencyPacketId);
      return { context, dependencyPacket, dependencyPacketId };
    }),
  );

  return results
    .filter((result): result is PromiseFulfilledResult<{
      context: Awaited<ReturnType<typeof readPacketCompletionContext>>;
      dependencyPacket: OrchestratorPacket | undefined;
      dependencyPacketId: string;
    }> => result.status === 'fulfilled')
    .flatMap(({ value }) => {
      const dependencyTitle = value.dependencyPacket?.title
        ?? value.dependencyPacket?.referenceLabel
        ?? value.dependencyPacketId;
      const reviewSections = value.context
        ? buildReviewLessonSections(dependencyTitle, value.context)
        : value.dependencyPacket && !hasForgottenPacketOutcome(value.dependencyPacketId) && readMemoryRevision() === '0'
          ? formatPacketReviewFallback(value.dependencyPacket)
          : [];

      if (!value.context) {
        return reviewSections.length > 0
          ? [
              `Dependency '${dependencyTitle}' review context:`,
              ...reviewSections,
            ]
          : [];
      }

      return [
        `Previous work from dependency '${dependencyTitle}': ${truncateText(value.context.summary, 1_000)}`,
        `Files changed: ${formatChangedFiles(value.context.changedFiles)}`,
        ...reviewSections,
      ];
    });
}

async function assemblePacketPrompt(
  packet: OrchestratorPacket,
  allPackets: OrchestratorPacket[],
  baseBranch = 'main',
  worktreePath?: string | null,
) {
  const dependencySections = await buildDependencyContextSections(packet, allPackets);
  // #1500 — read learnings unconditionally by packet id. The old gate
  // (`attemptCount > 0` + worktree-local file) went dark on exactly the
  // respawns that needed it: silent-exit verification failures never bumped
  // attemptCount, and a fresh-clone worktree had no learnings file — so five
  // identical briefs went out against the same violation.
  const priorAttemptLearningSections = buildAttemptLearningSections(
    await readPacketAttemptLearnings(packet.id, worktreePath),
  );
  // #2219 — a rejection reason or steer message recorded against this packet
  // reaches the next worker dispatched or rerun on it.
  const operatorCorrectionsSection = buildPacketCorrectionsSection(packet.id);
  const fileSizeSections = checkFileSizeThresholds(packet);
  const preservationSections = buildPreservationEnvelope(packet);
  const packetType = packet.title.trim().split(/\s+/)[0]?.toLowerCase() || 'feat';
  const learnedRuleSection = buildLearnedRuleSection(packet, packetType);
  // #535 — Read-before-write scaffolding. When the delegate route or
  // scheduler populated `packet.readBudget`, render it into the prompt so
  // weaker models see the required reads + plan gate up-front. Legacy
  // packets without `readBudget` skip this block entirely.
  const readBudgetSections = renderReadBudgetSections(packet.readBudget);
  // #536 — Edge-case surfacer output. When the surfacer populated
  // `packet.edgeCaseSites`, render them as a grouped "Watch for these"
  // block so weaker models see adjacent risk surfaces up-front.
  const edgeCaseSections = renderEdgeCaseSections(packet.edgeCaseSites);
  const sandboxVerificationSections = buildSandboxVerificationSections(packet);
  const implementationNotesPath = packetImplementationNotesPath(packet.id);
  const taskContractSections = packet.taskContract
    ? buildSealedPacketTaskContractInstructions(packet.taskContract, implementationNotesPath)
    : packet.taskContractRequired
      ? buildPacketTaskContractInstructions(implementationNotesPath)
      : [];
  const qualitySearchRoleSection = packet.qualitySearch?.role
    ? buildQualitySearchRolePrompt(packet.qualitySearch.role)
    : null;
  // 2026-06-11 — "Workers use the Brain". Per-packet override > operator
  // setting ('auto' = non-frontier runtimes only). Tells the worker about
  // `o8 ask` so it queries org memory instead of re-deriving it via search.
  const brainSection = resolvePacketBrainEnabled(packet) ? BRAIN_PROMPT_SECTION : null;
  // #1329 — worker inheritance. The dispatching orchestrator thread's active
  // session rules ("Operator session rules (binding)") flow into the worker so
  // a rule set in the thread governs every Codex worker dispatched from it.
  // Null when the packet has no originating thread or that thread has no rules.
  const sessionRulesSection = buildSessionRulesBlock(packet.orchestratorThreadId);
  const claudeCodeSkillSections = buildClaudeCodeSkillSections(packet);
  const workerMcpResolution = workerMcpInjectionSupported(packet.runtime)
    ? await resolveWorkerMcpInjection({
        packetId: packet.id,
        worktreePath: worktreePath ?? packet.lane?.worktreePath ?? packet.workspaceTargetPath ?? '',
        branch: packet.branchTarget,
        laneId: packet.lane?.laneId,
      }, {
        resolveCommands: workerSandboxEnabled(),
        pathValue: pathWithNodeRuntime(),
      })
    : { servers: [] };
  const workerMcpSection = workerMcpResolution.servers.length > 0
    ? [
        `MCP servers attached to this packet: ${workerMcpResolution.servers
          .map((server) => `${server.name} (${server.command})`)
          .join(', ')}.`,
        'Use these attached tools when they are relevant to the packet.',
      ]
    : [];
  const readOnlyPacket = packet.launchContext?.workMode === 'read-only';
  const projectVerificationSection = readOnlyPacket ? null : await buildProjectVerificationPrompt(
    worktreePath ?? packet.lane?.worktreePath,
    packet.workspaceTargetPath,
  );
  const outcomeOwnershipSection = buildWorkerOutcomeOwnershipPromptV1(readOnlyPacket);
  // Alignment turn (#1282 Huddle + single-sub Advisor) — armed per-mission by
  // the orchestrator (huddle flag) OR auto-armed for cheap-tier workers (advisor
  // rule). When on, the worker posts its plan + pushback and STOPS before
  // editing. The unified resolver ORs both sources and picks EXACTLY ONE prompt
  // block — huddle wins; advisor only when huddle is off — so the two overlapping
  // "align before you edit" blocks can never stack (#1512 de-dup contract).
  const alignmentSection = readOnlyPacket ? null : resolvePacketAlignment(packet).promptSection;
  // #1147 — visual proof. Only nudge UI-shaped packets, and only when they
  // legitimately run their own app (NOT o8's dev servers — the sandbox block
  // above forbids that). Pure-logic packets get nothing (no visual to show).
  const captureProofSection = !readOnlyPacket && packetLooksUiShaped(packet)
    ? 'Visual proof (UI changes): only when the task legitimately serves its own app, capture the broken state with `o8 packet capture --url <localhost-url> --before --label "<what>" --wait-for "<selector>"`, then capture the fix with `--after` and the same --label. The pair appears in packet review and chat. Prefer `--clip "<sel>"` for a localized change; use `--full-page` for whole-page layouts. Add `--hover "<sel>"` or `--click "<sel>"` for interaction states. Follow the sandbox restrictions above; never start o8 dev servers for this. Skip pure-logic/backend changes.'
    : null;
  // #743 — Cortex context block. Pull directives + recent outcomes +
  // symbol-graph for this repo and prepend a `<context>` envelope so the
  // runtime sees the same recall data the operator sees on the packet
  // card. Helper degrades gracefully (codebase-memory binary missing,
  // empty DB, etc.) and returns an empty string when nothing useful
  // resolved — that's the legacy path.
  const contextBlock = packet.workspaceTargetPath
    ? await buildContextBlock({
        repoPath: packet.workspaceTargetPath,
        excludeCorrectionsForPacketId: packet.id,
        packetBody: [packet.title, packet.summary, packet.issue?.body]
          .filter((value): value is string => Boolean(value))
          .join('\n\n'),
      })
    : '';
  // #773 — Live spec injection. The operator can edit a per-packet spec in
  // the Mission panel; we re-read it here so each NEW dispatch gets the
  // current content. Running agents are not steered — only the next launch
  // (or rerun) sees an edited spec. Returns null when no spec exists.
  const livePacketSpec = await buildPacketSpecPromptSection(packet.id);
  if (contextBlock) {
    console.log(`[context-injection] Prepended <context> block for packet ${packet.id} (${contextBlock.length} chars)`);
  }
  if (livePacketSpec) {
    console.log(`[packet-spec] Injected live spec for packet ${packet.id} (${livePacketSpec.length} chars)`);
  }
  if (dependencySections.length > 0) {
    console.log(`[context-relay] Injected dependency context for packet ${packet.id}`);
  }
  if (priorAttemptLearningSections.length > 0) {
    console.log(`[dispatch] Injected prior attempt learnings for packet ${packet.id}`);
  }
  if (operatorCorrectionsSection) {
    console.log(`[operator-corrections] Injected prior rejection/steer reasons for packet ${packet.id}`);
  }
  if (fileSizeSections.length > 0) {
    console.log(`[dispatch] Injected file size governance guidance for packet ${packet.id}`);
  }
  if (preservationSections.length > 0) {
    console.log(`[dispatch] Injected preservation envelope for packet ${packet.id} (${preservationSections.length - 2} files)`);
  }
  if (learnedRuleSection) {
    console.log(`[learned-rules] Injected learned guardrails for packet ${packet.id} (${packetType})`);
  }
  if (readBudgetSections.length > 0) {
    console.log(`[read-budget] Injected read-before-write scaffolding for packet ${packet.id} (${packet.readBudget?.requiredReads.length ?? 0} required reads, minToolCalls=${packet.readBudget?.minToolCalls ?? 0})`);
  }
  if (edgeCaseSections.length > 0) {
    console.log(`[edge-case-surfacer] Injected ${packet.edgeCaseSites?.length ?? 0} edge-case sites for packet ${packet.id}`);
  }
  if (sandboxVerificationSections.length > 0) {
    console.log(`[dispatch] Injected sandbox-aware UI verification guidance for packet ${packet.id}`);
  }
  if (brainSection) {
    console.log(`[brain-access] Injected Engineering Brain instructions for packet ${packet.id} (runtime=${packet.runtime})`);
  }
  if (sessionRulesSection) {
    console.log(`[session-rules] Injected session rules for packet ${packet.id} (thread=${packet.orchestratorThreadId})`);
  }

  return [
    contextBlock || null,
    // Session rules ride at the TOP — binding operator constraints the worker
    // reads before the task itself.
    sessionRulesSection,
    ...claudeCodeSkillSections,
    `Packet: ${packet.title}`,
    packet.summary ? `Summary: ${packet.summary}` : null,
    livePacketSpec,
    outcomeOwnershipSection,
    alignmentSection,
    packet.branchTarget ? `Branch target: ${packet.branchTarget}` : null,
    ...workerMcpSection,
    packet.dependencyLabels.length > 0 ? `Dependencies: ${packet.dependencyLabels.join(', ')}` : null,
    dependencySections.length > 0 ? 'Dependency handoff context:' : null,
    ...dependencySections,
    priorAttemptLearningSections.length > 0 ? 'Prior attempt learnings:' : null,
    ...priorAttemptLearningSections,
    operatorCorrectionsSection,
    ...fileSizeSections,
    ...preservationSections,
    ...readBudgetSections,
    ...edgeCaseSections,
    ...sandboxVerificationSections,
    ...taskContractSections,
    qualitySearchRoleSection,
    // #1490/#1802 — every worker keeps an ignored packet-scoped notes artifact
    // and logs forced departures under a '## Deviations' heading; review reads
    // it back and surfaces it without polluting the branch diff.
    readOnlyPacket ? null : buildDeviationsClause(packet.id),
    'Files in this repository follow an 800-line maximum. If your implementation would push a file past this threshold, extract code into focused modules first, then implement your changes. Files with explicit waivers are exempt from this rule.',
    'If a task step needs a long-running or long-output process — a test suite, build, backtest, data job, or a server the task itself requires — start it with `o8 run -- <cmd>` (e.g. `o8 run -- pytest -q`) rather than a bare shell exec, so the operator can watch its live output. This is about genuinely long jobs; still follow any sandbox UI-verification guidance above (do not start dev servers just to smoke-test).',
    captureProofSection,
    brainSection,
    learnedRuleSection,
    projectVerificationSection,
    ...buildPacketCompletionInstructions(readOnlyPacket, baseBranch),
    readOnlyPacket ? null : 'If the task requires a path outside the packet allowlist, request a bounded audited expansion with `o8 packet expand-scope --paths <path[,path]> --reason "<why the task requires it>"` before editing that path.',
    'Stay within this packet scope. Surface blockers, review handoffs, and required operator decisions explicitly.',
  ].filter((value): value is string => Boolean(value)).join('\n');
}

/** A concurrent forget invalidates all fragments assembled before its commit. */
export async function buildPacketPrompt(
  packet: OrchestratorPacket, allPackets: OrchestratorPacket[], baseBranch = 'main', worktreePath?: string | null,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const revision = readMemoryRevision();
    const prompt = await assemblePacketPrompt(packet, allPackets, baseBranch, worktreePath);
    if (revision === readMemoryRevision()) return prompt;
  }
  throw new Error('Worker memory changed during prompt assembly. Retry dispatch.');
}
