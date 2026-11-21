import 'server-only';

import { existsSync, readFileSync } from 'node:fs';
import { connect, constants as http2Constants } from 'node:http2';
import type { ClientHttp2Stream } from 'node:http2';
import { basename, join } from 'node:path';
import { importPKCS8, SignJWT } from 'jose';
import type { AgentStatus } from '@/lib/fleet/types';
import { getSqlite } from '@/lib/db';
import type { MobileInboxSnapshot } from '@/lib/mobile/types';
import { getDataDir } from '@/lib/data-dir-migration';

type MobileLiveActivityStatus =
  | 'queued'
  | 'running'
  | 'awaiting_review'
  | 'merged'
  | 'failed'
  | 'idle';

type MobileLiveActivityMode =
  | 'browser'
  | 'terminal'
  | 'review'
  | 'fleet'
  | 'activity'
  | 'unknown';

interface O8LiveActivityProps {
  status: MobileLiveActivityStatus;
  title: string;
  detail: string;
  repo?: string;
  sourceLabel: string;
  active: number;
  approvals: number;
  failures: number;
  queued: number;
  updatedAt: number;
  actionLabel: string;
  deepLink: string;
  microAction?: string;
  elapsedLabel?: string | null;
  goal?: string;
  mode?: MobileLiveActivityMode;
  backgroundCapable?: boolean;
}

interface StoredMobileLiveActivityToken {
  pushToken: string;
  activityId: string | null;
  bundleId: string;
  environment: 'sandbox' | 'production';
  deviceLabel: string | null;
  lastSignature: string | null;
  lastDeliveredAt: number | null;
  failureCount: number;
}

interface RegisterMobileLiveActivityTokenInput {
  pushToken: string;
  activityId?: string | null;
  bundleId?: string | null;
  environment?: 'sandbox' | 'production' | null;
  deviceLabel?: string | null;
  /**
   * R3 (o8 Relay v1): the standard APNs remote-notification device token
   * (alert-capable), registered alongside the ActivityKit `pushToken`. The relay
   * sends the generic "approval waiting" ALERT push against THIS token — the
   * ActivityKit token cannot carry a generic alert (Apple rejects it).
   */
  remoteNotificationToken?: string | null;
}

interface ActivityKitSendResult {
  token: string;
  ok: boolean;
  status: number;
  action: 'updated' | 'ended' | 'skipped' | 'failed';
  reason?: string;
}

interface ActivityKitSyncResult {
  ok: boolean;
  pushed: number;
  skipped: number;
  failed: number;
  reason?: string;
  results: ActivityKitSendResult[];
}

const O8_LIVE_ACTIVITY_NAME = 'O8AgentActivity';
const DEFAULT_BUNDLE_ID = 'com.marquisehurtt.o8mobile';
const MAX_FAILURE_COUNT = 5;
const APNS_JWT_TTL_SECONDS = 20 * 60;
const APNS_REQUEST_TIMEOUT_MS = 10_000;

type ApnsHttp2Response = {
  status: number;
  body: { reason?: string } | null;
};

type ApnsConfigFile = {
  keyId?: string;
  teamId?: string;
  privateKey?: string;
  privateKeyPath?: string;
  environment?: 'sandbox' | 'production' | 'development' | 'dev' | 'prod';
  bundleId?: string;
};

const STATUS_ORDER: MobileLiveActivityStatus[] = [
  'failed',
  'awaiting_review',
  'running',
  'queued',
  'merged',
  'idle',
];

const BROWSER_MICRO_ACTIONS = new Set([
  'Navigate',
  'Observe',
  'Click',
  'Type',
  'Scroll',
]);

let apnsJwtCache: {
  key: string;
  token: string;
  expiresAt: number;
} | null = null;

let apnsConfigCache: ApnsConfigFile | null | undefined;

