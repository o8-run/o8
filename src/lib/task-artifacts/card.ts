/**
 * Mission cards (#5468) — the HTML-free task artifact.
 *
 * A card is declared by an agent (kind, title, typed actions, entity ids,
 * expiry), drawn natively by the host, and takes exactly one decision. The
 * decision is an ordinary task artifact action: it lands in the same receipt
 * ledger and returns through the same steer or thread delivery. Its state is
 * derived on every read from the record and the ledger, so a reload rebuilds
 * the receipt from server state alone.
 */
import {
  MISSION_CARD_ENTITY_ID_PATTERN,
  TASK_ARTIFACT_ACTION_NAME_PATTERN,
  TASK_ARTIFACT_LIMITS,
  type MissionCardAction,
  type MissionCardSpec,
  type MissionCardView,
  type TaskArtifactActionRecord,
  type TaskArtifactDeclaredAction,
  type TaskArtifactRecord,
} from './types';

export const MISSION_CARD_LIMITS = {
  bodyMaxChars: 2_000,
  labelMaxChars: 48,
  maxEntityIds: 16,
  maxChooseOptions: 8,
  /** A card without an explicit expiry stops taking decisions after a day. */
  defaultTtlMs: 24 * 60 * 60 * 1000,
  maxTtlMs: 7 * 24 * 60 * 60 * 1000,
} as const;

/** The declared payload every card action takes: the entity ids it decides on. */
const CARD_ACTION_SCHEMA = { fields: { entityIds: { type: 'string' as const, maxLength: 4_000 } } };

const APPROVE_DEFAULTS: MissionCardAction[] = [
  { id: 'approve', label: 'Approve', style: 'primary', confirm: 'hold' },
  { id: 'deny', label: 'Deny', style: 'danger' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAction(raw: unknown, index: number, errors: string[]): MissionCardAction | null {
  const path = `card.actions[${index}]`;
  if (!isRecord(raw)) { errors.push(`${path}: expected an object`); return null; }
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!TASK_ARTIFACT_ACTION_NAME_PATTERN.test(id)) errors.push(`${path}.id: expected ^[a-z][a-z0-9_-]{0,31}$`);
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (!label || label.length > MISSION_CARD_LIMITS.labelMaxChars) {
    errors.push(`${path}.label: required (max ${MISSION_CARD_LIMITS.labelMaxChars} chars)`);
  }
  const style = raw.style === undefined ? 'default' : raw.style;
  if (style !== 'primary' && style !== 'danger' && style !== 'default') errors.push(`${path}.style: expected primary, danger, or default`);
  if (raw.confirm !== undefined && raw.confirm !== 'hold') errors.push(`${path}.confirm: expected "hold" when present`);
  if (errors.some((error) => error.startsWith(path))) return null;
  return { id, label, style: style as MissionCardAction['style'], ...(raw.confirm === 'hold' ? { confirm: 'hold' as const } : {}) };
}

export type NormalizedCard =
  | { ok: true; card: MissionCardSpec; actions: TaskArtifactDeclaredAction[] }
  | { ok: false; errors: string[] };

/** Validate an agent-declared card and derive the artifact's declared actions from it. */
export function normalizeMissionCard(raw: unknown, now = Date.now()): NormalizedCard {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['card must be an object'] };
  const kind = raw.kind;
  if (kind !== 'approve' && kind !== 'choose') return { ok: false, errors: ['card.kind: expected approve or choose'] };

  const body = typeof raw.body === 'string' && raw.body.trim() ? raw.body.trim() : null;
  if (body && body.length > MISSION_CARD_LIMITS.bodyMaxChars) errors.push(`card.body: max ${MISSION_CARD_LIMITS.bodyMaxChars} chars`);

  let actions: MissionCardAction[] = [];
  if (raw.actions === undefined && kind === 'approve') {
    actions = APPROVE_DEFAULTS.map((action) => ({ ...action }));
  } else if (!Array.isArray(raw.actions)) {
    errors.push('card.actions: expected an array');
  } else {
    actions = raw.actions.map((action, index) => normalizeAction(action, index, errors)).filter((a): a is MissionCardAction => a !== null);
  }
  if (kind === 'approve' && actions.length !== 2) errors.push('card.actions: an approve card has exactly an approve and a deny action');
  if (kind === 'choose' && (actions.length < 2 || actions.length > MISSION_CARD_LIMITS.maxChooseOptions)) {
    errors.push(`card.actions: a choose card offers 2 to ${MISSION_CARD_LIMITS.maxChooseOptions} options`);
  }
  if (new Set(actions.map((action) => action.id)).size !== actions.length) errors.push('card.actions: action ids must be unique');
  if (actions.length > TASK_ARTIFACT_LIMITS.maxDeclaredActions) errors.push(`card.actions: at most ${TASK_ARTIFACT_LIMITS.maxDeclaredActions}`);

  const entityIds = raw.entityIds === undefined ? [] : raw.entityIds;
  if (!Array.isArray(entityIds) || entityIds.length > MISSION_CARD_LIMITS.maxEntityIds
    || !entityIds.every((id) => typeof id === 'string' && MISSION_CARD_ENTITY_ID_PATTERN.test(id))) {
    errors.push(`card.entityIds: up to ${MISSION_CARD_LIMITS.maxEntityIds} typed ids like "packet:pkt-1"`);
  }

  let expiresAt: string;
  if (raw.expiresAt === undefined || raw.expiresAt === null) {
    expiresAt = new Date(now + MISSION_CARD_LIMITS.defaultTtlMs).toISOString();
  } else {
    const parsed = typeof raw.expiresAt === 'string' ? Date.parse(raw.expiresAt) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= now || parsed - now > MISSION_CARD_LIMITS.maxTtlMs) {
      errors.push('card.expiresAt: an ISO time in the future, at most 7 days away');
    }
    expiresAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    card: { kind, body, actions, entityIds: [...new Set(entityIds as string[])], expiresAt },
    actions: actions.map((action) => ({ name: action.id, label: action.label, schema: CARD_ACTION_SCHEMA })),
  };
}

