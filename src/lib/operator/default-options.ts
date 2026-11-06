import { MODEL_IDS } from '@/lib/models';
import { getRuntimeCapability, listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import type { ClassAComposer, OrchestratorBackendSetting } from './defaults-env';

export const CLASS_A_COMPOSER_OPTIONS: Array<{ value: ClassAComposer; label: string; detail: string }> = [
  { value: 'haiku-cli', label: 'Haiku', detail: 'Free for Claude Max users via the warm REPL pool.' },
  { value: 'sonnet-cli', label: 'Sonnet', detail: 'Best quality, free, slower bootstrap.' },
  { value: 'fastest', label: 'Fastest', detail: 'OpenRouter flash-lite first (~1-3s, pennies per question, daily-capped). Free tiers as fallback.' },
];

export const DISPATCH_RUNTIME_OPTIONS: Array<{ value: OrchestratorRuntime; label: string; detail: string }> =
  listDispatchableRuntimes().map((value) => {
    const capability = getRuntimeCapability(value);
    return { value, label: capability.label, detail: capability.description };
  });

export const ORCHESTRATOR_BACKEND_OPTIONS: Array<{ value: OrchestratorBackendSetting; label: string; detail: string }> = [
  { value: 'auto', label: 'Auto', detail: 'Follow the in-app orchestrator toggle below (Claude when on, Codex when off).' },
  { value: 'codex', label: 'Codex', detail: 'Codex GPT-6 Astra xhigh through the connected Codex subscription.' },
  { value: 'claude', label: 'Claude Code', detail: 'Resident Claude Code harness using the model source selected in Models.' },
  { value: 'openclaw', label: 'OpenClaw', detail: 'Governed openclaw orchestrator — dispatches Codex workers through o8.' },
  { value: 'hermes', label: 'Hermes', detail: 'Hermes via ACP — needs Hermes installed + a model provider configured (hermes setup).' },
  { value: 'collide', label: 'Collide', detail: 'Mixture-of-Agents: Claude + Codex propose independently, Claude synthesizes + does the work — the upgraded Claude.' },
  { value: 'pi', label: 'Pi (built-in)', detail: 'Bundled Pi on the o8 model allowance, with the full o8 command set. Preview; needs no other agent CLI.' },
];

export const PARALLEL_CAP_PRESETS: Array<{ key: 'conservative' | 'balanced' | 'power-user'; label: string; value: number }> = [
  { key: 'conservative', label: 'Conservative', value: 2 },
  { key: 'balanced', label: 'Balanced', value: 5 },
  { key: 'power-user', label: 'Power-user', value: 8 },
];

export const ORCHESTRATOR_MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: MODEL_IDS.raw.anthropicClaudeOpus55, label: 'Opus 5.5' },
  { value: MODEL_IDS.raw.anthropicClaudeFable51, label: 'Fable 5.1' },
  { value: MODEL_IDS.raw.anthropicClaudeFable5, label: 'Fable 5' },
  { value: MODEL_IDS.raw.anthropicClaudeOpus48, label: 'Opus 4.8' },
  { value: MODEL_IDS.raw.anthropicClaudeOpus47, label: 'Opus 4.7' },
  { value: MODEL_IDS.raw.anthropicClaudeOpus46, label: 'Opus 4.6' },
  { value: MODEL_IDS.raw.anthropicClaudeSonnet55, label: 'Sonnet 5.5' },
  { value: MODEL_IDS.raw.anthropicClaudeSonnet5, label: 'Sonnet 5' },
  { value: MODEL_IDS.raw.anthropicClaudeSonnet45, label: 'Sonnet 4.5' },
  { value: MODEL_IDS.raw.anthropicClaudeHaiku55, label: 'Haiku 5.5' },
  { value: MODEL_IDS.raw.anthropicClaudeHaiku45, label: 'Haiku 4.5' },
];
