import { recurring } from '@/lib/background-work/ledger';
import type { BrowserInventorySnapshot } from '@/lib/browser/types';
import type { CommandCenterSnapshot } from '@/lib/command-center/snapshot';
import { getCommandCenterSnapshotWithOptions } from '@/lib/command-center/snapshot';
import type { RenderBootstrapSource, RenderBootstrapState } from '@/lib/render/client-merge';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import { getMobileInboxSnapshot } from '@/lib/mobile/inbox';
import type { FleetSnapshot } from '@/lib/fleet/types';
import { getDataDir } from '@/lib/data-dir-migration';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';

export interface RenderBootstrapTiming {
  totalMs: number;
  brokerMs: number;
  refreshMs: number;
}

export interface RenderBootstrapResult<T> {
  snapshot: T;
  source: RenderBootstrapSource;
  state: RenderBootstrapState;
  note: string;
  refreshedAt: number | null;
  timing: RenderBootstrapTiming;
  serverTiming: string;
}

interface BrokerRecord<T> {
  snapshot: T;
  version: number;
  refreshedAt: number;
  note: string;
  state: RenderBootstrapState;
}

interface BrokerState<T> {
  record: BrokerRecord<T> | null;
  inflight: Promise<BrokerRecord<T>> | null;
  generation: number;
  lastAccessedAt: number;
}

const BROKER_HOT_TTL_MS = 12_000;
const BROKER_WARM_TIMEOUT_MS = 250;

const EMPTY_BROWSER_INVENTORY: BrowserInventorySnapshot = {
  generatedAt: '',
  sourceLabel: 'Browser inventory warming…',
  surfaces: [],
};
const RENDER_BOOTSTRAP_CACHE_DIR = join(getDataDir(), 'render-bootstrap');
const COMMAND_CENTER_BROKER_PATH = join(RENDER_BOOTSTRAP_CACHE_DIR, 'command-center.json');
const MOBILE_BROKER_PATH = join(RENDER_BOOTSTRAP_CACHE_DIR, 'mobile.json');

type CommandCenterBroker = ReturnType<typeof createBroker<CommandCenterSnapshot>>;
type MobileBroker = ReturnType<typeof createBroker<MobileInboxSnapshot>>;

interface RenderBootstrapGlobalState {
  commandCenterBroker: CommandCenterBroker;
  mobileBroker: MobileBroker;
  brokerWarmersStarted: boolean;
  commandCenterWarmerTimer: ReturnType<typeof setInterval> | null;
  mobileWarmerTimer: ReturnType<typeof setInterval> | null;
}

const renderBootstrapGlobals = globalThis as typeof globalThis & {
  __cortexRenderBootstrapState?: RenderBootstrapGlobalState;
};

function nowMs() {
  return performance.now();
}

function createServerTiming(parts: Array<{ name: string; durMs: number; desc?: string }>) {
  return parts
    .map(({ name, durMs, desc }) => {
      const base = `${name};dur=${Math.max(0, durMs).toFixed(1)}`;
      if (!desc) return base;
      const escapedDesc = desc.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `${base};desc="${escapedDesc}"`;
    })
    .join(', ');
}

function createShellCommandCenterSnapshot(): CommandCenterSnapshot {
  const now = new Date().toISOString();
  const emptyFleet: FleetSnapshot = {
    generatedAt: now,
    meta: {
      mode: 'demo',
      sourceLabel: 'Command center shell warming',
      mirrorMode: 'demo-only',
      note: 'Shell rendered immediately. Live runtime, review, and browser truth are still warming in the background.',
    },
    squads: [],
    agents: [],
    events: [],
    artifacts: [],
  };

  return {
    fleet: emptyFleet,
    review: null,
    browserInventory: EMPTY_BROWSER_INVENTORY,
    attachedBrowser: null,
    reviewError: null,
    browserError: null,
  };
}

