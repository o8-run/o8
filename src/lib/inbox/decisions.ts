import type { EffectivePolicy, PolicyNextAction } from '@/lib/lane/effective-policy';

/** A read projection, never an authorization lease or an approval payload. */
export interface InboxDecision {
  id: string;
  revisionToken: string;
  taskId: string;
  laneId: string;
  packetId: string | null;
  projectId: string | null;
  title: string;
  repository: { id: string; projectId: string | null; branch: string; pullRequest: number | null };
  headSha: string | null;
  phase: 'review' | 'integration';
  state: 'unresolved' | 'resolved' | 'superseded';
  responsibleAgent: { runtime: string; sessionId: string | null } | null;
  blocker: string;
  attempts: { review: number; correction: number | null; maximumCorrections: number | null };
  review: { approvalId: string | null; headSha: string | null; findings: number } | null;
  uncertain: boolean;
  priorAttempts: {
    reviews: Array<{ id: string; headSha: string | null; status: string; attempts: number }>;
    corrections: Array<{ id: string; status: string | null }>;
  };
  historyTruncated: boolean;
  primaryAction: { kind: PolicyNextAction; label: string; method: 'GET'; path: string; consequence: string } | null;
  evidence: { diff: string; activity: string; policy: string; review: string | null; correction: string | null };
  policy: EffectivePolicy | null;
}
export interface InboxDecisions {
  schema: 'o8/inbox-decisions/v1';
  readAt: string;
  decisions: InboxDecision[];
  nextCursor: string | null;
}
