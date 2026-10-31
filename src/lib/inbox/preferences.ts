/**
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code),
 * packages/client-runtime/src/state/threadSort.ts and
 * apps/server/src/orchestration-v2/Orchestrator.ts, commit
 * f58fad04162165653bf06f0c987bbfb0074a8a4b.
 * Copyright (c) 2026 T3 Tools Inc.; MIT; see licenses/t3code-MIT.txt.
 * Adapted for o8: subject-scoped metadata, fractional keys and atomic revision guards.
 */
import type { InboxSettlement } from './settlement';

export interface InboxPreferences {
  pinnedAt?: string | null;
  pinOrderKey?: string | null;
  activeOrderKey?: string | null;
  autoSettleDisabledAt?: string | null;
  inboxRevision?: number;
}
export type InboxPreferenceAction = 'pin' | 'unpin' | 'pin-reorder' | 'active-reorder' | 'auto-settle';
export interface InboxPreferenceCommand {
  action: InboxPreferenceAction;
  orderKey?: string | null;
  enabled?: boolean;
}
export const isInboxPreferenceAction = (action: unknown): action is InboxPreferenceAction =>
  ['pin', 'unpin', 'pin-reorder', 'active-reorder', 'auto-settle'].includes(String(action));
/** Upstream fractional alphabet; trailing minimum leaves no space before the key. */
export const validInboxOrderKey = (key: unknown): key is string | null =>
  key === null || (typeof key === 'string' && /^[a-z]{1,256}$/.test(key) && !key.endsWith('a'));

export function transitionInboxPreferences(state: InboxSettlement & InboxPreferences,
  command: InboxPreferenceCommand, now: string): Partial<InboxSettlement & InboxPreferences> {
  switch (command.action) {
    case 'pin': return {
      pinnedAt: state.pinnedAt ?? now,
      pinOrderKey: state.pinnedAt ? state.pinOrderKey ?? null : command.orderKey ?? null,
      settledOverride: state.settledOverride === 'settled' ? 'active' : state.settledOverride,
      settledAt: state.settledOverride === 'settled' ? null : state.settledAt,
    };
    case 'unpin': return { pinnedAt: null, pinOrderKey: null };
    case 'pin-reorder': return { pinOrderKey: command.orderKey ?? null };
    case 'active-reorder': return { activeOrderKey: command.orderKey ?? null };
    case 'auto-settle': return { autoSettleDisabledAt: command.enabled ? null : state.autoSettleDisabledAt ?? now };
  }
}
/** Old true pins have no event timestamp. A fixed epoch survives transcript saves. */
export function legacyInboxPin(record: { pinned?: unknown }): string | null {
  return record.pinned === true ? '1970-01-01T00:00:00.000Z' : null;
}
