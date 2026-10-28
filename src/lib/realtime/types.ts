import type { BrowserAttachmentSummary, BrowserInventorySnapshot } from '@/lib/browser/types';
import type { FleetSnapshot, WorkflowReviewSnapshot } from '@/lib/fleet/types';
import type { LaneOutcome, LaneStatus } from '@/lib/lane/types';
import type { MobileInboxSnapshot, MobileTranscriptEntry } from '@/lib/mobile/types';
import type { MobileInboxDelta } from '@/lib/mobile/inbox-delta';
import type { OrchestratorPacketStatus, WorkerLaunchContext } from '@/lib/orchestrator/types';
import type {
  RealtimeBatchData,
  RealtimeEventEnvelope as ProtocolRealtimeEventEnvelope,
} from '@/lib/realtime/generated-contract';

export {
  MOBILE_INBOX_DELTA_CAPABILITY,
  REALTIME_CONTRACT_SHA256,
  REALTIME_FEATURE_METADATA,
  REALTIME_LEGACY_SUBSCRIPTION,
  REALTIME_MINIMUM_PROTOCOL_VERSION,
  REALTIME_OPTIONAL_FEATURES,
  REALTIME_PROTOCOL_VERSION,
} from '@/lib/realtime/generated-contract';
export type {
  RealtimeClientHello,
  RealtimeClientKind,
  RealtimeCursor,
  RealtimeDeliveryMode,
  RealtimeGapDescriptor,
  RealtimeHealthDescriptor,
  RealtimeHealthState,
  RealtimeOptionalFeature,
  RealtimeProtocolRange,
  RealtimeProtocolVersion,
  RealtimeRevision,
  RealtimeServerIncompatibleData,
  RealtimeServerIncompatibleMessage,
  RealtimeServerProtocolMessage,
  RealtimeServerWelcomeData,
  RealtimeServerWelcomeMessage,
  RealtimeSnapshotDescriptor,
  RealtimeStreamKey,
  RealtimeSubscribeMessage,
  RealtimeSubscription,
} from '@/lib/realtime/generated-contract';
import type {
  RealtimeHealthDescriptor,
  RealtimeHealthState,
  RealtimeOptionalFeature,
  RealtimeStreamKey,
} from '@/lib/realtime/generated-contract';

export interface LaneLifecycleEventPayload {
  laneId: string;
  packetId: string | null;
  status: LaneStatus;
  packetStatus?: OrchestratorPacketStatus;
  previousStatus: LaneStatus | null;
  label?: string;
  outcome?: LaneOutcome | null;
  runtime?: string;
  sessionKey: string | null;
  branch: string;
  repoPath: string;
  timestamp: string;
}

export interface RealtimeMutationRecord {
  compaction?: import('@/lib/orchestrator/compaction-status').CompactionOperation;
  mutationId: string;
  source: 'desktop' | 'mobile' | 'server';
  action: string;
  status: 'pending' | 'queued' | 'completed' | 'failed';
  runtime?: string;
  surfaceId?: string;
  sessionKey?: string;
  laneId?: string;
  laneLabel?: string;
  laneOutcome?: LaneOutcome | null;
  packetId?: string;
  packetTitle?: string;
  packetReferenceLabel?: string;
  repoPath?: string;
  branch?: string;
  launchContext?: WorkerLaunchContext;
  laneStatus?: LaneStatus;
  previousStatus?: LaneStatus | null;
  timestamp?: string;
  note?: string;
  optimistic?: boolean;
  /** Explicit operator override for safety-gated mutations. */
  force?: boolean;
  createdAt: string;
  settledAt?: string;
  /** Populated when action === 'runtime-fallback'. */
  fromModel?: string;
  toModel?: string;
  reason?: string;
}

export interface RuntimeRealtimeSnapshotPayload {
  fleet: FleetSnapshot;
}

export interface ReviewRealtimeSnapshotPayload {
  review: WorkflowReviewSnapshot | null;
  error?: string | null;
}

export interface BrowserRealtimeSnapshotPayload {
  browserInventory: BrowserInventorySnapshot;
  attachedBrowser?: BrowserAttachmentSummary | null;
  error?: string | null;
}

export interface MobileInboxRealtimeSnapshotPayload {
  inbox: MobileInboxSnapshot;
  revision?: number;
}

export interface MobileInboxRealtimeDeltaPayload {
  delta: MobileInboxDelta;
}

export interface SessionHistoryRealtimePayload {
  sessionKey: string;
  entries: MobileTranscriptEntry[];
  replace?: boolean;
}

export type RealtimeEventPayload =
  | RuntimeRealtimeSnapshotPayload
  | ReviewRealtimeSnapshotPayload
  | BrowserRealtimeSnapshotPayload
  | MobileInboxRealtimeSnapshotPayload
  | MobileInboxRealtimeDeltaPayload
  | SessionHistoryRealtimePayload
  | { mutation: RealtimeMutationRecord };

export type RealtimeEventName =
  | 'runtime.snapshot'
  | 'review.snapshot'
  | 'browser.snapshot'
  | 'mobile.inbox.snapshot'
  | 'mobile.inbox.delta'
  | 'history.snapshot'
  | 'mutation.record'
  | 'mutation.settled';

export type RealtimeChannel =
  | 'runtime'
  | 'review'
  | 'browser'
  | 'mobile'
  | 'history'
  | 'mutation';

export type RealtimeEventEnvelope<T extends RealtimeEventPayload = RealtimeEventPayload> =
  ProtocolRealtimeEventEnvelope<T, RealtimeEventName, RealtimeChannel> & {
    /** Server-side replay audience for capability-gated additive events. */
    audience?: RealtimeOptionalFeature | 'mobile-inbox-legacy';
  };

export type RealtimeBatchMessage = RealtimeBatchData<RealtimeEventEnvelope>;

export type RealtimeRefreshTarget = 'global' | 'mobileInbox' | 'sessionHistory';

export interface RealtimeRefreshRequest {
  kind: 'refresh';
  targets: RealtimeRefreshTarget[];
  sessionKeys?: string[];
  fresh?: boolean;
  reason?: string;
}

export interface RealtimeMutationPublishRequest {
  kind: 'mutation';
  mutation: RealtimeMutationRecord;
  refreshTargets?: RealtimeRefreshTarget[];
  sessionKeys?: string[];
  fresh?: boolean;
}

export type RealtimeInternalRequest = RealtimeRefreshRequest | RealtimeMutationPublishRequest;

export interface RealtimeEntityState {
  fleet: FleetSnapshot | null;
  review: WorkflowReviewSnapshot | null;
  reviewError: string | null;
  browserInventory: BrowserInventorySnapshot | null;
  attachedBrowser: BrowserAttachmentSummary | null;
  browserError: string | null;
  mobileInbox: MobileInboxSnapshot | null;
  transcripts: Record<string, MobileTranscriptEntry[]>;
  mutations: Record<string, RealtimeMutationRecord>;
  streamSeq: Partial<Record<RealtimeStreamKey, number>>;
  entitySeq: Record<string, number>;
  connection: {
    transport: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
    realtimeState: RealtimeHealthState;
    lastEventAt?: string;
    healthByChannel: Partial<Record<RealtimeChannel, RealtimeHealthDescriptor>>;
  };
}