/** Entity ids travel through the action payload as one comma-separated field. */
export function encodeCardEntityIds(ids: string[]): string {
  return ids.join(',');
}

export function decodeCardEntityIds(payload: unknown): string[] {
  const raw = isRecord(payload) && typeof payload.entityIds === 'string' ? payload.entityIds : '';
  return raw ? raw.split(',') : [];
}

/** The entity ids a decision may name: a non-empty subset of the card's, or all of them. */
export function resolveDecisionEntityIds(card: MissionCardSpec, requested: unknown): { ok: true; ids: string[] } | { ok: false; reason: string } {
  if (requested === undefined || requested === null) return { ok: true, ids: card.entityIds };
  if (!Array.isArray(requested) || !requested.every((id) => typeof id === 'string')) {
    return { ok: false, reason: 'entityIds must be an array of strings.' };
  }
  const unknown = requested.filter((id) => !card.entityIds.includes(id));
  if (unknown.length) return { ok: false, reason: `entityIds not on this card: ${unknown.slice(0, 4).join(', ')}` };
  if (card.entityIds.length && requested.length === 0) return { ok: false, reason: 'A decision names at least one of the card entity ids.' };
  return { ok: true, ids: [...new Set(requested as string[])] };
}

export function missionCardExpired(card: MissionCardSpec, now = Date.now()): boolean {
  return Boolean(card.expiresAt && Date.parse(card.expiresAt) <= now);
}

function timeLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(11, 16) + ' UTC' : iso;
}

/**
 * Derive what a transcript shows for a card from durable state only: the
 * record, its latest accepted action, the clock, and whether the target can
 * still take a decision (`closedReason`).
 */
export function missionCardView(
  record: TaskArtifactRecord,
  decision: TaskArtifactActionRecord | null,
  closedReason: string | null,
  now = Date.now(),
): MissionCardView | null {
  const card = record.card;
  if (!card) return null;
  const base = { ...card, id: record.id, title: record.title, createdAt: record.createdAt };
  if (decision) {
    const action = card.actions.find((candidate) => candidate.id === decision.action);
    const actionLabel = action?.label ?? decision.action;
    return {
      ...base,
      state: 'decided',
      reason: null,
      receipt: {
        actionId: decision.action,
        actionLabel,
        entityIds: decodeCardEntityIds(decision.payload),
        decidedBy: decision.actor,
        decidedAt: decision.createdAt,
        receiptId: decision.id,
        delivery: decision.delivery,
      },
      summary: `${actionLabel} · ${record.title} · by ${decision.actor} at ${timeLabel(decision.createdAt)}`,
    };
  }
  if (missionCardExpired(card, now)) {
    return { ...base, state: 'expired', reason: 'The card expired without a decision.', receipt: null,
      summary: `Expired · ${record.title} · no decision by ${timeLabel(card.expiresAt!)}` };
  }
  if (closedReason) {
    return { ...base, state: 'closed', reason: closedReason, receipt: null, summary: `Closed · ${record.title} · ${closedReason}` };
  }
  return { ...base, state: 'open', reason: null, receipt: null, summary: null };
}

/**
 * The exact text the orchestrator receives. The structured block is the
 * contract (`card.decision`); the lead reads it as context and re-checks the
 * named entities before acting, never as a verb that already ran.
 */
export function composeCardDecisionMessage(record: TaskArtifactRecord, actionId: string, entityIds: string[], actor: string, receiptId: string, decidedAt: string): { wireMessage: string; displayMessage: string } {
  const card = record.card!;
  const action = card.actions.find((candidate) => candidate.id === actionId);
  const decision = {
    type: 'card.decision',
    cardId: record.id,
    kind: card.kind,
    title: record.title,
    actionId,
    actionLabel: action?.label ?? actionId,
    entityIds,
    decidedBy: actor,
    decidedAt,
    receiptId,
  };
  const wireMessage = [
    `Card decision from the ${actor}: "${action?.label ?? actionId}" on "${record.title}" (${record.id}). Receipt ${receiptId}.`,
    'This is the operator\'s decision as context. Re-check the named entities before acting on it.',
    '```json',
    JSON.stringify(decision, null, 2),
    '```',
  ].join('\n');
  return { wireMessage, displayMessage: `${action?.label ?? actionId} · ${record.title}` };
}
