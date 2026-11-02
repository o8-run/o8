import { isAutoSettleIdleDays } from './auto-settle-idle-days';

export interface ConversationDefaults {
  autoTitleInferenceEnabled: boolean; // Optional background inference; code fallback remains available.
  autoSettleEnabled: boolean; // Settle completed merges and eligible idle threads.
  autoSettleIdleDays: number; // Threads with a PR or worker only; 0 disables idle settlement.
}

export const FALLBACK: ConversationDefaults = {
  autoTitleInferenceEnabled: true,
  autoSettleEnabled: true,
  autoSettleIdleDays: 3,
};

export function fromFile(stored: Partial<Record<keyof ConversationDefaults, unknown>>): Partial<ConversationDefaults> {
  const result: Partial<ConversationDefaults> = {};
  if (typeof stored.autoTitleInferenceEnabled === 'boolean') result.autoTitleInferenceEnabled = stored.autoTitleInferenceEnabled;
  if (typeof stored.autoSettleEnabled === 'boolean') result.autoSettleEnabled = stored.autoSettleEnabled;
  if (isAutoSettleIdleDays(stored.autoSettleIdleDays)) result.autoSettleIdleDays = stored.autoSettleIdleDays;
  return result;
}

export function resolve(values: Partial<ConversationDefaults>): ConversationDefaults {
  return {
    autoTitleInferenceEnabled: values.autoTitleInferenceEnabled ?? FALLBACK.autoTitleInferenceEnabled,
    autoSettleEnabled: values.autoSettleEnabled ?? FALLBACK.autoSettleEnabled,
    autoSettleIdleDays: values.autoSettleIdleDays ?? FALLBACK.autoSettleIdleDays,
  };
}

export function sources(values: Partial<ConversationDefaults>): Record<keyof ConversationDefaults, 'file' | 'default'> {
  return {
    autoTitleInferenceEnabled: values.autoTitleInferenceEnabled !== undefined ? 'file' : 'default',
    autoSettleEnabled: values.autoSettleEnabled !== undefined ? 'file' : 'default',
    autoSettleIdleDays: values.autoSettleIdleDays !== undefined ? 'file' : 'default',
  };
}

export function forUpdate(update: Partial<ConversationDefaults>): Partial<ConversationDefaults> {
  const stored: Partial<ConversationDefaults> = {};
  if (update.autoTitleInferenceEnabled !== undefined) stored.autoTitleInferenceEnabled = Boolean(update.autoTitleInferenceEnabled);
  if (update.autoSettleEnabled !== undefined) stored.autoSettleEnabled = Boolean(update.autoSettleEnabled);
  if (update.autoSettleIdleDays !== undefined) stored.autoSettleIdleDays = update.autoSettleIdleDays;
  return stored;
}

export function parseUpdate(body: Record<string, unknown>): Partial<ConversationDefaults> {
  const update: Partial<ConversationDefaults> = {};
  if (body.autoSettleEnabled !== undefined) {
    if (typeof body.autoSettleEnabled !== 'boolean') {
      throw new Error('autoSettleEnabled must be boolean.');
    }
    update.autoSettleEnabled = body.autoSettleEnabled;
  }
  if (body.autoSettleIdleDays !== undefined) {
    if (!isAutoSettleIdleDays(body.autoSettleIdleDays)) {
      throw new Error('autoSettleIdleDays must be a whole number from 0 to 365.');
    }
    update.autoSettleIdleDays = body.autoSettleIdleDays;
  }
  if (body.autoTitleInferenceEnabled !== undefined) {
    if (typeof body.autoTitleInferenceEnabled !== 'boolean') {
      throw new Error('autoTitleInferenceEnabled must be boolean.');
    }
    update.autoTitleInferenceEnabled = body.autoTitleInferenceEnabled;
  }
  return update;
}
