import { randomUUID } from 'node:crypto';
import { execFile } from '@/lib/providers/child-process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { getSqlite } from '@/lib/db';
import { markRepoOriginConfigured } from '@/lib/repos/origin-readiness';
import { DEFAULT_PROJECT_ID } from '@/lib/repos/projects';
import { runAwaitingReviewAutoReleaseSweep } from '@/lib/supervisor/heal-bot-auto-release';
import { runGitHubBrokerSyncSweep } from '@/lib/supervisor/github-broker-sync';
import { enqueueInboxItem, runRetentionSweep, selfHealActiveByKindAndRepo } from '@/lib/supervisor/inbox';
export { runAwaitingReviewAutoReleaseSweep } from '@/lib/supervisor/heal-bot-auto-release';
const execFileAsync = promisify(execFile);

const HEAL_BOT_TICK_MS = 60_000;
const HEAL_BOT_TIMEOUT_MS = 5 * 60_000;
const FETCH_UNREACHABLE_MIN_AGE_MS = 60_000;
const FETCH_UNREACHABLE_RETRY_MS = 5 * 60_000;
const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;
const OUTPUT_SNIPPET_LIMIT = 4_000;
const HEAL_BOT_SYSTEM_PROMPT = 'You are a heal-bot. The packet failed verification with the attached error. You have 5 minutes. Either: (a) make the minimal fix, commit it, run `npx tsc --noEmit`, and exit successfully, OR (b) write `GIVE_UP: <one-line reason>` to stdout and exit. Do not invent scope — only fix the specific failure.';
const FIXABLE_KINDS = new Set<SupervisorInboxKind>(['verification_failed', 'bounded_retry_exhausted']);

export type SupervisorInboxKind =
  | 'verification_failed'
  | 'session_lost'
  | 'packet_missing'
  | 'bounded_retry_exhausted'
  | 'merge_blocked'
  | 'fetch_unreachable'
  | 'repo_misconfigured'
  // #613 — silent-exit detector kinds. Lane's underlying session died
  // between work-completion and the completion-reported event, so we had to
  // salvage by hand.
  | 'silent_exit_verification_failed'
  | 'silent_exit_no_work'
  | 'silent_exit_but_work_present';

export type SupervisorInboxStatus =
  | 'pending'
  | 'healing'
  | 'self_healed'
  | 'escalated'
  | 'resolved'
  | 'human_required'
  | 'dismissed';

export interface SupervisorInboxPayload {
  laneId?: string | null;
  worktreePath?: string | null;
  sessionKey?: string | null;
  surfaceId?: string | null;
  baseBranch?: string | null;
  packetTitle?: string | null;
  packetReferenceLabel?: string | null;
  verificationKind?: string | null;
  attempts?: string | null;
  error?: string | null;
  diffStat?: string | null;
  lastCommit?: string | null;
  transcriptTail?: string | null;
  note?: string | null;
  question?: string | null;
  retryError?: string | null;
  healBot?: {
    attemptedAt?: string;
    completedAt?: string;
    outcome?: 'success' | 'give_up' | 'failed';
    giveUpReason?: string;
    commitSha?: string;
    commitSubject?: string;
    stdoutSnippet?: string;
    stderrSnippet?: string;
    typecheckOutput?: string;
  };
}

interface SupervisorInboxItem {
  id: string;
  repo_path: string;
  packet_id: string | null;
  kind: SupervisorInboxKind;
  payload: string;
  status: SupervisorInboxStatus;
  heal_attempt_count: number;
  created_at: string;
  resolved_at: string | null;
  resolution_lane_id: string | null;
}

export interface EnqueueSupervisorInboxItemInput {
  repoPath: string;
  packetId?: string | null;
  kind: SupervisorInboxKind;
  payload: SupervisorInboxPayload;
  status?: SupervisorInboxStatus;
}

let healBotTimer: ReturnType<typeof setInterval> | null = null;
let drainInFlight = false;
const fetchTestLastByRepo = new Map<string, number>();

function getDb() {
  const sqlite = getSqlite();
  ensureSupervisorInboxSchema(sqlite);
  return sqlite;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parsePayload(payload: string): SupervisorInboxPayload {
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as SupervisorInboxPayload;
    }
  } catch {
    // Ignore malformed payloads; they should not break healing.
  }
  return {};
}

function serializePayload(payload: SupervisorInboxPayload): string {
  return JSON.stringify(payload);
}

