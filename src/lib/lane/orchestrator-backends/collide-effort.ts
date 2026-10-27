import { selectedClaudeCodeWorkerModelSync } from '@/lib/claude-code/worker-profile';
import { EffortPinRejectionError, resolveEffortPin } from '@/lib/orchestrator/effort-pin';
import { resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import { resolveCachedCodexOrchestratorModel, userCodexHome } from '../codex-orchestrator-config';
import { resolveOrchestratorModelSync } from '../codex-orchestrator-options';
import { resolveClaudeOrchestratorModel } from '../orchestrator-model-guard';
import type { MoaParticipant } from './moa';

/** Validate the whole composition before any participant can start inference. */
export async function assertCollideEffortPins(proposers: readonly MoaParticipant[], aggregator: MoaParticipant): Promise<void> {
  const choices = [...proposers.map((participant, index) => ({ participant, role: `proposer ${index + 1}` })),
    { participant: aggregator, role: 'aggregator' }];
  const pins = choices.flatMap(({ participant, role }) => {
    const effort = participant.thinkingEffort;
    if (effort === undefined || effort === 'adaptive') return [];
    const runtime = participant.backend === 'claude' ? 'claude-code' : participant.backend;
    const model = participant.backend === 'claude'
      ? selectedClaudeCodeWorkerModelSync() ?? resolveClaudeOrchestratorModel(participant.model)
      : participant.backend === 'codex'
        ? resolveCachedCodexOrchestratorModel(resolveOrchestratorModelSync(participant.model)).model
        : participant.model ?? null;
    const input = { runtime, model, explicitModel: participant.model, requestedEffort: effort,
      codexHome: runtime === 'codex' ? userCodexHome() : undefined };
    const pin = resolveEffortPin(input);
    if (!pin.ok) throw new EffortPinRejectionError(pin.code, `Collide ${role}: ${pin.message}`);
    return [{ input, role }];
  });

  // Check model/transport refusals for every role before probing installed CLIs.
  for (const { input, role } of pins) {
    if (input.runtime !== 'codex') continue;
    let version: string | null;
    try {
      version = (await resolveCli({ runtimeId: 'codex', binaryName: 'codex', envOverride: 'O8_CODEX_BIN' })).version ?? null;
    } catch {
      throw new EffortPinRejectionError('effort_cli_incompatible',
        `Collide ${role}: cannot honor effort "${input.requestedEffort}" because the selected CLI could not be verified. Check its connection or omit the effort pin.`);
    }
    const pin = resolveEffortPin({ ...input, installedCliVersion: version });
    if (!pin.ok) throw new EffortPinRejectionError(pin.code, `Collide ${role}: ${pin.message}`);
  }
}
