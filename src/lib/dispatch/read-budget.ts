/**
 * Dispatch — read-before-write scaffolding (#535).
 *
 * Given a packet's target files and the model tier that will run it, compute
 * a `readBudget` that forces weaker models to mimic Codex xhigh's spontaneous
 * "read the surface first, write second" behaviour.
 *
 * The budget is rendered into the packet prompt (system-prompt enforcement —
 * the only enforcement strategy the current CLI-based adapters support). A
 * toolset-shaping wrapper is exposed for future runtimes that do surface a
 * pluggable tool list.
 *
 * This module is intentionally pure — no I/O, no promises — so it can be
 * called from both the delegate API route and the scheduling hot path.
 */

import { getImportGraph } from '@/lib/skeleton';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

/**
 * Model-tier buckets recognized by the dispatcher. Keys map from either a
 * runtime+assignedModel pair or a free-text model string (case-insensitive
 * substring match, see {@link resolveModelTier}).
 */
export type ModelTier =
  | 'codex-strong'    // Self-directed reading — minimal explicit budget needed
  | 'claude-mid'      // Guided reading — moderate scaffolding helps
  | 'weak'            // Scaffolded reading — explicit reads and planning help
  | 'unknown';        // Fallback — use the guided-reading preset

interface BudgetPreset {
  minToolCalls: number;
  planBeforeWrite: boolean;
  /** Cap on requiredReads list — weaker tiers get a larger but capped set. */
  maxRequiredReads: number;
}

const BUDGET_PRESETS: Record<ModelTier, BudgetPreset> = {
  // Codex xhigh / Opus already read the surface spontaneously. Budget is near
  // zero so we don't slow them down, but we still populate `requiredReads`
  // because it reconfirms what the model would have found anyway.
  'codex-strong': {
    minToolCalls: 4,
    planBeforeWrite: false,
    maxRequiredReads: 6,
  },
  'claude-mid': {
    minToolCalls: 10,
    planBeforeWrite: true,
    maxRequiredReads: 10,
  },
  // Weak models need the strictest scaffolding — plan turn mandatory, largest
  // pre-computed read list, highest minimum tool-call count.
  weak: {
    minToolCalls: 20,
    planBeforeWrite: true,
    maxRequiredReads: 14,
  },
  unknown: {
    minToolCalls: 10,
    planBeforeWrite: true,
    maxRequiredReads: 10,
  },
};

/**
 * Map a runtime + assigned-model pair onto a tier bucket.
 *
 * Heuristics intentionally pessimistic — when in doubt, assume the weaker
 * tier so the scaffolding kicks in rather than being skipped.
 */
export function resolveModelTier(input: {
  runtime: OrchestratorPacket['runtime'];
  assignedModel?: string | null;
}): ModelTier {
  const model = (input.assignedModel ?? '').trim().toLowerCase();

  if (model) {
    if (model.includes('xhigh') || model.includes('gpt-5') || model.includes('o1') || model.includes('opus-4-8') || model.includes('opus-4-7') || model.includes('opus-4-6[1m]')) {
      return 'codex-strong';
    }
    if (model.includes('opus') || model.includes('sonnet')) {
      return 'claude-mid';
    }
    if (model.includes('haiku') || model.includes('flash') || model.includes('nano') || model.includes('mini') || model.includes('opencode')) {
      return 'weak';
    }
  }

  // Problem C — exhaustive dispatch switch: tier classification by runtime default model.
  // Each runtime has a different default compute tier when no explicit model is specified.
  // Add a new runtime case here when adding a new adapter. Cannot be collapsed to a label lookup.
  if (input.runtime === 'codex' && !model) {
    return 'codex-strong';
  }
  if (input.runtime === 'claude-code' && !model) {
    return 'claude-mid';
  }
  if (input.runtime === 'opencode' && !model) {
    return 'weak';
  }
  return 'unknown';
}

export interface ReadBudget {
  minToolCalls: number;
  requiredReads: string[];
  planBeforeWrite: boolean;
}

export interface ComputeReadBudgetInput {
  repoPath: string;
  targetFiles: string[];
  tier: ModelTier;
  /** Optional explicit paths always added to `requiredReads` first. */
  extraReads?: string[];
}

/**
 * Pure helper — compute a read budget for the given target files + tier.
 *
 * Returns `null` when the caller should NOT attach a budget (no target
 * files, codex-strong tier with an empty import graph — the explicit skip
 * keeps legacy packets behaviour-identical when `readBudget` is absent).
 */