function createShellMobileSnapshot(): MobileInboxSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    mode: 'demo',
    sourceLabel: 'Mobile shell warming',
    note: 'Shell rendered immediately. Live inbox, transcript, and review truth are still warming in the background.',
    sessions: [],
    fleetSessions: [],
    approvals: [],
    reviewUnits: [],
    items: [],
    summary: {
      alerts: 0,
      approvals: 0,
      reviewItems: 0,
      activeRuns: 0,
    },
  };
}

function serializeBootstrapResult<T>(result: RenderBootstrapResult<T>) {
  return {
    ...result,
    snapshot: result.snapshot,
    timing: {
      totalMs: Math.round(result.timing.totalMs),
      brokerMs: Math.round(result.timing.brokerMs),
      refreshMs: Math.round(result.timing.refreshMs),
    },
  };
}

function createBroker<T>() {
  const state: BrokerState<T> = {
    record: null,
    inflight: null,
    generation: 0,
    lastAccessedAt: 0,
  };

  return {
    hydrate(record: BrokerRecord<T>) {
      state.record = record;
    },
    markAccessed() {
      state.lastAccessedAt = Date.now();
    },
    wasAccessedRecently(windowMs: number) {
      return Date.now() - state.lastAccessedAt <= windowMs;
    },
    invalidate() {
      state.generation += 1;
      state.record = null;
      state.inflight = null;
    },
    getRecord() {
      return state.record;
    },
    async refresh(
      loader: () => Promise<{ snapshot: T; note: string; state: RenderBootstrapState }>,
      force = false,
    ) {
      if (force) {
        state.generation += 1;
        state.inflight = null;
      }
      const generation = state.generation;
      if (state.inflight) return state.inflight;

      state.inflight = loader()
        .then((next) => {
          const refreshedAt = Date.now();
          if (generation === state.generation) {
            state.record = {
              snapshot: next.snapshot,
              version: refreshedAt,
              refreshedAt,
              note: next.note,
              state: next.state,
            };
          }
          return {
            snapshot: next.snapshot,
            version: refreshedAt,
            refreshedAt,
            note: next.note,
            state: next.state,
          } satisfies BrokerRecord<T>;
        })
        .finally(() => {
          if (state.inflight) {
            state.inflight = null;
          }
        });

      return state.inflight;
    },
  };
}

const BROKER_WARMER_INTERVAL_MS = 10_000;
const BROKER_ACTIVE_WINDOW_MS = 120_000;

const renderBootstrapState = renderBootstrapGlobals.__cortexRenderBootstrapState ??= {
  commandCenterBroker: createBroker<CommandCenterSnapshot>(),
  mobileBroker: createBroker<MobileInboxSnapshot>(),
  brokerWarmersStarted: false,
  commandCenterWarmerTimer: null,
  mobileWarmerTimer: null,
};

const { commandCenterBroker, mobileBroker } = renderBootstrapState;

async function loadCommandCenterBrokerSnapshot(fresh: boolean) {
  const snapshot = await getCommandCenterSnapshotWithOptions({ fresh });
  const nextState: RenderBootstrapState = snapshot.fleet.meta.mode === 'live'
    ? (snapshot.fleet.meta.gatewayFreshness === 'fresh' && !snapshot.fleet.meta.observablePending ? 'live' : 'warming')
    : 'degraded';
  const nextNote = snapshot.fleet.meta.note
    ?? (nextState === 'live'
      ? 'Operator broker is hot.'
      : nextState === 'warming'
        ? 'Operator broker is warming.'
        : 'Operator broker fell back to degraded shell data.');
  return { snapshot, note: nextNote, state: nextState };
}

async function loadMobileBrokerSnapshot(fresh: boolean) {
  const snapshot = await getMobileInboxSnapshot({ fresh });
  const nextState: RenderBootstrapState = snapshot.mode === 'live' ? 'live' : 'warming';
  const nextNote = snapshot.note
    ?? (nextState === 'live'
      ? 'Mobile broker is hot.'
      : 'Mobile inbox is warming.');
  return { snapshot, note: nextNote, state: nextState };
}

