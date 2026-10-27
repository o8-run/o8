import { parseLocalModel } from '@/lib/codex/local-model';
import { EffortPinRejectionError, resolveEffortPin } from '@/lib/orchestrator/effort-pin';
import { resolveDefaultDispatchModelSync } from '@/lib/operator/defaults';
import { MODEL_IDS } from '@/lib/models';
import { BRAIN_PROMPT_SECTION } from '@/lib/orchestrator/brain-access';
import { buildOrchestratorSystemPrompt } from './orchestrator-system-prompt';
import { CODEX_USER_MESSAGE_MARKER } from '@/lib/codex/app-bridge-spec';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';
import type { CodexOrchestratorPermissionMode } from './codex-orchestrator-session';
const DEFAULT_CODEX_MODEL = MODEL_IDS.codexDefault;
export function sandboxFlagsForMode(mode: CodexOrchestratorPermissionMode): string[] {
  // These flags go to both `codex exec` (first turn) and `codex exec resume`
  // (every turn after). `resume` rejects the `-s` short flag — passing it broke
  // every multi-turn conversation — so the read-only sandbox is set via a `-c`
  // config override, which both subcommands honor.
  if (mode === 'plan') {
    // Read-only sandbox — codex can read repo state and call MCP read methods
    // but cannot edit files or run side-effecting shell commands.
    return ['-c', 'sandbox_mode=read-only'];
  }
  // 'full' — autonomous mode for auto-review + intake.
  // `--dangerously-bypass-approvals-and-sandbox` bypasses approvals + the
  // sandbox and is accepted by `codex exec resume` (unlike `-s`).
  return ['--dangerously-bypass-approvals-and-sandbox'];
}

/** Omitted and adaptive lead choices leave effort to the runtime; explicit pins never normalize. */
export function reasoningEffortFromThinkingEffort(
  effort: ThinkingEffort | undefined,
  model?: string,
  compatibility: { installedCliVersion?: string | null; explicitModel?: string; codexHome?: string } = {},
): Exclude<ThinkingEffort, 'adaptive'> | undefined {
  const pin = resolveEffortPin({ runtime: 'codex', model: model ?? null,
    requestedEffort: effort, ...compatibility });
  if (!pin.ok) throw new EffortPinRejectionError(pin.code, pin.message);
  return (pin.selectedEffort as Exclude<ThinkingEffort, 'adaptive'> | null) ?? undefined;
}

/**
 * Resolve the orchestrator's Codex model. An explicit per-turn model always
 * wins. Otherwise: if the operator's default dispatch model is a LOCAL model
 * (`ollama:` / `lmstudio:`), the orchestrator runs on it too — so a zero-cloud-
 * key dev's chat surface works end-to-end on their own machine. A *cloud*
 * dispatch model does NOT change the orchestrator default (workers and the
 * orchestrator are separate concerns on the cloud path), so the configured
 * Codex flagship default is preserved exactly.
 */
export function resolveOrchestratorModelSync(explicit?: string): string {
  const trimmed = explicit?.trim();
  // Cross-backend bleed guard (live-hit 2026-07-05): the chat surface passes
  // the UI-selected CLAUDE model (e.g. claude-opus-4-8) as the explicit model
  // when the operator flips orchestratorBackend to codex — codex exec can't
  // run an Anthropic model id and the turn hangs forever with nothing
  // streamed. A claude-* explicit model is a backend mismatch, not a choice:
  // fall through to the codex default instead of trusting it.
  if (trimmed && !/^claude/i.test(trimmed)) return trimmed;
  const dispatch = resolveDefaultDispatchModelSync().trim();
  if (dispatch && parseLocalModel(dispatch)) return dispatch;
  return DEFAULT_CODEX_MODEL;
}

/**
 * Build the model `-c`/flag pairs for `codex exec`. A local model expands to the
 * `--oss --local-provider … --model` form (no reasoning-effort tier — local
 * models don't have one). A cloud model sends an effort override only for a
 * concrete pin; omission leaves the runtime's configured default in effect.
 */
export function codexOrchestratorModelFlags(model: string, reasoningEffort?: string): string[] {
  const local = parseLocalModel(model);
  if (local) {
    return ['--oss', '--local-provider', local.provider, '--model', local.model];
  }
  return ['-c', `model=${model}`, ...(reasoningEffort ? ['-c', `model_reasoning_effort=${reasoningEffort}`] : [])];
}

function codexBrainFirstSection(mcpServers: boolean): string {
  const askVia = mcpServers ? 'via the `cortex_ask` MCP tool (or `o8 ask` from shell)' : 'with `o8 ask` from shell';
  return [
    '## ENGINEERING BRAIN — USE THIS FIRST',
    BRAIN_PROMPT_SECTION,
    `Codex orchestrator rule: on every turn, if you need repo conventions, history, ownership, prior fixes, directives, or cross-repo context, ask the Engineering Brain first ${askVia} before grepping or re-reading broad files. One focused Brain question is the default context-gathering step; use direct file reads after the Brain points you at current source or when exact code is needed.`,
  ].join('\n\n');
}

export function buildCodexOrchestratorPrompt(
  repoPath: string,
  message: string,
  scope: { toolProfile?: ToolProfile; orchestrationMode?: OrchestratorExecutionMode } = {},
): string {
  // Single mode launches Codex with `mcp_servers={}` (codexOrchestrationModeFlags).
  const mcpServers = scope.orchestrationMode !== 'single';
  const instructions = [
    buildOrchestratorSystemPrompt(repoPath, { backend: 'codex', toolProfile: scope.toolProfile, mcpServers }),
    codexBrainFirstSection(mcpServers),
  ].join('\n\n');
  return `${instructions}${CODEX_USER_MESSAGE_MARKER}${message}`;
}
