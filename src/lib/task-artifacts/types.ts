/**
 * Interactive task artifacts (#1699).
 *
 * An agent attaches a small purpose-built HTML interface to the conversation
 * or packet that requested it. The artifact renders in an opaque-origin
 * sandbox and gets exactly one capability: return a schema-validated payload
 * to the session that created it. Everything else (identity, target, liveness,
 * bounds, audit) is owned by the host and the server, never by the frame.
 */

export const TASK_ARTIFACT_SCHEMA_VERSION = 1;

export const TASK_ARTIFACT_LIMITS = {
  /** Agent-authored HTML body, UTF-8 bytes. */
  htmlMaxBytes: 256 * 1024,
  /** One action payload, serialized JSON bytes. */
  payloadMaxBytes: 32 * 1024,
  /** Unsent local state the frame asks the host to keep, serialized bytes. */
  draftMaxBytes: 64 * 1024,
  titleMaxChars: 120,
  maxDeclaredActions: 8,
  maxFieldsPerSchema: 64,
  maxRowsPerPayload: 500,
  /** Two accepted actions closer than this are rate-limited. */
  minActionIntervalMs: 2_000,
  /** Accepted actions per artifact before it is suspended. */
  maxAcceptedActions: 50,
} as const;

export type TaskArtifactTargetKind = 'thread' | 'packet';

/**
 * The explicit identity every submission must name. A thread target is a
 * `thoughts-*` orchestrator thread in one repository; a packet target is a
 * dispatched packet with its lane and the session key it was created against.
 */
export interface TaskArtifactTarget {
  kind: TaskArtifactTargetKind;
  repoPath: string;
  threadId: string | null;
  packetId: string | null;
  laneId: string | null;
  sessionKey: string | null;
}

/** `pinned` freezes the artifact when the repository HEAD moves. */
export type TaskArtifactHeadPolicy = 'pinned' | 'any';

export type TaskArtifactFieldType = 'string' | 'number' | 'integer' | 'boolean';

export interface TaskArtifactFieldSchema {
  type: TaskArtifactFieldType;
  required?: boolean;
  enum?: Array<string | number>;
  maxLength?: number;
  min?: number;
  max?: number;
}

/**
 * The payload contract for one declared action: a flat object of typed
 * fields, plus an optional `rows` array of flat objects for tabular edits.
 */
export interface TaskArtifactActionSchema {
  fields: Record<string, TaskArtifactFieldSchema>;
  rows?: {
    fields: Record<string, TaskArtifactFieldSchema>;
    maxRows?: number;
  };
}

export interface TaskArtifactDeclaredAction {
  /** `^[a-z][a-z0-9_-]{0,31}$` */
  name: string;
  label?: string;
  schema: TaskArtifactActionSchema;
}

/**
 * Mission cards (#5468): a native, HTML-free task artifact. The host draws it
 * from this spec in the current theme, the operator acts inline, and the
 * decision returns through the same receipt ledger and delivery path as any
 * other artifact action. A card takes one decision, then reads as a receipt.
 */
export type MissionCardKind = 'approve' | 'choose';
export type MissionCardActionStyle = 'primary' | 'danger' | 'default';

export interface MissionCardAction {
  /** `^[a-z][a-z0-9_-]{0,31}$`; also the declared action name. */
  id: string;
  label: string;
  style: MissionCardActionStyle;
  /** `hold`: the host requires a press held for MISSION_CARD_HOLD_MS. */
  confirm?: 'hold';
}

export interface MissionCardSpec {
  kind: MissionCardKind;
  body: string | null;
  actions: MissionCardAction[];
  /** Typed entity ids (`packet:pkt-1`, `approval:apr-2`) a decision carries back. */
  entityIds: string[];
  /** ISO time after which the card no longer takes a decision. */
  expiresAt: string | null;
}

export type MissionCardState = 'open' | 'decided' | 'expired' | 'closed';

export interface MissionCardReceipt {
  actionId: string;
  actionLabel: string;
  entityIds: string[];
  decidedBy: string;
  decidedAt: string;
  receiptId: string;
  delivery: TaskArtifactActionDelivery;
}

/** What both transcripts render for one card, rebuilt from server state on every read. */
export interface MissionCardView extends MissionCardSpec {
  id: string;
  title: string;
  createdAt: string;
  state: MissionCardState;
  /** Why a closed card stopped taking decisions. */
  reason: string | null;
  receipt: MissionCardReceipt | null;
  /** One line for the dissolved card: what was decided, by whom, when. */
  summary: string | null;
}

export type TaskArtifactState = 'live' | 'frozen' | 'suspended';

export type TaskArtifactCreator = 'operator' | 'worker' | 'orchestrator';

export interface TaskArtifactRecord {
  id: string;
  schemaVersion: number;
  title: string;
  html: string;
  target: TaskArtifactTarget;
  originHead: string | null;
  headPolicy: TaskArtifactHeadPolicy;
  actions: TaskArtifactDeclaredAction[];
  /** Present on mission cards (#5468); their `html` is empty. */
  card?: MissionCardSpec | null;
  state: TaskArtifactState;
  stateReason: string | null;
  createdBy: TaskArtifactCreator;
  createdAt: string;
  updatedAt: string;
}

export type TaskArtifactActionDelivery = 'accepted' | 'delivered' | 'rejected' | 'failed';

export interface TaskArtifactActionRecord {
  id: string;
  artifactId: string;
  action: string;
  nonce: string;
  payloadHash: string;
  payload: unknown;
  target: TaskArtifactTarget;
  actor: string;
  delivery: TaskArtifactActionDelivery;
  deliveryNote: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface TaskArtifactWritability {
  writable: boolean;
  /** Human-readable reason the artifact is read-only; null when writable. */
  reason: string | null;
  currentHead: string | null;
}

/** What the desktop host renders and the API returns for one artifact. */
export interface TaskArtifactView {
  artifact: Omit<TaskArtifactRecord, 'html'> & { html?: string };
  writability: TaskArtifactWritability;
  lastAction: TaskArtifactActionRecord | null;
  acceptedActionCount: number;
  /** Mission cards only: the derived state both transcripts render. */
  card?: MissionCardView | null;
}

/** Stamped onto a thread turn so the ws-server can mark the action delivered. */
export interface TaskArtifactActionStamp {
  artifactId: string;
  actionId: string;
}

export const MISSION_CARD_HOLD_MS = 600;
export const MISSION_CARD_ENTITY_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._:/-]{1,200}$/;

export const TASK_ARTIFACT_ACTION_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const TASK_ARTIFACT_ID_PATTERN = /^tart-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TASK_ARTIFACT_ACTION_ID_PATTERN = /^tact-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TASK_ARTIFACT_NONCE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
export const ORCHESTRATOR_THREAD_ID_PATTERN = /^thoughts-[A-Za-z0-9_-]{1,80}$/;