function unrefTimer(timer: ReturnType<typeof setInterval>) {
  if ('unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

function persistBrokerRecord<T>(filePath: string, record: BrokerRecord<T>) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(record), 'utf8');
    renameSync(tempPath, filePath);
  } catch {
    // Instrumentation/broker persistence should degrade quietly.
  }
}

function readBrokerRecord<T>(filePath: string): BrokerRecord<T> | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8')) as BrokerRecord<T>;
  } catch {
    return null;
  }
}

function clearBrokerRecord(filePath: string) {
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Broker invalidation should degrade quietly.
  }
}

function getSharedBrokerRecord<T>(
  broker: ReturnType<typeof createBroker<T>>,
  filePath: string,
) {
  const memoryRecord = broker.getRecord();
  const diskRecord = readBrokerRecord<T>(filePath);
  const preferredRecord = !memoryRecord
    ? diskRecord
    : !diskRecord
      ? memoryRecord
      : diskRecord.version >= memoryRecord.version
        ? diskRecord
        : memoryRecord;
  if (preferredRecord && preferredRecord !== memoryRecord) {
    broker.hydrate(preferredRecord);
  }
  return preferredRecord;
}

async function refreshCommandCenterBroker(force: boolean) {
  const record = await commandCenterBroker.refresh(() => loadCommandCenterBrokerSnapshot(force), force);
  persistBrokerRecord(COMMAND_CENTER_BROKER_PATH, record);
  return record;
}

async function refreshMobileBroker(force: boolean) {
  const record = await mobileBroker.refresh(() => loadMobileBrokerSnapshot(force), force);
  persistBrokerRecord(MOBILE_BROKER_PATH, record);
  return record;
}

function ensureBootstrapWarmers() {
  if (renderBootstrapState.brokerWarmersStarted) return;
  renderBootstrapState.brokerWarmersStarted = true;

  renderBootstrapState.commandCenterWarmerTimer = recurring('render-command-center-warmer', () => {
    const record = getSharedBrokerRecord(commandCenterBroker, COMMAND_CENTER_BROKER_PATH);
    const isHot = record && Date.now() - record.refreshedAt <= BROKER_HOT_TTL_MS;
    if (!commandCenterBroker.wasAccessedRecently(BROKER_ACTIVE_WINDOW_MS) || isHot) return;
    void refreshCommandCenterBroker(false).catch(() => null);
  }, BROKER_WARMER_INTERVAL_MS);
  unrefTimer(renderBootstrapState.commandCenterWarmerTimer);

  renderBootstrapState.mobileWarmerTimer = recurring('render-mobile-warmer', () => {
    const record = getSharedBrokerRecord(mobileBroker, MOBILE_BROKER_PATH);
    const isHot = record && Date.now() - record.refreshedAt <= BROKER_HOT_TTL_MS;
    if (!mobileBroker.wasAccessedRecently(BROKER_ACTIVE_WINDOW_MS) || isHot) return;
    void refreshMobileBroker(false).catch(() => null);
  }, BROKER_WARMER_INTERVAL_MS);
  unrefTimer(renderBootstrapState.mobileWarmerTimer);
}