export function computeReadBudget(input: ComputeReadBudgetInput): ReadBudget | null {
  const { repoPath, tier } = input;
  const preset = BUDGET_PRESETS[tier];

  const targets = Array.from(new Set(
    (input.targetFiles ?? [])
      .map((value) => (value ?? '').trim())
      .filter(Boolean),
  ));

  if (targets.length === 0) {
    return null;
  }

  // Breadth-first graph walk across ALL targets, depth=1. Two-hop would blow
  // the prompt token budget for wide leaves.
  const seen = new Set<string>(targets);
  const requiredReads: string[] = [...(input.extraReads ?? []).filter(Boolean)];

  for (const target of targets) {
    const graph = getImportGraph(repoPath, target, 1);
    if (!graph.root) continue;

    for (const node of graph.nodes) {
      if (seen.has(node.filePath)) continue;
      seen.add(node.filePath);
      requiredReads.push(node.filePath);
      if (requiredReads.length >= preset.maxRequiredReads) break;
    }

    if (requiredReads.length >= preset.maxRequiredReads) break;
  }

  // No adjacent files resolved — the target is a leaf (or the skeleton cache
  // hasn't seen it yet). Only emit a budget for tiers that need one anyway.
  if (requiredReads.length === 0 && tier === 'codex-strong') {
    return null;
  }

  return {
    minToolCalls: preset.minToolCalls,
    requiredReads: requiredReads.slice(0, preset.maxRequiredReads),
    planBeforeWrite: preset.planBeforeWrite,
  };
}

// ── Prompt rendering ──

/**
 * Render a budget as prompt sections. Used by the packet-prompt composer to
 * inline-inject the guidance so the adapter-agnostic path (today) enforces
 * the budget via the system prompt itself.
 *
 * Returns an empty array when `budget` is undefined — call sites don't need
 * to guard.
 */
export function renderReadBudgetSections(
  budget: ReadBudget | undefined | null,
): string[] {
  if (!budget) return [];

  const sections: string[] = ['Read-before-write budget (governance scaffolding):'];

  if (budget.minToolCalls > 0) {
    sections.push(
      `- Make at least ${budget.minToolCalls} read-only tool calls (Read, Grep, Glob, read-only Bash) BEFORE editing any file.`,
    );
  }

  if (budget.requiredReads.length > 0) {
    const formatted = budget.requiredReads
      .slice(0, 14)
      .map((file) => `  - ${file}`)
      .join('\n');
    sections.push(
      `- Required reads (pre-computed import-graph fan-out). Read each before writing:\n${formatted}`,
    );
  }

  if (budget.planBeforeWrite) {
    sections.push(
      '- Plan turn required: the FIRST assistant message must be a plan with (1) files you intend to touch, (2) seams you will use, (3) constraints you will respect. No write tools until the plan is emitted.',
    );
  }

  sections.push(
    'This budget is enforced at the prompt layer today — take it seriously. Violating it is the fastest way to produce a failing dispatch.',
  );

  return sections;
}

// ── Toolset wrapper (future-ready seam) ──

/**
 * Placeholder representation for a runtime-shaped tool. Both Codex CLI and
 * Claude CLI execute tools out-of-process, so the "toolset" is really a
 * system-prompt contract today. `wrapToolsetWithReadGate` returns a
 * future-proof structure that runtimes can adopt when they expose a real
 * tool-list API.
 *
 * Today the wrapper's return value is consumed by {@link
 * renderReadBudgetSections} for system-prompt enforcement. When a runtime
 * grows a pluggable tool list (e.g. the cloud adapter, #514), it can switch
 * to reading `gated` directly.
 */
export interface GatedTool {
  name: string;
  kind: 'read' | 'write' | 'shell';
  /** When true, the tool requires the budget to be satisfied before use. */
  gated: boolean;
}

export function wrapToolsetWithReadGate(
  toolset: Array<{ name: string; kind: GatedTool['kind'] }>,
  budget: ReadBudget | undefined | null,
): { gated: GatedTool[]; enforcement: 'prompt' | 'toolset' | 'disabled' } {
  if (!budget) {
    return {
      gated: toolset.map((tool) => ({ ...tool, gated: false })),
      enforcement: 'disabled',
    };
  }

  return {
    gated: toolset.map((tool) => ({
      ...tool,
      gated: tool.kind !== 'read',
    })),
    // When a runtime adopts programmatic tool-list shaping, swap 'prompt' for
    // 'toolset' at the call site. The structure is forward-compatible.
    enforcement: 'prompt',
  };
}