function normalizePrivateKey(value: string) {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

function optionalString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function apnsConfigPath() {
  return process.env.O8_APNS_CONFIG_PATH?.trim()
    || join(
      getDataDir(),
      'apns.json',
    );
}

function readApnsConfigFile(): ApnsConfigFile | null {
  if (apnsConfigCache !== undefined) return apnsConfigCache;
  const path = apnsConfigPath();
  if (!existsSync(path)) {
    apnsConfigCache = null;
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ApnsConfigFile;
    apnsConfigCache = parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn('[mobile/live-activity] APNs config file could not be read', error);
    apnsConfigCache = null;
  }
  return apnsConfigCache;
}

function getApnsCredentials() {
  const config = readApnsConfigFile();
  const keyId = optionalString(process.env.O8_APNS_KEY_ID ?? process.env.APPLE_KEY_ID)
    ?? optionalString(config?.keyId);
  const teamId = optionalString(process.env.O8_APNS_TEAM_ID ?? process.env.APPLE_TEAM_ID)
    ?? optionalString(config?.teamId);
  const privateKeyFromEnv = optionalString(process.env.O8_APNS_PRIVATE_KEY)
    ?? optionalString(config?.privateKey);
  const privateKeyPath = optionalString(process.env.O8_APNS_PRIVATE_KEY_PATH ?? process.env.O8_APNS_P8_PATH)
    ?? optionalString(config?.privateKeyPath);
  const privateKey = privateKeyFromEnv
    ? normalizePrivateKey(privateKeyFromEnv)
    : privateKeyPath
      ? readFileSync(privateKeyPath, 'utf8')
      : null;

  if (!keyId || !teamId || !privateKey) {
    return {
      ok: false as const,
      reason: 'APNs credentials are not configured. Set O8_APNS_KEY_ID, O8_APNS_TEAM_ID, and O8_APNS_PRIVATE_KEY or O8_APNS_PRIVATE_KEY_PATH.',
    };
  }

  return { ok: true as const, keyId, teamId, privateKey };
}

function configuredApnsEnvironment(): 'sandbox' | 'production' {
  const config = readApnsConfigFile();
  const raw = (process.env.O8_APNS_ENV ?? config?.environment)?.trim().toLowerCase();
  if (raw === 'production' || raw === 'prod') return 'production';
  if (raw === 'sandbox' || raw === 'development' || raw === 'dev') return 'sandbox';
  return process.env.NODE_ENV === 'production' ? 'production' : 'sandbox';
}

function configuredBundleId() {
  const config = readApnsConfigFile();
  return optionalString(process.env.O8_APNS_BUNDLE_ID) ?? optionalString(config?.bundleId) ?? DEFAULT_BUNDLE_ID;
}

async function getApnsJwt() {
  const credentials = getApnsCredentials();
  if (!credentials.ok) return credentials;

  const cacheKey = `${credentials.teamId}:${credentials.keyId}:${credentials.privateKey}`;
  if (apnsJwtCache && apnsJwtCache.key === cacheKey && apnsJwtCache.expiresAt > Date.now() + 60_000) {
    return { ok: true as const, token: apnsJwtCache.token };
  }

  const key = await importPKCS8(credentials.privateKey, 'ES256');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: credentials.keyId })
    .setIssuer(credentials.teamId)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + APNS_JWT_TTL_SECONDS)
    .sign(key);

  apnsJwtCache = {
    key: cacheKey,
    token,
    expiresAt: Date.now() + APNS_JWT_TTL_SECONDS * 1000,
  };
  return { ok: true as const, token };
}

