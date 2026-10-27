import { controlledProviderConfig } from '@/lib/runtimes/shared/owned-session/controlled-provider';
import { codexModelDiscoveryHome } from '@/lib/codex/model-discovery-cache';
import { createOwnedExecutionPolicy } from '@/lib/runtimes/shared/owned-session/execution-policy';
import type { RuntimeLaunchRequest } from './actions';
import type { WorkerWorkMode } from '@/lib/orchestrator/types';

/** Validate before checkout, lane or process effects; adapters must not fill missing pins. */
export function assertSingleAttemptLaunch(input: RuntimeLaunchRequest, workMode?: WorkerWorkMode): void {
  if (input.controlledProvider && (!input.controlledTask || input.executionPolicy !== 'single-attempt')) {
    throw new Error('Controlled provider requires a reviewed single-attempt task.');
  }
  if (input.executionPolicy === undefined) return;
  createOwnedExecutionPolicy({ cwd: input.cwd ?? '', prompt: input.prompt,
    controlledTask: input.controlledTask, executionPolicy: input.executionPolicy, model: input.model, effort: input.effort,
    runtimeConfig: { ...controlledProviderConfig(input.controlledProvider), ...(workMode ? { workMode } : {}),
      ...(input.executionCarrier ? { executionCarrier: input.executionCarrier } : {}),
      ...(input.claudeCodeCarrier ? { modelSource: input.claudeCodeCarrier } : {}) } }, input.runtime,
  input.runtime === 'codex' ? codexModelDiscoveryHome() : undefined);
  if (input.claudeCodeModel !== undefined && input.claudeCodeModel !== input.model) {
    throw new Error('Single-attempt worker model pins disagree.');
  }
  if (input.runtime === 'claude-code' && input.claudeCodeCarrier !== (input.controlledProvider ? 'openrouter' : 'native')) {
    throw new Error('Single-attempt Claude Code workers require an explicit native carrier.');
  }
}
