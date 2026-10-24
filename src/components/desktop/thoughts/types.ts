import type { ApprovalRecord } from '@/lib/approvals/types';
import type { TerminalStatusEvidence } from '@/lib/terminal-status/resolve';
import type {
  OrchestratorLaneBinding,
  OrchestratorMissionState,
  OrchestratorPacket,
  OrchestratorRuntime,
  OrchestratorWorkspaceTarget,
} from '@/lib/orchestrator/types';

export type PendingApproval = ApprovalRecord;
export type ThoughtMode = 'orchestrate' | 'chat' | 'history';

export interface FleetAgent {
  standingLane?: { laneId: string; currentTask: string | null; queueDepth: number; stopped: boolean };
  name?: string;
  status?: string;
  currentTask?: string;
  context?: { usedPercent?: number };
  alerts?: number;
  sessionKey?: string;
  model?: string;
  lastEventAt?: string;
  transcriptUnsupportedReason?: string | null;
  activity?: { headline?: string };
  runtime?: string;
  isCurrentSession?: boolean;
  workspace?: string;
  statusEvidence?: TerminalStatusEvidence;
}

export interface AgentTarget {
  key: string;
  name: string;
  runtime: OrchestratorRuntime;
  color: string;
  workspace?: string | null;
  isCurrentSession?: boolean;
}

export interface ContextSuggestion {
  text: string;
  action: string;
  agent: AgentTarget;
  priority: 'info' | 'warn' | 'critical';
}

export interface ThoughtsCardProps {
  open: boolean;
  onClose: () => void;
  agents?: FleetAgent[];
  draftInjection?: { id: string; text: string } | null;
  imageInjection?: { id: string; dataUri: string; name: string; mimeType: string } | null;
  onImageInjectionConsumed?: () => void;
  docked?: boolean;
  missionState: OrchestratorMissionState;
  workspaceTargets?: OrchestratorWorkspaceTarget[];
  onMissionStateChange: (
    next: OrchestratorMissionState | ((current: OrchestratorMissionState) => OrchestratorMissionState)
  ) => void;
  onLaunchPacket?: (packet: OrchestratorPacket) => Promise<OrchestratorLaneBinding | null> | OrchestratorLaneBinding | null;
  onFocusPacket?: (packet: OrchestratorPacket) => void;
}