function sendApnsHttp2Request({
  host,
  deviceToken,
  authorization,
  topic,
  payload,
}: {
  host: string;
  deviceToken: string;
  authorization: string;
  topic: string;
  payload: unknown;
}): Promise<ApnsHttp2Response> {
  return new Promise((resolve, reject) => {
    const session = connect(`https://${host}`);
    let request: ClientHttp2Stream | null = null;
    let settled = false;
    let status = 0;
    let body = '';

    const timeout = setTimeout(() => {
      finish(() => reject(new Error('APNs request timed out')));
    }, APNS_REQUEST_TIMEOUT_MS);

    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request?.close();
      session.close();
      complete();
    };

    session.on('error', (error) => {
      finish(() => reject(error));
    });

    request = session.request({
      [http2Constants.HTTP2_HEADER_METHOD]: 'POST',
      [http2Constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
      authorization,
      'apns-topic': topic,
      'apns-push-type': 'liveactivity',
      'apns-priority': '10',
      'content-type': 'application/json',
    });

    request.setEncoding('utf8');
    request.on('response', (headers) => {
      const headerStatus = headers[http2Constants.HTTP2_HEADER_STATUS];
      status = typeof headerStatus === 'number'
        ? headerStatus
        : Number(Array.isArray(headerStatus) ? headerStatus[0] : headerStatus ?? 0);
    });
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      finish(() => {
        let parsed: { reason?: string } | null = null;
        if (body.trim().length > 0) {
          try {
            parsed = JSON.parse(body) as { reason?: string };
          } catch {
            parsed = { reason: body.trim() };
          }
        }
        resolve({ status, body: parsed });
      });
    });
    request.on('error', (error) => {
      finish(() => reject(error));
    });

    request.end(JSON.stringify(payload));
  });
}

function tokenTableExists() {
  const sqlite = getSqlite();
  const row = sqlite.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'mobile_live_activity_tokens'
  `).get() as { name?: string } | undefined;
  return Boolean(row?.name);
}

function liveActivityDb() {
  const sqlite = getSqlite();
  if (!tokenTableExists()) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS mobile_live_activity_tokens (
        push_token TEXT PRIMARY KEY,
        activity_id TEXT,
        bundle_id TEXT NOT NULL,
        environment TEXT NOT NULL DEFAULT 'sandbox',
        device_label TEXT,
        last_signature TEXT,
        last_delivered_at INTEGER,
        failure_count INTEGER NOT NULL DEFAULT 0,
        remote_notification_token TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_mobile_live_activity_tokens_updated_at
        ON mobile_live_activity_tokens(updated_at);
    `);
  }
  // R3 (o8 Relay v1): the alert-capable remote-notification device token lives
  // in the SAME device record as the ActivityKit token. Added by ALTER for DBs
  // that predate the column (idempotent + cheap).
  const cols = sqlite
    .prepare(`PRAGMA table_info(mobile_live_activity_tokens)`)
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'remote_notification_token')) {
    sqlite.exec(`ALTER TABLE mobile_live_activity_tokens ADD COLUMN remote_notification_token TEXT`);
  }
  return sqlite;
}

export function upsertMobileLiveActivityToken(
  input: RegisterMobileLiveActivityTokenInput,
): StoredMobileLiveActivityToken {
  const sqlite = liveActivityDb();
  const now = new Date().toISOString();
  const environment = input.environment ?? configuredApnsEnvironment();
  const bundleId = input.bundleId?.trim() || configuredBundleId();

  sqlite.prepare(`
    INSERT INTO mobile_live_activity_tokens
      (push_token, activity_id, bundle_id, environment, device_label, last_signature, last_delivered_at, failure_count, remote_notification_token, created_at, updated_at)
    VALUES
      (@pushToken, @activityId, @bundleId, @environment, @deviceLabel, NULL, NULL, 0, @remoteNotificationToken, @now, @now)
    ON CONFLICT(push_token) DO UPDATE SET
      activity_id = COALESCE(excluded.activity_id, mobile_live_activity_tokens.activity_id),
      bundle_id = excluded.bundle_id,
      environment = excluded.environment,
      device_label = COALESCE(excluded.device_label, mobile_live_activity_tokens.device_label),
      remote_notification_token = COALESCE(excluded.remote_notification_token, mobile_live_activity_tokens.remote_notification_token),
      failure_count = 0,
      updated_at = excluded.updated_at
  `).run({
    pushToken: input.pushToken,
    activityId: input.activityId ?? null,
    bundleId,
    environment,
    deviceLabel: input.deviceLabel ?? null,
    remoteNotificationToken: input.remoteNotificationToken?.trim() || null,
    now,
  });

  const stored = getMobileLiveActivityToken(input.pushToken);
  if (!stored) throw new Error('Live Activity token was not stored.');
  return stored;
}