function truncate(value: string | undefined, limit = OUTPUT_SNIPPET_LIMIT): string {
  const normalized = (value ?? '').trim();
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}\n\n... (truncated)`;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function quoteBlock(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? '').trim();
  return normalized ? normalized : fallback;
}

function ensureColumn(
  sqlite: Database.Database,
  tableName: string,
  columnName: string,
  statement: string,
): void {
  const columns = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }
  sqlite.exec(statement);
}

function ensureSupervisorInboxSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS supervisor_inbox (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      incident_key TEXT,
      repo_path TEXT NOT NULL,
      packet_id TEXT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      heal_attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT,
      repeat_count INTEGER NOT NULL DEFAULT 1,
      resolved_at TEXT,
      resolution_lane_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_status_created
      ON supervisor_inbox(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_packet_id
      ON supervisor_inbox(packet_id);
    CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_repo_created
      ON supervisor_inbox(repo_path, created_at);
  `);

  ensureColumn(
    sqlite,
    'supervisor_inbox',
    'project_id',
    `ALTER TABLE supervisor_inbox ADD COLUMN project_id TEXT`,
  );
  sqlite.prepare(
    "UPDATE supervisor_inbox SET project_id = ? WHERE project_id IS NULL OR project_id = ''",
  ).run(DEFAULT_PROJECT_ID);
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_project_status_created ON supervisor_inbox(project_id, status, created_at)');
  ensureColumn(
    sqlite,
    'supervisor_inbox',
    'incident_key',
    `ALTER TABLE supervisor_inbox ADD COLUMN incident_key TEXT`,
  );
  ensureColumn(
    sqlite,
    'supervisor_inbox',
    'heal_attempt_count',
    `ALTER TABLE supervisor_inbox ADD COLUMN heal_attempt_count INTEGER NOT NULL DEFAULT 0`,
  );
  ensureColumn(
    sqlite,
    'supervisor_inbox',
    'last_seen_at',
    `ALTER TABLE supervisor_inbox ADD COLUMN last_seen_at TEXT`,
  );
  ensureColumn(
    sqlite,
    'supervisor_inbox',
    'repeat_count',
    `ALTER TABLE supervisor_inbox ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 1`,
  );
  ensureColumn(
    sqlite,
    'supervisor_inbox',
    'resolution_lane_id',
    `ALTER TABLE supervisor_inbox ADD COLUMN resolution_lane_id TEXT`,
  );
  sqlite.prepare(
    "UPDATE supervisor_inbox SET last_seen_at = created_at WHERE last_seen_at IS NULL OR last_seen_at = ''",
  ).run();
  sqlite.prepare(
    'UPDATE supervisor_inbox SET repeat_count = 1 WHERE repeat_count IS NULL OR repeat_count < 1',
  ).run();
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_supervisor_inbox_incident_status ON supervisor_inbox(incident_key, status)');
}

function parseGiveUpReason(stdout: string, stderr: string): string | null {
  const combined = `${stdout}\n${stderr}`;
  const match = combined.match(/GIVE_UP:\s*(.+)/i);
  return match?.[1]?.trim() || null;
}

async function readHeadSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { windowsHide: true,
      cwd,
      timeout: 15_000,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    const head = stdout.trim();
    return head || null;
  } catch {
    return null;
  }
}

async function readHeadSummary(cwd: string): Promise<{ sha: string | null; subject: string | null }> {
  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%H%n%s'], { windowsHide: true,
      cwd,
      timeout: 15_000,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    const [sha, ...subjectParts] = stdout.trim().split('\n');
    return {
      sha: sha?.trim() || null,
      subject: subjectParts.join(' ').trim() || null,
    };
  } catch {
    return { sha: null, subject: null };
  }
}

