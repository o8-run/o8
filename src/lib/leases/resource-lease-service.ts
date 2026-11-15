import 'server-only';

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { ensureV43ResourceLeaseSchema } from '@/lib/db/v43-resource-leases-migration';
import {
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
  type MetadataLockProcessProbe,
} from '@/lib/worktree/metadata-lock-process-identity';
import {
  normalizeResourceLeaseTtl,
  normalizeResourceLeaseWaiterId,
  normalizeResourceName,
  type ResourceLeaseAcquireResult,
  type ResourceLeaseHolder,
  type ResourceLeaseParticipant,
  type ResourceLeaseReleaseResult,
  type ResourceLeaseSnapshot,
  type ResourceLeaseWaiter,
} from './resource-lease-types';
import {
  parseResourceLeaseProcessIdentity,
  sameObservedResourceLeaseOwner,
  sameObservedResourceLeaseParticipant,
  sameResourceLeaseClaimHash,
} from './resource-lease-participant';

const ACQUIRE_RACE_LIMIT = 8;
const WAITER_HEARTBEAT_INTERVAL_MS = 5_000;

interface HolderRow {
  resource: string;
  lease_id: string;
  owner_id: string;
  owner_label: string;
  owner_pid: number;
  owner_identity_json: string;
  claim_token_hash: string | null;
  acquired_at: number;
  ttl_ms: number;
  heartbeat_at: number;
}

interface WaiterRow {
  queue_sequence: number;
  waiter_id: string;
  resource: string;
  owner_id: string;
  owner_label: string;
  owner_pid: number;
  owner_identity_json: string;
  actor: string | null;
  claim_token_hash: string | null;
  waiter_pid: number;
  waiter_identity_json: string;
  ttl_ms: number;
  enqueued_at: number;
  last_seen_at: number;
}

type ExactProcessState =
  | { state: 'live' }
  | { state: 'dead'; reason: 'process_absent' | 'process_identity_changed' }
  | { state: 'unknown'; detail: string };

interface ReconcileResult {
  snapshot: ResourceLeaseSnapshot;
  holderReaped: boolean;
  waitersReaped: number;
  promoted: boolean;
  retainedLive: boolean;
  retainedUnknown: boolean;
}

interface ResourceLeaseStoreDependencies {
  now?: () => number;
  probe?: (pid: number) => Promise<MetadataLockProcessProbe>;
  eventId?: () => string;
  leaseId?: () => string;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function hasPersistedWaiterAuthority(row: WaiterRow): boolean {
  return Boolean(row.actor?.trim()) && Boolean(row.claim_token_hash?.match(/^[a-f0-9]{64}$/));
}

function publicHolder(row: HolderRow, now: number): ResourceLeaseHolder {
  const expiresAt = row.heartbeat_at + row.ttl_ms;
  return {
    resource: row.resource,
    leaseId: row.lease_id,
    owner: { id: row.owner_id, label: row.owner_label, pid: row.owner_pid },
    acquiredAt: iso(row.acquired_at),
    ttlMs: row.ttl_ms,
    heartbeatAt: iso(row.heartbeat_at),
    expiresAt: iso(expiresAt),
    overdue: expiresAt <= now,
  };
}

function publicWaiter(row: WaiterRow, position: number): ResourceLeaseWaiter {
  return {
    waiterId: row.waiter_id,
    resource: row.resource,
    owner: { id: row.owner_id, label: row.owner_label, pid: row.owner_pid },
    position,
    enqueuedAt: iso(row.enqueued_at),
    lastSeenAt: iso(row.last_seen_at),
    ttlMs: row.ttl_ms,
  };
}

export class ResourceLeaseStore {
  private readonly now: () => number;
  private readonly probe: (pid: number) => Promise<MetadataLockProcessProbe>;
  private readonly eventId: () => string;
  private readonly leaseId: () => string;

  constructor(
    private readonly sqlite: Database.Database,
    dependencies: ResourceLeaseStoreDependencies = {},
  ) {
    ensureV43ResourceLeaseSchema(sqlite);
    this.now = dependencies.now ?? Date.now;
    this.probe = dependencies.probe ?? probeMetadataLockProcessIdentity;
    this.eventId = dependencies.eventId ?? (() => `lease-event-${randomUUID()}`);
    this.leaseId = dependencies.leaseId ?? (() => `lease-${randomUUID()}`);
  }