export function getMobileLiveActivityToken(pushToken: string): StoredMobileLiveActivityToken | null {
  const sqlite = liveActivityDb();
  const row = sqlite.prepare(`
    SELECT push_token, activity_id, bundle_id, environment, device_label,
           last_signature, last_delivered_at, failure_count
      FROM mobile_live_activity_tokens
     WHERE push_token = ?
  `).get(pushToken) as {
    push_token: string;
    activity_id: string | null;
    bundle_id: string;
    environment: 'sandbox' | 'production';
    device_label: string | null;
    last_signature: string | null;
    last_delivered_at: number | null;
    failure_count: number;
  } | undefined;

  return row
    ? {
        pushToken: row.push_token,
        activityId: row.activity_id,
        bundleId: row.bundle_id,
        environment: row.environment,
        deviceLabel: row.device_label,
        lastSignature: row.last_signature,
        lastDeliveredAt: row.last_delivered_at,
        failureCount: row.failure_count,
      }
    : null;
}

/** True when at least one phone registered a Live Activity to keep updated. */
export function hasMobileLiveActivityTokens(): boolean {
  return liveActivityDb().prepare('SELECT 1 FROM mobile_live_activity_tokens LIMIT 1').get() !== undefined;
}

export function listMobileLiveActivityTokens(): StoredMobileLiveActivityToken[] {
  const sqlite = liveActivityDb();
  const rows = sqlite.prepare(`
    SELECT push_token, activity_id, bundle_id, environment, device_label,
           last_signature, last_delivered_at, failure_count
      FROM mobile_live_activity_tokens
     ORDER BY updated_at DESC
  `).all() as Array<{
    push_token: string;
    activity_id: string | null;
    bundle_id: string;
    environment: 'sandbox' | 'production';
    device_label: string | null;
    last_signature: string | null;
    last_delivered_at: number | null;
    failure_count: number;
  }>;

  return rows.map((row) => ({
    pushToken: row.push_token,
    activityId: row.activity_id,
    bundleId: row.bundle_id,
    environment: row.environment,
    deviceLabel: row.device_label,
    lastSignature: row.last_signature,
    lastDeliveredAt: row.last_delivered_at,
    failureCount: row.failure_count,
  }));
}

/**
 * R3 (o8 Relay v1): the registered alert-capable remote-notification tokens, for
 * the relay connector's `push-req`. Returns only records that actually have one,
 * newest first (the connector notifies the most-recently-seen device).
 */
export function listRemoteNotificationTokens(): Array<{ token: string; environment: 'sandbox' | 'production' }> {
  const sqlite = liveActivityDb();
  const rows = sqlite.prepare(`
    SELECT remote_notification_token AS token, environment
      FROM mobile_live_activity_tokens
     WHERE remote_notification_token IS NOT NULL AND remote_notification_token != ''
     ORDER BY updated_at DESC
  `).all() as Array<{ token: string; environment: 'sandbox' | 'production' }>;
  return rows;
}