async function getCommandCenterHotRecord(fresh: boolean, budgetMs: number) {
  ensureBootstrapWarmers();
  commandCenterBroker.markAccessed();
  const startedAt = nowMs();
  const record = getSharedBrokerRecord(commandCenterBroker, COMMAND_CENTER_BROKER_PATH);
  const ageMs = record ? Date.now() - record.refreshedAt : Infinity;

  if (record && !fresh && ageMs <= BROKER_HOT_TTL_MS) {
    return {
      snapshot: record.snapshot,
      source: 'hot-broker' as const,
      state: record.state,
      note: record.note,
      refreshedAt: record.refreshedAt,
      timing: {
        totalMs: nowMs() - startedAt,
        brokerMs: nowMs() - startedAt,
        refreshMs: 0,
      },
    };
  }

  const refreshStarted = nowMs();
  const refresh = refreshCommandCenterBroker(fresh).catch(() => null);

  if (budgetMs <= 0) {
    if (record) {
      return {
        snapshot: record.snapshot,
        source: 'degraded' as const,
        state: record.state === 'live' ? 'stale' as const : record.state,
        note: `${record.note} (stale broker snapshot)`,
        refreshedAt: record.refreshedAt,
        timing: {
          totalMs: nowMs() - startedAt,
          brokerMs: refreshStarted - startedAt,
          refreshMs: 0,
        },
      };
    }

    return {
      snapshot: createShellCommandCenterSnapshot(),
      source: 'shell-only' as const,
      state: 'warming' as const,
      note: 'Shell rendered without live runtime discovery. Bootstrap will fill in after paint.',
      refreshedAt: null,
      timing: {
        totalMs: nowMs() - startedAt,
        brokerMs: refreshStarted - startedAt,
        refreshMs: 0,
      },
    };
  }

  const raced = await Promise.race([
    refresh,
    new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), budgetMs);
      if ('unref' in timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    }),
  ]);

  const nextRecord = commandCenterBroker.getRecord();
  if (raced !== 'timeout' && nextRecord) {
    return {
      snapshot: nextRecord.snapshot,
      source: 'hot-broker' as const,
      state: nextRecord.state,
      note: nextRecord.note,
      refreshedAt: nextRecord.refreshedAt,
      timing: {
        totalMs: nowMs() - startedAt,
        brokerMs: refreshStarted - startedAt,
        refreshMs: nowMs() - refreshStarted,
      },
    };
  }

  if (record) {
    return {
      snapshot: record.snapshot,
      source: 'degraded' as const,
      state: record.state,
      note: `${record.note} (stale broker snapshot)`,
      refreshedAt: record.refreshedAt,
      timing: {
        totalMs: nowMs() - startedAt,
        brokerMs: refreshStarted - startedAt,
        refreshMs: 0,
      },
    };
  }

  return {
    snapshot: createShellCommandCenterSnapshot(),
    source: 'shell-only' as const,
    state: 'warming' as const,
    note: 'Shell rendered without live runtime discovery. Bootstrap will fill in after paint.',
    refreshedAt: null,
    timing: {
      totalMs: nowMs() - startedAt,
      brokerMs: refreshStarted - startedAt,
      refreshMs: 0,
    },
  };
}