  private readHolder(resource: string): HolderRow | null {
    return (this.sqlite.prepare(`
      SELECT * FROM resource_leases WHERE resource = ?
    `).get(resource) as HolderRow | undefined) ?? null;
  }

  private readWaiters(resource: string): WaiterRow[] {
    return this.sqlite.prepare(`
      SELECT * FROM resource_lease_waiters
      WHERE resource = ?
      ORDER BY queue_sequence ASC
    `).all(resource) as WaiterRow[];
  }

  private recordEvent(
    sqlite: Database.Database,
    resource: string,
    verb: string,
    actor: string,
    payload: Record<string, unknown>,
    timestamp: number,
  ): void {
    sqlite.prepare(`
      INSERT INTO resource_lease_events (
        id, resource, verb, actor, payload_json, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(this.eventId(), resource, verb, actor, JSON.stringify(payload), iso(timestamp));
  }

  private async exactProcessState(pid: number, identityJson: string): Promise<ExactProcessState> {
    const identity = parseResourceLeaseProcessIdentity(identityJson);
    if (!identity) return { state: 'unknown', detail: 'Stored process identity is invalid.' };
    const probe = await this.probe(pid);
    if (probe.state === 'absent') return { state: 'dead', reason: 'process_absent' };
    if (probe.state === 'unknown') return { state: 'unknown', detail: probe.detail };
    return sameMetadataLockProcessIdentity(identity, probe.identity)
      ? { state: 'live' }
      : { state: 'dead', reason: 'process_identity_changed' };
  }

  private reapHolder(row: HolderRow, reason: ExactProcessState & { state: 'dead' }): boolean {
    const recordedAt = this.now();
    return this.sqlite.transaction(() => {
      const deleted = this.sqlite.prepare(`
        DELETE FROM resource_leases
        WHERE resource = ? AND lease_id = ? AND owner_identity_json = ?
      `).run(row.resource, row.lease_id, row.owner_identity_json);
      if (deleted.changes !== 1) return false;
      this.recordEvent(this.sqlite, row.resource, 'reaped', 'system', {
        leaseId: row.lease_id,
        owner: { id: row.owner_id, label: row.owner_label, pid: row.owner_pid },
        reason: reason.reason,
      }, recordedAt);
      return true;
    }).immediate();
  }

  private reapWaiter(row: WaiterRow, reason: string): boolean {
    const recordedAt = this.now();
    return this.sqlite.transaction(() => {
      const deleted = this.sqlite.prepare(`
        DELETE FROM resource_lease_waiters
        WHERE waiter_id = ? AND owner_identity_json = ? AND waiter_identity_json = ?
      `).run(row.waiter_id, row.owner_identity_json, row.waiter_identity_json);
      if (deleted.changes !== 1) return false;
      this.recordEvent(this.sqlite, row.resource, 'waiter_reaped', 'system', {
        waiterId: row.waiter_id,
        owner: { id: row.owner_id, label: row.owner_label, pid: row.owner_pid },
        waiterPid: row.waiter_pid,
        reason,
      }, recordedAt);
      return true;
    }).immediate();
  }

  private async reconcileHolder(resource: string): Promise<{
    row: HolderRow | null;
    reaped: boolean;
    retainedLive: boolean;
    blocked: ResourceLeaseSnapshot['blocked'];
  }> {
    const row = this.readHolder(resource);
    if (!row) return { row: null, reaped: false, retainedLive: false, blocked: null };
    const state = await this.exactProcessState(row.owner_pid, row.owner_identity_json);
    if (state.state === 'dead') {
      const reaped = this.reapHolder(row, state);
      return { row: reaped ? null : this.readHolder(resource), reaped, retainedLive: false, blocked: null };
    }
    if (state.state === 'unknown') {
      return {
        row,
        reaped: false,
        retainedLive: false,
        blocked: {
          code: 'holder_identity_unknown',
          message: `Holder identity could not be proved dead, so ${resource} remains held: ${state.detail}`,
        },
      };
    }
    return { row, reaped: false, retainedLive: true, blocked: null };
  }

  private async reconcileWaiters(resource: string): Promise<{
    reaped: number;
    blocked: ResourceLeaseSnapshot['blocked'];
  }> {
    let reaped = 0;
    let blocked: ResourceLeaseSnapshot['blocked'] = null;
    for (const row of this.readWaiters(resource)) {
      const [ownerState, waiterState] = await Promise.all([
        this.exactProcessState(row.owner_pid, row.owner_identity_json),
        this.exactProcessState(row.waiter_pid, row.waiter_identity_json),
      ]);
      const deadReason = ownerState.state === 'dead'
        ? `owner_${ownerState.reason}`
        : waiterState.state === 'dead' ? `waiter_${waiterState.reason}` : null;
      if (deadReason) {
        if (this.reapWaiter(row, deadReason)) reaped += 1;
        continue;
      }
      if (!hasPersistedWaiterAuthority(row)) {
        blocked ??= {
          code: 'waiter_claim_unavailable',
          message: `FIFO waiter ${row.owner_label} has no proved claim authority, so later waiters cannot pass it.`,
        };
        continue;
      }
      if (!blocked && (ownerState.state === 'unknown' || waiterState.state === 'unknown')) {
        const detail = ownerState.state === 'unknown' ? ownerState.detail : waiterState.state === 'unknown' ? waiterState.detail : '';
        blocked = {
          code: 'waiter_identity_unknown',
          message: `FIFO waiter ${row.owner_label} could not be proved dead, so later waiters cannot pass it: ${detail}`,
        };
      }
    }
    return { reaped, blocked };
  }

  private promote(row: WaiterRow): HolderRow | null {
    const acquiredAt = this.now();
    const leaseId = this.leaseId();
    return this.sqlite.transaction(() => {
      if (this.readHolder(row.resource)) return null;
      const head = this.sqlite.prepare(`
        SELECT * FROM resource_lease_waiters
        WHERE resource = ?
        ORDER BY queue_sequence ASC
        LIMIT 1
      `).get(row.resource) as WaiterRow | undefined;
      if (!head || head.waiter_id !== row.waiter_id) return null;
      const inserted = this.sqlite.prepare(`
        INSERT OR IGNORE INTO resource_leases (
          resource, lease_id, owner_id, owner_label, owner_pid, owner_identity_json,
          claim_token_hash, acquired_at, ttl_ms, heartbeat_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.resource,
        leaseId,
        row.owner_id,
        row.owner_label,
        row.owner_pid,
        row.owner_identity_json,
        row.claim_token_hash,
        acquiredAt,
        row.ttl_ms,
        acquiredAt,
      );
      if (inserted.changes !== 1) return null;
      this.sqlite.prepare('DELETE FROM resource_lease_waiters WHERE waiter_id = ?')
        .run(row.waiter_id);
      this.recordEvent(this.sqlite, row.resource, 'acquired', row.actor ?? 'system:unproven-waiter', {
        leaseId,
        owner: { id: row.owner_id, label: row.owner_label, pid: row.owner_pid },
        ttlMs: row.ttl_ms,
        waiterId: row.waiter_id,
        waitedMs: Math.max(0, acquiredAt - row.enqueued_at),
      }, acquiredAt);
      return this.readHolder(row.resource);
    }).immediate();
  }