export function deleteMobileLiveActivityToken(pushToken: string): boolean {
  const sqlite = liveActivityDb();
  const result = sqlite.prepare(`
    DELETE FROM mobile_live_activity_tokens WHERE push_token = ?
  `).run(pushToken) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

function recordLiveActivityDeliverySuccess(pushToken: string, signature: string) {
  const sqlite = liveActivityDb();
  sqlite.prepare(`
    UPDATE mobile_live_activity_tokens
       SET last_signature = ?,
           last_delivered_at = ?,
           failure_count = 0,
           updated_at = ?
     WHERE push_token = ?
  `).run(signature, Date.now(), new Date().toISOString(), pushToken);
}

function recordLiveActivityDeliveryFailure(pushToken: string, options: { permanent?: boolean } = {}) {
  const sqlite = liveActivityDb();
  if (options.permanent) {
    deleteMobileLiveActivityToken(pushToken);
    return;
  }

  const token = getMobileLiveActivityToken(pushToken);
  if (!token) return;
  const nextCount = token.failureCount + 1;
  if (nextCount >= MAX_FAILURE_COUNT) {
    deleteMobileLiveActivityToken(pushToken);
    return;
  }

  sqlite.prepare(`
    UPDATE mobile_live_activity_tokens
       SET failure_count = ?,
           updated_at = ?
     WHERE push_token = ?
  `).run(nextCount, new Date().toISOString(), pushToken);
}

function repoLabel(workspace?: string | null) {
  return workspace ? basename(workspace) : undefined;
}

function coerceStatus(status: AgentStatus, approvalStatus?: string): MobileLiveActivityStatus {
  if (approvalStatus === 'pending' || status === 'reviewing') return 'awaiting_review';
  if (status === 'failed' || status === 'blocked') return 'failed';
  if (status === 'completed') return 'merged';
  if (status === 'running') return 'running';
  if (status === 'huddling') return 'queued';
  if (status === 'waiting') return 'queued';
  return 'idle';
}

function matchMicroAction(value: string) {
  const checks: Array<[string, RegExp]> = [
    ['Scroll', /\b(scroll|swipe|pan)\b/i],
    ['Click', /\b(click|tap|press|select|choose|open button)\b/i],
    ['Type', /\b(type|write|enter|input|compose|edit|send)\b/i],
    ['Navigate', /\b(navigate|browser|preview|url|open|load|visit|route)\b/i],
    ['Observe', /\b(observe|inspect|check|watch|look|read|review|analy[sz]e|verify|smoke)\b/i],
    ['Execute', /\b(run|build|test|lint|typecheck|terminal|shell|exec|command)\b/i],
  ];
  for (const [action, pattern] of checks) {
    if (pattern.test(value)) return action;
  }
  return null;
}

function elapsedLabel(lastActivityAt?: number | null, now = Date.now()) {
  if (!lastActivityAt) return null;
  const seconds = Math.floor(Math.max(0, now - lastActivityAt) / 1000);
  if (seconds < 45) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function countLabel(status: MobileLiveActivityStatus, count: number, total: number) {
  if (total === 0) return 'o8 idle';
  if (status === 'awaiting_review') return count === 1 ? '1 needs review' : `${count} need review`;
  if (status === 'failed') return count === 1 ? '1 failed' : `${count} failed`;
  if (status === 'running') return count === 1 ? '1 running' : `${count} running`;
  if (status === 'queued') return count === 1 ? '1 queued' : `${count} queued`;
  if (status === 'merged') return count === 1 ? '1 merged' : `${count} merged`;
  return count === 1 ? '1 idle' : `${count} idle`;
}

function queryString(params: Record<string, string | undefined>) {
  const pairs = Object.entries(params)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  return pairs.length ? `?${pairs.join('&')}` : '';
}

function liveActivitySignature(props: O8LiveActivityProps, event: 'update' | 'end') {
  return [
    event,
    props.status,
    props.title,
    props.detail,
    props.repo ?? '',
    props.active,
    props.approvals,
    props.failures,
    props.queued,
    props.actionLabel,
    props.deepLink,
    props.microAction ?? '',
    props.elapsedLabel ?? '',
    props.mode ?? '',
    props.backgroundCapable ? 'background' : '',
  ].join('|');
}

export function liveActivityPropsFromMobileInbox(snapshot: MobileInboxSnapshot): O8LiveActivityProps {
  const items = snapshot.sessions.map((session) => {
    const status = coerceStatus(session.status, session.approvalStatus);
    const previewUrl = session.browserSurface?.url
      ?? session.runtimeSurface?.browserSurface?.url
      ?? undefined;
    const terminalSessionName = session.tmuxSession ?? undefined;
    const microText = [
      session.currentTask,
      session.name,
      session.branch,
      previewUrl,
      terminalSessionName,
      session.browserSurface?.lastAction,
      session.runtimeSurface?.browserSurface?.lastAction,
    ].filter(Boolean).join(' ');
    const microAction = status === 'awaiting_review'
      ? 'Review'
      : status === 'failed'
        ? 'Inspect'
        : status === 'queued'
          ? 'Queue'
          : status === 'merged'
            ? 'Merged'
            : matchMicroAction(microText) ?? (terminalSessionName ? 'Execute' : 'Observe');
    const mode: MobileLiveActivityMode = status === 'awaiting_review'
      ? 'review'
      : status === 'merged'
        ? 'activity'
        : previewUrl || BROWSER_MICRO_ACTIONS.has(microAction)
          ? 'browser'
          : terminalSessionName || microAction === 'Execute'
            ? 'terminal'
            : status === 'running'
              ? 'fleet'
              : 'unknown';
    return {
      id: session.id,
      status,
      title: session.currentTask?.trim() || session.name,
      detail: session.currentTask?.trim() || [repoLabel(session.workspace), session.branch].filter(Boolean).join(' · ') || session.name,
      repo: repoLabel(session.workspace),
      workspacePath: session.workspace,
      branch: session.branch,
      previewUrl,
      terminalSessionName,
      lastActivityAt: session.lastActivityAt,
      microAction,
      mode,
      backgroundCapable: mode === 'browser' || Boolean(previewUrl) || BROWSER_MICRO_ACTIONS.has(microAction),
    };
  });

  const counts = {
    queued: 0,
    running: 0,
    awaiting_review: 0,
    merged: 0,
    failed: 0,
    idle: 0,
  } satisfies Record<MobileLiveActivityStatus, number>;
  for (const item of items) counts[item.status] += 1;
  const primaryStatus = STATUS_ORDER.find((status) => counts[status] > 0) ?? 'idle';
  const primaryItem = items.find((item) => item.status === primaryStatus);
  const total = items.length;
  const statusLabel = countLabel(primaryStatus, counts[primaryStatus], total);
  const goal = primaryItem?.title || statusLabel;
  const sourceLabel = snapshot.sourceLabel || 'mobile inbox';
  const active = counts.running + counts.awaiting_review + counts.queued;
  const deepLink = primaryStatus === 'awaiting_review'
    ? 'chat:///approvals'
    : primaryStatus === 'merged'
      ? 'chat:///activity'
      : primaryItem?.previewUrl
        ? `chat:///preview${queryString({
            url: primaryItem.previewUrl,
            title: primaryItem.repo ? `${primaryItem.repo} preview` : primaryItem.title,
            repoPath: primaryItem.workspacePath,
          })}`
        : primaryItem?.terminalSessionName
          ? `chat:///terminal${queryString({
              sessionName: primaryItem.terminalSessionName,
              title: primaryItem.title,
              repoPath: primaryItem.workspacePath,
            })}`
          : 'chat:///fleet';

  return {
    status: primaryStatus,
    title: goal,
    detail: primaryItem?.detail || snapshot.note || 'No foreground agent work.',
    repo: primaryItem?.repo,
    sourceLabel,
    active,
    approvals: snapshot.summary.approvals || counts.awaiting_review,
    failures: counts.failed,
    queued: counts.queued,
    updatedAt: Date.parse(snapshot.generatedAt) || Date.now(),
    actionLabel: primaryStatus === 'awaiting_review'
      ? 'Review'
      : primaryStatus === 'failed'
        ? 'Inspect'
        : primaryStatus === 'merged'
          ? 'Activity'
          : primaryStatus === 'queued'
            ? 'Queue'
            : primaryItem?.mode === 'terminal'
              ? 'Attach'
              : primaryItem?.microAction ?? 'Open fleet',
    deepLink,
    microAction: primaryItem?.microAction ?? 'Idle',
    elapsedLabel: elapsedLabel(primaryItem?.lastActivityAt),
    goal,
    mode: primaryItem?.mode ?? 'fleet',
    backgroundCapable: Boolean(primaryItem?.backgroundCapable),
  };
}

function shouldRunLiveActivity(props: O8LiveActivityProps) {
  return props.status !== 'idle' && (
    props.active > 0 ||
    props.approvals > 0 ||
    props.failures > 0 ||
    props.queued > 0
  );
}

async function sendActivityKitPayload(
  token: StoredMobileLiveActivityToken,
  props: O8LiveActivityProps,
  event: 'update' | 'end',
): Promise<ActivityKitSendResult> {
  const signature = liveActivitySignature(props, event);
  if (token.lastSignature === signature) {
    return { token: token.pushToken, ok: true, status: 0, action: 'skipped', reason: 'unchanged' };
  }

  const auth = await getApnsJwt();
  if (!auth.ok) {
    return { token: token.pushToken, ok: false, status: 0, action: 'skipped', reason: auth.reason };
  }

  const host = token.environment === 'production'
    ? 'api.push.apple.com'
    : 'api.sandbox.push.apple.com';
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = {
    aps: {
      timestamp,
      event,
      'content-state': {
        name: O8_LIVE_ACTIVITY_NAME,
        props: JSON.stringify({ ...props, updatedAt: Date.now() }),
      },
      'stale-date': timestamp + 120,
    },
  };

  try {
    const response = await sendApnsHttp2Request({
      host,
      deviceToken: token.pushToken,
      authorization: `bearer ${auth.token}`,
      topic: `${token.bundleId}.push-type.liveactivity`,
      payload,
    });

    if (response.status >= 200 && response.status < 300) {
      recordLiveActivityDeliverySuccess(token.pushToken, signature);
      if (event === 'end') deleteMobileLiveActivityToken(token.pushToken);
      return {
        token: token.pushToken,
        ok: true,
        status: response.status,
        action: event === 'end' ? 'ended' : 'updated',
      };
    }

    const permanent = response.status === 400 || response.status === 410;
    recordLiveActivityDeliveryFailure(token.pushToken, { permanent });
    return {
      token: token.pushToken,
      ok: false,
      status: response.status,
      action: 'failed',
      reason: response.body?.reason ?? `APNs HTTP ${response.status}`,
    };
  } catch (error) {
    recordLiveActivityDeliveryFailure(token.pushToken);
    return {
      token: token.pushToken,
      ok: false,
      status: 0,
      action: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function syncMobileLiveActivities(
  snapshot: MobileInboxSnapshot,
): Promise<ActivityKitSyncResult> {
  const tokens = listMobileLiveActivityTokens();
  if (tokens.length === 0) {
    return { ok: true, pushed: 0, skipped: 0, failed: 0, results: [] };
  }

  const props = liveActivityPropsFromMobileInbox(snapshot);
  const event = shouldRunLiveActivity(props) ? 'update' : 'end';
  const results = await Promise.all(tokens.map((token) => sendActivityKitPayload(token, props, event)));
  const pushed = results.filter((result) => result.ok && result.action !== 'skipped').length;
  const skipped = results.filter((result) => result.action === 'skipped').length;
  const failed = results.filter((result) => !result.ok && result.action !== 'skipped').length;
  return {
    ok: failed === 0,
    pushed,
    skipped,
    failed,
    reason: results.find((result) => result.reason)?.reason,
    results,
  };
}
