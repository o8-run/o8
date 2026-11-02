import { firstMcpConfigDivergence } from './orchestrator-mcp-fingerprint';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { FalseDispatchAttemptResult } from './orchestrator-false-dispatch';
import type { OrchestratorTurnRecord } from './orchestrator-crash-survival';
import type {
  createToolCallTracker,
  OrchestratorEvent,
  OrchestratorTurnUsage,
} from './orchestrator-stream-events';

export interface OrchestratorProcConfig {
  cwd: string;
  model: string;
  permissionMode: 'full' | 'plan';
  toolProfile: ToolProfile;
  effort: ThinkingEffort;
  fastMode?: boolean;
  mcpConfigPath: string;
  mcpConfigHash: string;
  mcpConfigMaterial: string;
  modelSource: string;
  carrierFingerprint: string;
}

export interface OrchestratorActiveTurn {
  onEvent: (event: OrchestratorEvent) => void;
  captureEvent: (event: OrchestratorEvent) => void;
  resolve: (outcome: FalseDispatchAttemptResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  abortSignal: AbortSignal | null;
  abortListener: (() => void) | null;
  settled: boolean;
  toolTracker: ReturnType<typeof createToolCallTracker>;
  turnSessionId: string | null;
  cost: number | null;
  usage?: OrchestratorTurnUsage | null;
  /** The model finished, and the turn stays open for a background agent. */
  heldResult?: boolean;
  lastAssistantText: string;
  sawToolUseAfterText: boolean;
  launchAgentCallCount: number;
  crashRecord: OrchestratorTurnRecord | null;
  stopCrashTail: (() => void) | null;
  promptFingerprint: string | null;
}

export interface WarmState {
  procConfig: OrchestratorProcConfig | null;
  activeTurn: OrchestratorActiveTurn | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  stdoutLineBuffer: string;
  stderrBuffer: string;
  lastUsedAt: number;
  crashStdoutPath: string | null;
  crashStderrPath: string | null;
  resumeAfterKill: boolean;
  resumeUnavailable: boolean;
  sessionPrompt: string | null;
}

export function procConfigMatches(a: OrchestratorProcConfig | null, b: OrchestratorProcConfig): boolean {
  return !!a && a.cwd === b.cwd && a.model === b.model && a.permissionMode === b.permissionMode
    && a.toolProfile === b.toolProfile && a.effort === b.effort && a.mcpConfigHash === b.mcpConfigHash
    && a.modelSource === b.modelSource && a.carrierFingerprint === b.carrierFingerprint && a.fastMode === b.fastMode;
}

export function firstProcConfigDivergence(a: OrchestratorProcConfig | null, b: OrchestratorProcConfig): string {
  if (!a) return 'procConfig';
  for (const key of ['cwd', 'model', 'permissionMode', 'toolProfile', 'effort', 'fastMode', 'modelSource', 'carrierFingerprint'] as const) {
    if (a[key] !== b[key]) return key;
  }
  if (a.mcpConfigHash !== b.mcpConfigHash) {
    const key = firstMcpConfigDivergence(a.mcpConfigMaterial, b.mcpConfigMaterial);
    return `${key} (${a.mcpConfigHash}->${b.mcpConfigHash})`;
  }
  return 'procConfig';
}
