import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

export interface LaunchRequest {
  runId: string;
  laneId?: string;
  repoUrl: string;
  baseRef: string;
  remoteBranch: string;
  packetPrompt: string;
  modelHint?: string;
  /** Customer transport supports omitted/adaptive defaults only. Concrete pins
   * require a verified remote effort transport and are refused before enqueue. */
  effort?: ThinkingEffort;
}

export interface LaunchResponse {
  accepted: boolean;
  workerId: string;
  startedAt: string;
}

export interface PollRequest {
  workerId: string;
  lastEventAt?: string;
}

export type PollEvent =
  | { type: 'progress'; text: string }
  | { type: 'branch_pushed'; branch: string; sha: string }
  | { type: 'completed'; result: string }
  | { type: 'errored'; message: string };

export interface GetBranchRequest {
  runId: string;
}

export interface GetBranchResponse {
  remoteBranch: string;
  pushedAt: string;
}

export interface InterruptRequest {
  runId: string;
}

export interface Transport {
  sendLaunch(req: LaunchRequest): Promise<LaunchResponse>;
  pollStatus(runId: string): Promise<PollEvent[]>;
  getBranch(runId: string): Promise<GetBranchResponse>;
  interrupt(runId: string): Promise<void>;
}