async function getMobileHotRecord(fresh: boolean, budgetMs: number) {
  ensureBootstrapWarmers();
  mobileBroker.markAccessed();
  const startedAt = nowMs();
  const record = getSharedBrokerRecord(mobileBroker, MOBILE_BROKER_PATH);
  const ageMs = record ? Date.now() - record.refreshedAt : Infinity;

  if (record && !fresh && ageMs <= BROKER_HOT_TTL_MS) {
    return {
      snapshot: record.snapshot,
      source: 'hot-broker' as const,
      state: record.state,
      note: record.note,
      refreshedAt: record.refreshedAt,
      timing: {
        totalMs: nowMs() - startedAt,
        brokerMs: nowMs() - startedAt,
        refreshMs: 0,
      },
    };
  }

  const refreshStarted = nowMs();
  const refresh = refreshMobileBroker(fresh).catch(() => null);

  if (budgetMs <= 0) {
    if (record) {
      return {
        snapshot: record.snapshot,
        source: 'degraded' as const,
        state: record.state === 'live' ? 'stale' as const : record.state,
        note: `${record.note} (stale broker snapshot)`,
        refreshedAt: record.refreshedAt,
        timing: {
          totalMs: nowMs() - startedAt,
          brokerMs: refreshStarted - startedAt,
          refreshMs: 0,
        },
      };
    }

    return {
      snapshot: createShellMobileSnapshot(),
      source: 'shell-only' as const,
      state: 'warming' as const,
      note: 'Shell rendered without live mobile discovery. Inbox bootstrap will fill in after paint.',
      refreshedAt: null,
      timing: {
        totalMs: nowMs() - startedAt,
        brokerMs: refreshStarted - startedAt,
        refreshMs: 0,
      },
    };
  }

  const raced = await Promise.race([
    refresh,
    new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), budgetMs);
      if ('unref' in timer && typeof timer.unref === 'function') {
        timer.unref();
      }
    }),
  ]);

  const nextRecord = mobileBroker.getRecord();
  if (raced !== 'timeout' && nextRecord) {
    return {
      snapshot: nextRecord.snapshot,
      source: 'hot-broker' as const,
      state: nextRecord.state,
      note: nextRecord.note,
      refreshedAt: nextRecord.refreshedAt,
      timing: {
        totalMs: nowMs() - startedAt,
        brokerMs: refreshStarted - startedAt,
        refreshMs: nowMs() - refreshStarted,
      },
    };
  }

  if (record) {
    return {
      snapshot: record.snapshot,
      source: 'degraded' as const,
      state: record.state,
      note: `${record.note} (stale broker snapshot)`,
      refreshedAt: record.refreshedAt,
      timing: {
        totalMs: nowMs() - startedAt,
        brokerMs: refreshStarted - startedAt,
        refreshMs: 0,
      },
    };
  }

  return {
    snapshot: createShellMobileSnapshot(),
    source: 'shell-only' as const,
    state: 'warming' as const,
    note: 'Shell rendered without live mobile discovery. Inbox bootstrap will fill in after paint.',
    refreshedAt: null,
    timing: {
      totalMs: nowMs() - startedAt,
      brokerMs: refreshStarted - startedAt,
      refreshMs: 0,
    },
  };
}

export async function getCommandCenterBootstrap(options: { fresh?: boolean; budgetMs?: number } = {}) {
  const result = await getCommandCenterHotRecord(options.fresh ?? false, options.budgetMs ?? BROKER_WARM_TIMEOUT_MS);
  return {
    ...result,
    serverTiming: createServerTiming([
      { name: 'broker', durMs: result.timing.brokerMs, desc: result.source },
      { name: 'refresh', durMs: result.timing.refreshMs },
      { name: 'total', durMs: result.timing.totalMs },
    ]),
  } satisfies RenderBootstrapResult<CommandCenterSnapshot>;
}

export async function getMobileBootstrap(options: { fresh?: boolean; budgetMs?: number } = {}) {
  const result = await getMobileHotRecord(options.fresh ?? false, options.budgetMs ?? BROKER_WARM_TIMEOUT_MS);
  return {
    ...result,
    serverTiming: createServerTiming([
      { name: 'broker', durMs: result.timing.brokerMs, desc: result.source },
      { name: 'refresh', durMs: result.timing.refreshMs },
      { name: 'total', durMs: result.timing.totalMs },
    ]),
  } satisfies RenderBootstrapResult<MobileInboxSnapshot>;
}

export function createCommandCenterShellSnapshot() {
  return createShellCommandCenterSnapshot();
}

export function createMobileShellSnapshot() {
  return createShellMobileSnapshot();
}

export function invalidateCommandCenterBootstrapBroker() {
  commandCenterBroker.invalidate();
  clearBrokerRecord(COMMAND_CENTER_BROKER_PATH);
}

export function invalidateMobileBootstrapBroker() {
  mobileBroker.invalidate();
  clearBrokerRecord(MOBILE_BROKER_PATH);
}

export function getBootstrapServerTimingHeader(result: RenderBootstrapResult<unknown>) {
  return result.serverTiming;
}

export function toBootstrapResponse<T>(result: RenderBootstrapResult<T>) {
  return serializeBootstrapResult(result);
}