  private async promoteHead(resource: string): Promise<{
    row: HolderRow | null;
    promoted: boolean;
    blocked: ResourceLeaseSnapshot['blocked'];
  }> {
    for (let attempt = 0; attempt < ACQUIRE_RACE_LIMIT; attempt += 1) {
      const holder = this.readHolder(resource);
      if (holder) return { row: holder, promoted: false, blocked: null };
      const row = this.readWaiters(resource)[0];
      if (!row) return { row: null, promoted: false, blocked: null };
      const [ownerState, waiterState] = await Promise.all([
        this.exactProcessState(row.owner_pid, row.owner_identity_json),
        this.exactProcessState(row.waiter_pid, row.waiter_identity_json),
      ]);
      const deadReason = ownerState.state === 'dead'
        ? `owner_${ownerState.reason}`
        : waiterState.state === 'dead' ? `waiter_${waiterState.reason}` : null;
      if (deadReason) {
        this.reapWaiter(row, deadReason);
        continue;
      }
      if (!hasPersistedWaiterAuthority(row)) {
        return {
          row: null,
          promoted: false,
          blocked: {
            code: 'waiter_claim_unavailable',
            message: `FIFO waiter ${row.owner_label} has no proved claim authority and cannot be promoted.`,
          },
        };
      }
      if (ownerState.state === 'unknown' || waiterState.state === 'unknown') {
        const detail = ownerState.state === 'unknown' ? ownerState.detail : waiterState.state === 'unknown' ? waiterState.detail : '';
        return {
          row: null,
          promoted: false,
          blocked: {
            code: 'waiter_identity_unknown',
            message: `FIFO waiter ${row.owner_label} could not be proved dead or live: ${detail}`,
          },
        };
      }
      const promoted = this.promote(row);
      if (promoted) return { row: promoted, promoted: true, blocked: null };
    }
    return { row: this.readHolder(resource), promoted: false, blocked: null };
  }

