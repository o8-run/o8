/** Versioned o8 structured-record adapter; never interprets CLI screen text. */
export interface TerminalApprovalAdapter {
  version: 1;
  authority: 'lane-state';
  runtime: 'codex' | 'claude-code';
  sessionKey: string;
  terminalSession: string;
  laneId: string;
  approvalId: string;
  approvalUpdatedAt: number;
  approvalRevision: string;
  revision: string;
  subjectRevision: string;
  laneRevision: string;
  headSha: string;
  runId: string;
  title: string;
  summary: string;
}

export function isTerminalApprovalAdapter(value: unknown): value is TerminalApprovalAdapter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.version === 1 && item.authority === 'lane-state'
    && (item.runtime === 'codex' || item.runtime === 'claude-code')
    && typeof item.approvalUpdatedAt === 'number' && Number.isSafeInteger(item.approvalUpdatedAt)
    && ['sessionKey', 'terminalSession', 'laneId', 'approvalId', 'approvalRevision', 'revision', 'subjectRevision', 'laneRevision', 'headSha', 'runId', 'title', 'summary']
      .every(key => typeof item[key] === 'string' && Boolean((item[key] as string).trim()));
}
