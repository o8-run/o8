import type { ReviewPayer } from '@/lib/lane/review-payer';
import type { CloseUnmergedDisposition } from '@/lib/orchestrator/close-unmerged-shared';

export const PACKET_RECEIPT_SCHEMA = 'o8/packet-receipt/v1' as const;

export type PacketDisposition =
  | { kind: 'pr_opened'; branch: string; commit: string; prNumber: number; verification: string[]; openedAt: string }
  | {
    kind: 'merged';
    mergeCommit: string;
    headSha: string | null;
    tree: string;
    evidenceKind: string | null;
    releasedAt: string;
  }
  | {
    kind: 'discarded';
    disposition: CloseUnmergedDisposition;
    reason: string;
    preservedBranches: string[];
    closedAt: string;
  };

export interface PacketReceiptReview {
  turnId: string;
  backend: string;
  outcome: 'active' | 'completed' | 'failed' | 'quota_discarded';
  at: string;
  /** The model the backend reported running the review on; null when it reported none (#3742). */
  model?: string | null;
  /** The reviewer surface: auto-review, merge-gate-review, packet-explainer or buyin-doc; null when unrecorded (#3742). */
  surface?: string | null;
  /** Who paid for the review turn (#3742). */
  payer?: ReviewPayer;
}

export interface PacketReceiptApproval {
  id: string;
  title: string;
  principal: string;
  decision: 'approved' | 'rejected';
  at: string;
}

export interface UnsignedPacketReceipt {
  schema: typeof PACKET_RECEIPT_SCHEMA;
  receiptId: string;
  packetId: string;
  packetTitle: string;
  laneId: string;
  repo: {
    name: string;
    remote?: string;
    baseBranch: string;
  };
  disposition: PacketDisposition;
  task?: { branch: string; commit: string; prNumber: number; verification: string[] };
  reviews: PacketReceiptReview[];
  approvals: PacketReceiptApproval[];
  runtime: string;
  model: string | null;
  createdAt: string;
  keyId: string;
}

export interface PacketReceipt extends UnsignedPacketReceipt {
  signature: string;
}

export interface PacketReceiptRepositoryVerification {
  checked: boolean;
  repoPath: string | null;
  commitExists: boolean | null;
  treeMatches: boolean | null;
  actualTree: string | null;
}

export interface PacketReceiptVerification {
  ok: boolean;
  schema: typeof PACKET_RECEIPT_SCHEMA | null;
  receiptId: string | null;
  packetId: string | null;
  keyId: string | null;
  signatureValid: boolean;
  keyIdMatches: boolean;
  repository: PacketReceiptRepositoryVerification;
  errors: string[];
}