async function readGitStatus(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { windowsHide: true,
      cwd,
      timeout: 15_000,
      maxBuffer: COMMAND_MAX_BUFFER,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

function buildHealPrompt(
  item: SupervisorInboxItem,
  payload: SupervisorInboxPayload,
): string {
  return [
    'Heal the specific verification failure below. Do not widen scope.',
    '',
    `Inbox item: ${item.id}`,
    `Kind: ${item.kind}`,
    `Repo: ${item.repo_path}`,
    `Worktree: ${payload.worktreePath ?? item.repo_path}`,
    `Packet: ${payload.packetReferenceLabel ?? item.packet_id ?? 'unknown'}`,
    `Packet title: ${payload.packetTitle ?? 'unknown'}`,
    `Lane: ${payload.laneId ?? 'unknown'}`,
    `Session: ${payload.sessionKey ?? payload.surfaceId ?? 'unknown'}`,
    payload.attempts ? `Attempts: ${payload.attempts}` : '',
    payload.retryError ? `Retry handoff failure: ${payload.retryError}` : '',
    payload.note ? `Note: ${payload.note}` : '',
    '',
    'Verification error:',
    '```',
    quoteBlock(payload.error, 'Unavailable.'),
    '```',
    '',
    'Last commit:',
    '```',
    quoteBlock(payload.lastCommit, 'Unavailable.'),
    '```',
    '',
    'Diff stat:',
    '```',
    quoteBlock(payload.diffStat, 'Unavailable.'),
    '```',
    '',
    'Transcript tail:',
    '```',
    quoteBlock(payload.transcriptTail, 'Unavailable.'),
    '```',
  ].filter(Boolean).join('\n');
}

/**
 * Spawn Codex GPT-5.5 high to attempt the heal. Replaces the previous
 * `claude -p --print` path (epic #1044, follow-up #1048). The shape of the
 * return value is preserved so the caller (`healInboxItem`) keeps working
 * unchanged — the orchestrator-side verdict still gets detected via HEAD
 * diff + `parseGiveUpReason(stdout)` + typecheck.
 *
 * Codex doesn't expose `--append-system-prompt`, so we prepend the system
 * prompt to the user prompt. The 5-minute heal budget is enforced via an
 * AbortController fed into `sendToCodexOrchestrator`'s built-in abort path.
 * Each call gets a fresh threadId — heal attempts must NOT resume across
 * each other.
 */
async function runHealBotCodex(cwd: string, prompt: string) {
  const { ensureCodexOrchestratorSession, sendToCodexOrchestrator } = await import('@/lib/lane/codex-orchestrator-session');
  const session = ensureCodexOrchestratorSession(cwd);
  // Each heal attempt starts a fresh codex thread — no resume. The session
  // cache keys by cwd hash, so we explicitly null the threadId to defeat
  // accidental resumption across consecutive attempts on the same worktree.
  session.threadId = null;

  const fullPrompt = `${HEAL_BOT_SYSTEM_PROMPT}\n\n${prompt}`;
  let stdout = '';
  let stderr = '';
  let errorMessage: string | null = null;

  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort(), HEAL_BOT_TIMEOUT_MS);
  let aborted = false;
  abortController.signal.addEventListener('abort', () => {
    aborted = true;
  });

  try {
    await sendToCodexOrchestrator(
      session,
      fullPrompt,
      (event) => {
        if (event.type === 'text') {
          stdout += event.text;
        } else if (event.type === 'tool_result' && event.output) {
          // Codex shell calls during the heal — appended to stdout so the
          // GIVE_UP detector + future debug forensics see what actually ran.
          stdout += `\n${event.output}\n`;
        } else if (event.type === 'error') {
          errorMessage = event.error;
          stderr += event.error;
        }
      },
      {
        permissionMode: 'full',
        thinkingEffort: 'high',
        signal: abortController.signal,
      },
    );
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(abortTimer);
  }

  const timedOut = aborted;
  const ok = !errorMessage && !timedOut;
  return {
    ok,
    stdout: stdout.trim().slice(0, COMMAND_MAX_BUFFER),
    stderr: stderr.trim(),
    timedOut,
    exitReason: timedOut
      ? `heal-bot timed out after ${Math.floor(HEAL_BOT_TIMEOUT_MS / 60_000)} minutes`
      : (errorMessage ?? (ok ? null : 'codex exited unsuccessfully')),
  };
}

function updateInboxItem(
  itemId: string,
  status: SupervisorInboxStatus,
  payload: SupervisorInboxPayload,
  resolvedAt: string | null,
): void {
  getDb().prepare(`
    UPDATE supervisor_inbox
       SET status = ?,
           payload = ?,
           resolved_at = ?
     WHERE id = ?
  `).run(status, serializePayload(payload), resolvedAt, itemId);
}

function appendLaneHealEvent(
  laneId: string,
  payload: Record<string, unknown>,
): void {
  getDb().prepare(`
    INSERT INTO lane_events (id, lane_id, verb, actor, payload_json, timestamp)
    VALUES (?, ?, 'heal_bot', 'system', ?, ?)
  `).run(
    `evt-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
    laneId,
    JSON.stringify(payload),
    nowIso(),
  );
}

async function resolveLane(item: SupervisorInboxItem, payload: SupervisorInboxPayload) {
  const { getLane, findLaneByPacket } = await import('@/lib/lane/registry');
  if (payload.laneId) {
    const byId = getLane(payload.laneId);
    if (byId) return byId;
  }
  if (item.packet_id) {
    return findLaneByPacket(item.packet_id);
  }
  return null;
}

async function markHumanRequired(
  item: SupervisorInboxItem,
  payload: SupervisorInboxPayload,
  reason: string,
  extras?: Partial<NonNullable<SupervisorInboxPayload['healBot']>>,
): Promise<void> {
  const completedAt = nowIso();
  const lane = await resolveLane(item, payload);
  const question = `How should o8 proceed with "${lane?.label || lane?.branch || lane?.id || item.packet_id || 'this lane'}" after automatic healing stopped: ${reason}?`;
  const nextPayload: SupervisorInboxPayload = {
    ...payload,
    question,
    healBot: {
      ...payload.healBot,
      ...extras,
      completedAt,
      outcome: extras?.outcome ?? 'give_up',
      giveUpReason: reason,
    },
  };

  updateInboxItem(item.id, 'human_required', nextPayload, completedAt);

  if (!lane) return;
  appendLaneHealEvent(lane.id, {
    outcome: nextPayload.healBot?.outcome ?? 'give_up',
    reason,
    question,
    inboxItemId: item.id,
    packetId: item.packet_id,
  });

  const { setLaneStatus } = await import('@/lib/lane/registry');
  // Layer 5 parks on the operator with the specific question persisted above.
  setLaneStatus(lane.id, 'awaiting_human', 'system', 'heal_bot_give_up');
}

async function markSelfHealed(
  item: SupervisorInboxItem,
  payload: SupervisorInboxPayload,
  healBot: NonNullable<SupervisorInboxPayload['healBot']>,
): Promise<void> {
  const completedAt = nowIso();
  const nextPayload: SupervisorInboxPayload = {
    ...payload,
    healBot: {
      ...payload.healBot,
      ...healBot,
      completedAt,
      outcome: 'success',
    },
  };

  updateInboxItem(item.id, 'self_healed', nextPayload, completedAt);

  const lane = await resolveLane(item, payload);
  if (!lane) return;

  appendLaneHealEvent(lane.id, {
    outcome: 'success',
    commitSha: healBot.commitSha,
    commitSubject: healBot.commitSubject,
    inboxItemId: item.id,
    packetId: item.packet_id,
  });

  const { getLane, setLaneStatus } = await import('@/lib/lane/registry');
  setLaneStatus(lane.id, 'reviewing', 'system', 'heal_bot_fixed');
  const refreshedLane = getLane(lane.id);
  if (!refreshedLane) return;

  const { triggerAutoReview } = await import('@/lib/lane/auto-review');
  triggerAutoReview(refreshedLane);
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

async function healInboxItem(item: SupervisorInboxItem): Promise<void> {
  const payload = parsePayload(item.payload);
  const attemptedAt = nowIso();
  payload.healBot = {
    ...payload.healBot,
    attemptedAt,
  };

  // A reaped worktree (worktreePath null/empty, or the directory already cleaned
  // up) has nothing to heal. The old fallback to item.repo_path ran heal-bot
  // against the MAIN checkout, spawning zombie review sessions that never
  // converged (#1256). Treat a missing worktree as terminal instead of looping.
  const worktreePath = payload.worktreePath?.trim();
  if (!worktreePath || !(await directoryExists(worktreePath))) {
    await markHumanRequired(item, payload, 'no recoverable worktree (reaped) — cannot heal');
    return;
  }
  const cwd = worktreePath;

  if (!FIXABLE_KINDS.has(item.kind)) {
    await markHumanRequired(item, payload, `${item.kind} requires manual triage`);
    return;
  }

  const beforeHead = await readHeadSha(cwd);
  const prompt = buildHealPrompt(item, payload);
  const healRun = await runHealBotCodex(cwd, prompt);
  const stdoutSnippet = truncate(healRun.stdout);
  const stderrSnippet = truncate(healRun.stderr);
  const giveUpReason = parseGiveUpReason(healRun.stdout, healRun.stderr);

  if (giveUpReason) {
    await markHumanRequired(item, payload, giveUpReason, {
      outcome: 'give_up',
      stdoutSnippet,
      stderrSnippet,
    });
    return;
  }

  if (!healRun.ok) {
    await markHumanRequired(item, payload, healRun.exitReason ?? 'heal-bot exited unsuccessfully', {
      outcome: 'failed',
      stdoutSnippet,
      stderrSnippet,
    });
    return;
  }

  const afterHead = await readHeadSha(cwd);
  if (!beforeHead || !afterHead || beforeHead === afterHead) {
    await markHumanRequired(item, payload, 'heal-bot exited without creating a new commit', {
      outcome: 'failed',
      stdoutSnippet,
      stderrSnippet,
    });
    return;
  }

  const dirtyStatus = await readGitStatus(cwd);
  if (dirtyStatus) {
    await markHumanRequired(item, payload, 'heal-bot left uncommitted changes in the worktree', {
      outcome: 'failed',
      stdoutSnippet,
      stderrSnippet,
    });
    return;
  }

  const { runCompletionTypecheck } = await import('@/lib/supervisor/completion-verification');
  const typecheck = await runCompletionTypecheck(cwd);
  if (!typecheck.ok) {
    await markHumanRequired(item, payload, 'heal-bot commit did not pass `npx tsc --noEmit`', {
      outcome: 'failed',
      stdoutSnippet,
      stderrSnippet,
      typecheckOutput: truncate(typecheck.output),
    });
    return;
  }

  const headSummary = await readHeadSummary(cwd);
  await markSelfHealed(item, payload, {
    attemptedAt,
    stdoutSnippet,
    stderrSnippet,
    typecheckOutput: truncate(typecheck.output),
    commitSha: headSummary.sha ?? afterHead,
    commitSubject: headSummary.subject ?? undefined,
  });
}

function claimPendingItems(): SupervisorInboxItem[] {
  const db = getDb();
  const pending = db.prepare(`
    SELECT id, repo_path, packet_id, kind, payload, status, heal_attempt_count, created_at, resolved_at
      FROM supervisor_inbox
     WHERE status = 'pending'
       AND kind IN ('verification_failed', 'bounded_retry_exhausted')
       AND COALESCE(heal_attempt_count, 0) < 1
     ORDER BY created_at ASC
  `).all() as SupervisorInboxItem[];

  const claimStatement = db.prepare(`
    UPDATE supervisor_inbox
       SET status = 'healing',
           heal_attempt_count = COALESCE(heal_attempt_count, 0) + 1
     WHERE id = ?
       AND status = 'pending'
       AND kind IN ('verification_failed', 'bounded_retry_exhausted')
       AND COALESCE(heal_attempt_count, 0) < 1
  `);

  const claimed: SupervisorInboxItem[] = [];
  for (const item of pending) {
    const result = claimStatement.run(item.id);
    if (result.changes > 0) {
      claimed.push({ ...item, status: 'healing', heal_attempt_count: item.heal_attempt_count + 1 });
    }
  }
  return claimed;
}

function recoverInterruptedHealingItems(): void {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, repo_path, packet_id, kind, payload, status, heal_attempt_count, created_at, resolved_at
      FROM supervisor_inbox
     WHERE status = 'healing'
  `).all() as SupervisorInboxItem[];

  for (const row of rows) {
    const payload = parsePayload(row.payload);
    const reason = 'heal-bot process restarted while the attempt was in flight';
    updateInboxItem(row.id, 'human_required', {
      ...payload,
      healBot: {
        ...payload.healBot,
        completedAt: nowIso(),
        outcome: 'failed',
        giveUpReason: reason,
      },
    }, nowIso());
  }

  db.prepare(`
    UPDATE supervisor_inbox
       SET status = 'human_required',
           resolved_at = COALESCE(resolved_at, datetime('now'))
     WHERE status = 'pending'
       AND COALESCE(heal_attempt_count, 0) >= 1
  `).run();
}

function listFetchUnreachableItems(): SupervisorInboxItem[] {
  return getDb().prepare(`
    SELECT id, repo_path, packet_id, kind, payload, status, heal_attempt_count, created_at, resolved_at
      FROM supervisor_inbox
     WHERE kind = 'fetch_unreachable'
       AND status IN ('pending', 'human_required')
     ORDER BY created_at ASC
  `).all() as SupervisorInboxItem[];
}

async function runFetchUnreachableSweep(): Promise<void> {
  const now = Date.now();
  const attemptedRepos = new Set<string>();
  for (const item of listFetchUnreachableItems()) {
    if (attemptedRepos.has(item.repo_path)) continue;
    if (now - timestampMs(item.created_at) < FETCH_UNREACHABLE_MIN_AGE_MS) continue;
    const lastAttemptMs = fetchTestLastByRepo.get(item.repo_path) ?? 0;
    if (now - lastAttemptMs < FETCH_UNREACHABLE_RETRY_MS) continue;

    const payload = parsePayload(item.payload);
    const baseBranch = payload.baseBranch?.trim() || 'main';
    attemptedRepos.add(item.repo_path);
    fetchTestLastByRepo.set(item.repo_path, now);

    try {
      await execFileAsync('git', ['fetch', 'origin', baseBranch, '--quiet'], { windowsHide: true,
        cwd: item.repo_path,
        timeout: 60_000,
        maxBuffer: COMMAND_MAX_BUFFER,
      });
      markRepoOriginConfigured(item.repo_path);
      const healed = selfHealActiveByKindAndRepo('fetch_unreachable', item.repo_path);
      if (healed > 0) {
        console.log(`[heal-bot] Self-healed ${healed} fetch_unreachable item(s) for ${item.repo_path} after fetch origin ${baseBranch}`);
      }
    } catch (error) {
      console.warn(`[heal-bot] Fetch test still failing for ${item.repo_path}: ${error instanceof Error ? error.message : error}`);
    }
  }
}
async function runHealBotMaintenance(): Promise<void> {
  const { runLivenessProbeSweep } = await import('@/lib/supervisor/liveness-probes');
  const dismissed = runRetentionSweep();
  if (dismissed > 0) {
    console.log(`[heal-bot] Retention sweep dismissed ${dismissed} stale inbox item(s)`);
  }
  await import('@/lib/problems/service').then(({ reconcileProblemDossiers }) => reconcileProblemDossiers()).catch((error) => console.warn('[heal-bot] Problem dossier reconciliation failed:', error));
  await runGitHubBrokerSyncSweep();
  await runFetchUnreachableSweep();
  await runAwaitingReviewAutoReleaseSweep();
  const resolved = await runLivenessProbeSweep();
  if (resolved.resolved > 0) {
    console.log(`[heal-bot] Liveness sweep resolved ${resolved.resolved} stale inbox item(s)`);
  }
}

async function drainHealBotQueue(): Promise<void> {
  if (drainInFlight) return;
  drainInFlight = true;

  try {
    await runHealBotMaintenance();
    const claimed = claimPendingItems();
    for (const item of claimed) {
      try {
        await healInboxItem(item);
      } catch (error) {
        const payload = parsePayload(item.payload);
        await markHumanRequired(
          item,
          payload,
          error instanceof Error ? error.message : String(error),
          { outcome: 'failed' },
        );
      }
    }
  } finally {
    drainInFlight = false;
  }
}

/** True while the heal-bot loop runs; its maintenance reconciles problem dossiers. */
export function healBotLoopRunning(): boolean {
  return healBotTimer !== null;
}

export async function runHealBotTickOnce(): Promise<void> {
  await drainHealBotQueue();
}

export function enqueueSupervisorInboxItem(input: EnqueueSupervisorInboxItemInput): string {
  getDb();
  const item = enqueueInboxItem({
    repoPath: input.repoPath,
    packetId: input.packetId ?? null,
    kind: input.kind,
    payload: input.payload as Record<string, unknown>,
    status: input.status,
  });
  return item.id;
}

export function startHealBot(): () => void {
  getDb();
  recoverInterruptedHealingItems();

  if (healBotTimer) {
    return () => {
      if (healBotTimer) {
        clearInterval(healBotTimer);
        healBotTimer = null;
      }
    };
  }

  healBotTimer = setInterval(() => {
    void drainHealBotQueue().catch((error) => {
      console.error('[heal-bot] Drain failed:', error);
    });
  }, HEAL_BOT_TICK_MS);
  if (healBotTimer.unref) healBotTimer.unref();

  console.log(`[heal-bot] Started inbox drain (${HEAL_BOT_TICK_MS}ms interval)`);
  void drainHealBotQueue().catch((error) => {
    console.error('[heal-bot] Initial drain failed:', error);
  });

  return () => {
    if (!healBotTimer) return;
    clearInterval(healBotTimer);
    healBotTimer = null;
    console.log('[heal-bot] Stopped inbox drain');
  };
}