  private snapshot(
    resource: string,
    holder: HolderRow | null,
    blocked: ResourceLeaseSnapshot['blocked'],
  ): ResourceLeaseSnapshot {
    const now = this.now();
    return {
      schema: 'o8/resource-lease/v1',
      resource,
      holder: holder ? publicHolder(holder, now) : null,
      waiters: this.readWaiters(resource).map((row, index) => publicWaiter(row, index + 1)),
      blocked,
    };
  }

  private async reconcile(rawResource: string): Promise<ReconcileResult> {
    const resource = normalizeResourceName(rawResource);
    const holderResult = await this.reconcileHolder(resource);
    const waiterResult = await this.reconcileWaiters(resource);
    const promoted = holderResult.row
      ? { row: holderResult.row, promoted: false, blocked: null }
      : await this.promoteHead(resource);
    const blocked = holderResult.blocked ?? promoted.blocked ?? waiterResult.blocked;
    return {
      snapshot: this.snapshot(resource, promoted.row, blocked),
      holderReaped: holderResult.reaped,
      waitersReaped: waiterResult.reaped,
      promoted: promoted.promoted,
      retainedLive: holderResult.retainedLive,
      retainedUnknown: Boolean(blocked),
    };
  }

  private tryAcquireDirect(
    resource: string,
    participant: ResourceLeaseParticipant,
    ttlMs: number,
  ): HolderRow | null {
    const acquiredAt = this.now();
    const leaseId = this.leaseId();
    return this.sqlite.transaction(() => {
      if (this.readHolder(resource) || this.readWaiters(resource).length > 0) return null;
      const inserted = this.sqlite.prepare(`
        INSERT OR IGNORE INTO resource_leases (
          resource, lease_id, owner_id, owner_label, owner_pid, owner_identity_json,
          claim_token_hash, acquired_at, ttl_ms, heartbeat_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resource,
        leaseId,
        participant.owner.id,
        participant.owner.label,
        participant.owner.pid,
        JSON.stringify(participant.owner.identity),
        participant.claimTokenHash,
        acquiredAt,
        ttlMs,
        acquiredAt,
      );
      if (inserted.changes !== 1) return null;
      this.recordEvent(this.sqlite, resource, 'acquired', participant.actor, {
        leaseId,
        owner: {
          id: participant.owner.id,
          label: participant.owner.label,
          pid: participant.owner.pid,
        },
        ttlMs,
        waitedMs: 0,
      }, acquiredAt);
      return this.readHolder(resource);
    }).immediate();
  }

  private enqueue(
    resource: string,
    participant: ResourceLeaseParticipant,
    ttlMs: number,
    waiterId: string,
  ): WaiterRow {
    const now = this.now();
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare(`
        SELECT * FROM resource_lease_waiters
        WHERE resource = ? AND owner_id = ? AND owner_pid = ? AND owner_identity_json = ?
      `).get(
        resource,
        participant.owner.id,
        participant.owner.pid,
        JSON.stringify(participant.owner.identity),
      ) as WaiterRow | undefined;
      if (existing) {
        if (!sameResourceLeaseClaimHash(existing.claim_token_hash, participant.claimTokenHash)) return existing;
        if (
          existing.ttl_ms === ttlMs
          && now - existing.last_seen_at < WAITER_HEARTBEAT_INTERVAL_MS
        ) return existing;
        this.sqlite.prepare(`
          UPDATE resource_lease_waiters SET last_seen_at = ?, ttl_ms = ? WHERE waiter_id = ?
        `).run(now, ttlMs, existing.waiter_id);
        return { ...existing, last_seen_at: now, ttl_ms: ttlMs };
      }
      this.sqlite.prepare(`
        INSERT INTO resource_lease_waiters (
          waiter_id, resource, owner_id, owner_label, owner_pid, owner_identity_json,
          actor, claim_token_hash, waiter_pid, waiter_identity_json, ttl_ms, enqueued_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        waiterId,
        resource,
        participant.owner.id,
        participant.owner.label,
        participant.owner.pid,
        JSON.stringify(participant.owner.identity),
        participant.actor,
        participant.claimTokenHash,
        participant.waiterPid,
        JSON.stringify(participant.waiterIdentity),
        ttlMs,
        now,
        now,
      );
      this.recordEvent(this.sqlite, resource, 'wait_enqueued', participant.actor, {
        waiterId,
        owner: {
          id: participant.owner.id,
          label: participant.owner.label,
          pid: participant.owner.pid,
        },
        waiterPid: participant.waiterPid,
        ttlMs,
      }, now);
      return this.sqlite.prepare(`
        SELECT * FROM resource_lease_waiters WHERE waiter_id = ?
      `).get(waiterId) as WaiterRow;
    }).immediate();
  }

  async acquire(input: {
    resource: string;
    participant: ResourceLeaseParticipant;
    ttlMs?: number;
    wait?: boolean;
    waiterId?: string;
  }): Promise<ResourceLeaseAcquireResult> {
    const resource = normalizeResourceName(input.resource);
    const ttlMs = normalizeResourceLeaseTtl(input.ttlMs);
    const wait = input.wait === true;
    const waiterId = normalizeResourceLeaseWaiterId(input.waiterId) ?? `waiter-${randomUUID()}`;

    for (let attempt = 0; attempt < ACQUIRE_RACE_LIMIT; attempt += 1) {
      const reconciled = await this.reconcile(resource);
      const current = this.readHolder(resource);
      if (current && sameObservedResourceLeaseOwner(current, input.participant.owner)) {
        if (!sameResourceLeaseClaimHash(current.claim_token_hash, input.participant.claimTokenHash)) {
          return {
            state: 'refused',
            reason: 'claim_unproven',
            holder: publicHolder(current, this.now()),
            nextWaiter: reconciled.snapshot.waiters[0] ?? null,
            blocked: reconciled.snapshot.blocked,
          };
        }
        const heartbeatAt = this.now();
        this.sqlite.prepare(`
          UPDATE resource_leases SET heartbeat_at = ?, ttl_ms = ?
          WHERE resource = ? AND lease_id = ?
        `).run(heartbeatAt, ttlMs, resource, current.lease_id);
        return {
          state: 'acquired',
          lease: publicHolder({ ...current, heartbeat_at: heartbeatAt, ttl_ms: ttlMs }, heartbeatAt),
          waited: reconciled.promoted || reconciled.snapshot.waiters.length > 0,
          replayed: true,
        };
      }
      const sameOwnerWaiter = this.readWaiters(resource).find((row) => {
        const storedIdentity = parseResourceLeaseProcessIdentity(row.owner_identity_json);
        return row.owner_id === input.participant.owner.id
          && row.owner_pid === input.participant.owner.pid
          && storedIdentity !== null
          && sameMetadataLockProcessIdentity(storedIdentity, input.participant.owner.identity);
      });
      if (sameOwnerWaiter
        && !sameResourceLeaseClaimHash(sameOwnerWaiter.claim_token_hash, input.participant.claimTokenHash)) {
        return {
          state: 'refused',
          reason: 'claim_unproven',
          holder: reconciled.snapshot.holder,
          nextWaiter: reconciled.snapshot.waiters[0] ?? null,
          blocked: reconciled.snapshot.blocked,
        };
      }
      if (!current && reconciled.snapshot.waiters.length === 0 && !reconciled.snapshot.blocked) {
        const acquired = this.tryAcquireDirect(resource, input.participant, ttlMs);
        if (acquired) {
          return { state: 'acquired', lease: publicHolder(acquired, this.now()), waited: false, replayed: false };
        }
        continue;
      }
      if (!wait) {
        const snapshot = await this.status(resource);
        return {
          state: 'refused',
          reason: snapshot.blocked
            ? 'identity_unknown'
            : snapshot.holder ? 'held' : 'fifo_waiter_precedes',
          holder: snapshot.holder,
          nextWaiter: snapshot.waiters[0] ?? null,
          blocked: snapshot.blocked,
        };
      }
      const queued = this.enqueue(resource, input.participant, ttlMs, waiterId);
      const afterQueue = await this.reconcile(resource);
      const promotedHolder = this.readHolder(resource);
      if (promotedHolder && sameObservedResourceLeaseParticipant(promotedHolder, input.participant)) {
        return {
          state: 'acquired',
          lease: publicHolder(promotedHolder, this.now()),
          waited: true,
          replayed: false,
        };
      }
      const waiters = afterQueue.snapshot.waiters;
      const waiter = waiters.find((candidate) => candidate.waiterId === queued.waiter_id)
        ?? waiters.find((candidate) => candidate.owner.id === input.participant.owner.id
          && candidate.owner.pid === input.participant.owner.pid);
      if (waiter) {
        return {
          state: 'queued',
          waiter,
          holder: afterQueue.snapshot.holder,
          blocked: afterQueue.snapshot.blocked,
        };
      }
    }
    const snapshot = await this.status(resource);
    return {
      state: 'refused',
      reason: snapshot.blocked ? 'identity_unknown' : snapshot.holder ? 'held' : 'fifo_waiter_precedes',
      holder: snapshot.holder,
      nextWaiter: snapshot.waiters[0] ?? null,
      blocked: snapshot.blocked,
    };
  }

  async release(input: {
    resource: string;
    participant: ResourceLeaseParticipant;
  }): Promise<ResourceLeaseReleaseResult> {
    const resource = normalizeResourceName(input.resource);
    const reconciled = await this.reconcile(resource);
    const current = this.readHolder(resource);
    if (!current) {
      return {
        released: false,
        lease: null,
        nextHolder: null,
        refusal: {
          code: reconciled.snapshot.blocked ? 'identity_unknown' : 'not_found',
          message: reconciled.snapshot.blocked?.message ?? `${resource} has no current holder.`,
          holder: null,
        },
      };
    }
    if (!sameObservedResourceLeaseOwner(current, input.participant.owner)) {
      return {
        released: false,
        lease: publicHolder(current, this.now()),
        nextHolder: null,
        refusal: {
          code: 'not_owner',
          message: `${resource} is held by ${current.owner_label} (${current.owner_id}, pid ${current.owner_pid}).`,
          holder: publicHolder(current, this.now()),
        },
      };
    }
    if (!sameResourceLeaseClaimHash(current.claim_token_hash, input.participant.claimTokenHash)) {
      return {
        released: false,
        lease: publicHolder(current, this.now()),
        nextHolder: null,
        refusal: {
          code: 'claim_unproven',
          message: `The caller did not prove the private claim for ${resource}.`,
          holder: publicHolder(current, this.now()),
        },
      };
    }
    const releasedAt = this.now();
    const released = this.sqlite.transaction(() => {
      const deleted = this.sqlite.prepare(`
        DELETE FROM resource_leases
        WHERE resource = ? AND lease_id = ? AND owner_identity_json = ?
      `).run(resource, current.lease_id, current.owner_identity_json);
      if (deleted.changes !== 1) return false;
      this.recordEvent(this.sqlite, resource, 'released', input.participant.actor, {
        leaseId: current.lease_id,
        owner: { id: current.owner_id, label: current.owner_label, pid: current.owner_pid },
        heldMs: Math.max(0, releasedAt - current.acquired_at),
      }, releasedAt);
      return true;
    }).immediate();
    if (!released) return this.release(input);
    const next = await this.reconcile(resource);
    return {
      released: true,
      lease: publicHolder(current, releasedAt),
      nextHolder: next.snapshot.holder,
      refusal: null,
    };
  }

  async heartbeat(input: {
    resource: string;
    participant: ResourceLeaseParticipant;
    ttlMs?: number;
  }): Promise<ResourceLeaseHolder | null> {
    const resource = normalizeResourceName(input.resource);
    const ttlMs = normalizeResourceLeaseTtl(input.ttlMs);
    await this.reconcile(resource);
    const current = this.readHolder(resource);
    if (!current || !sameObservedResourceLeaseParticipant(current, input.participant)) return null;
    const heartbeatAt = this.now();
    const updated = this.sqlite.prepare(`
      UPDATE resource_leases SET heartbeat_at = ?, ttl_ms = ?
      WHERE resource = ? AND lease_id = ? AND owner_identity_json = ?
    `).run(heartbeatAt, ttlMs, resource, current.lease_id, current.owner_identity_json);
    return updated.changes === 1
      ? publicHolder({ ...current, heartbeat_at: heartbeatAt, ttl_ms: ttlMs }, heartbeatAt)
      : null;
  }

  async timeoutWait(input: {
    resource: string;
    participant: ResourceLeaseParticipant;
    waiterId: string;
  }): Promise<ResourceLeaseSnapshot> {
    const resource = normalizeResourceName(input.resource);
    const waiterId = normalizeResourceLeaseWaiterId(input.waiterId);
    if (waiterId) {
      const timedOutAt = this.now();
      this.sqlite.transaction(() => {
        const deleted = this.sqlite.prepare(`
          DELETE FROM resource_lease_waiters
          WHERE waiter_id = ? AND resource = ? AND claim_token_hash = ?
        `).run(waiterId, resource, input.participant.claimTokenHash);
        if (deleted.changes === 1) {
          this.recordEvent(this.sqlite, resource, 'wait_timed_out', input.participant.actor, {
            waiterId,
            owner: {
              id: input.participant.owner.id,
              label: input.participant.owner.label,
              pid: input.participant.owner.pid,
            },
          }, timedOutAt);
        }
      }).immediate();
    }
    const current = this.readHolder(resource);
    if (current && sameObservedResourceLeaseParticipant(current, input.participant)) {
      await this.release({ resource, participant: input.participant });
    }
    return this.status(resource);
  }

  async status(resource: string): Promise<ResourceLeaseSnapshot> {
    return (await this.reconcile(resource)).snapshot;
  }

  async list(): Promise<ResourceLeaseSnapshot[]> {
    const rows = this.sqlite.prepare(`
      SELECT resource FROM resource_leases
      UNION
      SELECT resource FROM resource_lease_waiters
      ORDER BY resource ASC
    `).all() as Array<{ resource: string }>;
    const snapshots: ResourceLeaseSnapshot[] = [];
    for (const row of rows) snapshots.push((await this.reconcile(row.resource)).snapshot);
    return snapshots.filter((snapshot) => snapshot.holder || snapshot.waiters.length > 0);
  }

  async reconcileAll(): Promise<{
    inspected: number;
    holdersReaped: number;
    waitersReaped: number;
    promoted: number;
    retainedLive: number;
    retainedUnknown: number;
  }> {
    const resources = this.sqlite.prepare(`
      SELECT resource FROM resource_leases
      UNION
      SELECT resource FROM resource_lease_waiters
      ORDER BY resource ASC
    `).all() as Array<{ resource: string }>;
    const receipt = {
      inspected: resources.length,
      holdersReaped: 0,
      waitersReaped: 0,
      promoted: 0,
      retainedLive: 0,
      retainedUnknown: 0,
    };
    for (const row of resources) {
      const result = await this.reconcile(row.resource);
      if (result.holderReaped) receipt.holdersReaped += 1;
      receipt.waitersReaped += result.waitersReaped;
      if (result.promoted) receipt.promoted += 1;
      if (result.retainedLive) receipt.retainedLive += 1;
      if (result.retainedUnknown) receipt.retainedUnknown += 1;
    }
    return receipt;
  }
}
