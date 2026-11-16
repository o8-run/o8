import { getDb } from '@/lib/db';
import { usageLogs } from '@/lib/db/schema';

export type AnalyticsSurfaceKey = 'Codex CLI' | 'Claude Code' | 'OpenCode 2' | 'IDE LLM Chat' | 'Symon Voice';

type RecordUsageArgs = {
  ts: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cacheWriteTokens: number;
  model: string;
  agent: string;
  surface: AnalyticsSurfaceKey;
};

type AnalyticsSessionAccumulator = {
  id: string;
  agent: string;
  surface: AnalyticsSurfaceKey;
  cost: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cacheWriteTokens: number;
  model: string;
  models: Set<string>;
  active: boolean;
};

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

export function parseDbTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function runtimeSurfaceFromRow(row: typeof usageLogs.$inferSelect): AnalyticsSurfaceKey | null {
  if (row.agentName === 'codex' || row.agentName === 'Codex CLI' || row.sessionKey?.startsWith('codex')) {
    return 'Codex CLI';
  }
  if (row.agentName === 'claude-code' || row.agentName === 'Claude Code' || row.sessionKey?.startsWith('claude-code:')) {
    return 'Claude Code';
  }
  if (row.agentName === 'opencode' || row.agentName === 'OpenCode 2' || row.sessionKey?.startsWith('opencode-owned:')) {
    return 'OpenCode 2';
  }
  // Realtime voice spend (logged by /api/voice/realtime/usage). sessionKey is the
  // per-conversation `realtime-…` id, so all responses group into one session.
  if (row.agentName === 'Symon Voice' || row.sessionKey?.startsWith('realtime-')) {
    return 'Symon Voice';
  }
  return null;
}

function getOrCreateSession(
  sessions: Map<string, AnalyticsSessionAccumulator>,
  sessionKey: string,
  agent: string,
  surface: AnalyticsSurfaceKey,
  active: boolean,
): AnalyticsSessionAccumulator {
  let session = sessions.get(sessionKey);
  if (!session) {
    session = {
      id: sessionKey,
      agent,
      surface,
      cost: 0,
      messages: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      cacheWriteTokens: 0,
      model: 'unknown',
      models: new Set<string>(),
      active,
    };
    sessions.set(sessionKey, session);
  }
  return session;
}

export function hydrateUsageLogAnalytics(args: {
  sinceTs: number;
  normalizeModel: (model: string | null | undefined) => string;
  recordUsage: (args: RecordUsageArgs) => string;
  finalizeSession: (session: AnalyticsSessionAccumulator) => void;
}) {
  const db = getDb();
  const persistedRuntimeSessionKeys = new Set<string>();
  const llmModelsUsed = new Set<string>();
  let llmMessages = 0;
  let llmSessionCount = 0;

  if (!db) {
    return { persistedRuntimeSessionKeys, llmMessages, llmModelsUsed, llmSessionCount };
  }

  const runtimeSessions = new Map<string, AnalyticsSessionAccumulator>();
  const llmSessions = new Map<string, AnalyticsSessionAccumulator>();

  for (const row of db.select().from(usageLogs).all()) {
    const ts = parseDbTimestamp(row.createdAt);
    if (ts < args.sinceTs) {
      continue;
    }

    const inputTokens = row.inputTokens ?? 0;
    const outputTokens = row.outputTokens ?? 0;
    const cacheTokens = row.cacheReadTokens ?? 0;
    const cacheWriteTokens = row.cacheWriteTokens ?? 0;
    const cost = row.costUsd ?? 0;

    if (cost === 0 && inputTokens === 0 && outputTokens === 0 && cacheTokens === 0 && cacheWriteTokens === 0) {
      continue;
    }

    if (row.agentName === 'llm-chat' && (!row.requestType || row.requestType === 'chat')) {
      const model = args.normalizeModel(row.model);
      args.recordUsage({
        ts,
        cost,
        inputTokens,
        outputTokens,
        cacheTokens,
        cacheWriteTokens,
        model,
        agent: 'IDE LLM Chat',
        surface: 'IDE LLM Chat',
      });

      llmMessages += 1;
      llmModelsUsed.add(model);

      const sessionKey = row.sessionKey?.trim();
      if (!sessionKey) {
        continue;
      }

      const session = getOrCreateSession(
        llmSessions,
        sessionKey,
        'IDE LLM Chat',
        'IDE LLM Chat',
        (Date.now() - ts) < ACTIVE_WINDOW_MS,
      );
      session.active = session.active || (Date.now() - ts) < ACTIVE_WINDOW_MS;
      session.cost += cost;
      session.messages += 1;
      session.inputTokens += inputTokens;
      session.outputTokens += outputTokens;
      session.cacheTokens += cacheTokens;
      session.cacheWriteTokens += cacheWriteTokens;
      session.models.add(model);
      if (session.model === 'unknown' || session.model === '') session.model = model;
      continue;
    }

    if (row.requestType !== 'completion') {
      continue;
    }

    const sessionKey = row.sessionKey?.trim();
    const surface = runtimeSurfaceFromRow(row);
    if (!sessionKey || !surface) {
      continue;
    }

    persistedRuntimeSessionKeys.add(sessionKey);
    const model = args.normalizeModel(row.model);
    args.recordUsage({
      ts,
      cost,
      inputTokens,
      outputTokens,
      cacheTokens,
      cacheWriteTokens,
      model,
      agent: surface,
      surface,
    });

    const session = getOrCreateSession(runtimeSessions, sessionKey, surface, surface, false);
    session.cost += cost;
    session.messages += 1;
    session.inputTokens += inputTokens;
    session.outputTokens += outputTokens;
    session.cacheTokens += cacheTokens;
    session.cacheWriteTokens += cacheWriteTokens;
    session.models.add(model);
    if (session.model === 'unknown' || session.model === '') session.model = model;
  }

  for (const session of runtimeSessions.values()) {
    args.finalizeSession(session);
  }

  llmSessionCount = llmSessions.size;
  for (const session of llmSessions.values()) {
    args.finalizeSession(session);
  }

  return { persistedRuntimeSessionKeys, llmMessages, llmModelsUsed, llmSessionCount };
}
