export type OutsiderAttentionThreadKind = 'issue' | 'pr';

export interface OutsiderAttentionThread {
  repo: string;
  kind: OutsiderAttentionThreadKind;
  number: number;
  url: string;
  title: string;
  state: string;
  closedAt: string | null;
  lastHumanCommentAuthorLogin: string | null;
  lastHumanCommentAuthorAssociation: string | null;
  lastHumanCommentAt: string | null;
  lastInsiderCommentAt: string | null;
}

export interface WaitingOutsider {
  repo: string;
  kind: OutsiderAttentionThreadKind;
  number: number;
  url: string;
  title: string;
  waitingLogin: string;
  waitingSince: string;
  hours: number;
}

export const OUTSIDER_ATTENTION_RECENTLY_CLOSED_MS = 7 * 24 * 60 * 60_000;

const INSIDER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function isGitHubBotLogin(login: string | null | undefined): boolean {
  return typeof login === 'string' && login.trim().toLowerCase().endsWith('[bot]');
}

export function isGitHubInsiderAssociation(association: string | null | undefined): boolean {
  return INSIDER_ASSOCIATIONS.has(association?.trim().toUpperCase() ?? '');
}

function validTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** The outside commenter a thread is waiting on, before any time threshold. */
function outsiderWait(thread: OutsiderAttentionThread): { waitingLogin: string; waitingSinceMs: number } | null {
  const waitingLogin = thread.lastHumanCommentAuthorLogin?.trim() ?? '';
  const waitingSinceMs = validTimestamp(thread.lastHumanCommentAt);
  if (!waitingLogin || waitingSinceMs === null || isGitHubBotLogin(waitingLogin)) return null;
  if (isGitHubInsiderAssociation(thread.lastHumanCommentAuthorAssociation)) return null;

  // Closed threads remain in the mirror briefly for history, but they cannot
  // start a new human-waiting incident after the source thread has closed.
  if (thread.state.toLowerCase() !== 'open') return null;

  const lastInsiderCommentMs = validTimestamp(thread.lastInsiderCommentAt);
  if (lastInsiderCommentMs !== null && lastInsiderCommentMs > waitingSinceMs) return null;
  return { waitingLogin, waitingSinceMs };
}

/**
 * The next moment `findWaitingOutsiders` gives a different answer with the
 * same threads: a thread crosses the threshold, or a waiting thread's whole
 * hours tick over. Infinity when no thread can change on its own.
 */
export function nextOutsiderWaitChangeAt(threads: OutsiderAttentionThread[], now: Date, thresholdMs: number): number {
  const nowMs = now.getTime();
  const boundedThresholdMs = Math.max(0, thresholdMs);
  let next = Infinity;
  for (const thread of threads) {
    const wait = outsiderWait(thread);
    if (!wait) continue;
    const waitingMs = nowMs - wait.waitingSinceMs;
    const at = waitingMs < boundedThresholdMs
      ? wait.waitingSinceMs + boundedThresholdMs
      : wait.waitingSinceMs + (Math.floor(waitingMs / (60 * 60_000)) + 1) * 60 * 60_000;
    next = Math.min(next, at);
  }
  return next;
}

export function findWaitingOutsiders(
  threads: OutsiderAttentionThread[],
  now: Date,
  thresholdMs: number,
): WaitingOutsider[] {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return [];
  const boundedThresholdMs = Math.max(0, thresholdMs);

  return threads.flatMap((thread) => {
    const wait = outsiderWait(thread);
    if (!wait) return [];
    const { waitingLogin, waitingSinceMs } = wait;

    const waitingMs = nowMs - waitingSinceMs;
    if (waitingMs < boundedThresholdMs) return [];

    return [{
      repo: thread.repo,
      kind: thread.kind,
      number: thread.number,
      url: thread.url,
      title: thread.title,
      waitingLogin,
      waitingSince: thread.lastHumanCommentAt!,
      hours: Math.floor(waitingMs / (60 * 60_000)),
    }];
  });
}
