import 'server-only';

import { createHash } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { GitHubManagedUnavailableError, githubInstallationFetch } from './auth';
import { GitHubRequestDeferredError } from './request-budget';

type StackStatus = 'ready' | 'none' | 'unauthorized' | 'unsupported_or_not_found'
  | 'unsupported_cross_fork' | 'deferred' | 'offline' | 'unavailable';
interface StackLayer {
  number: number; title: string; state: string; headRef: string; headSha: string; baseRef: string; baseSha: string;
}
export interface NativeStack { id: number; number: number; trunk: string; layers: StackLayer[] }
export interface StackTargetIdentity { repositoryId: number; pullRequestId: number }
export interface StackReadOptions { trigger?: 'target' | 'webhook'; priority?: 'interactive' | 'background'; identity?: StackTargetIdentity; signal?: AbortSignal }
export interface PullRequestStackObservation {
  identity?: StackTargetIdentity;
  status: StackStatus; stale: boolean; source: 'github-native'; snapshot: NativeStack | null;
  revision: string | null; fetchedAt: string | null; attemptedAt: string;
  history?: Array<{ revision: string; snapshot: NativeStack | null; fetchedAt: string; source: 'github-native'; trigger: 'target' | 'webhook' }>;
}

class StackReadError extends Error {
  constructor(readonly status: StackStatus) { super(status); }
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const commit = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new StackReadError('unavailable');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new StackReadError('unavailable');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

function tables() {
  const db = getSqlite();
  db.exec(`CREATE TABLE IF NOT EXISTS github_pr_stack_observations (
    scope TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
    read_order INTEGER NOT NULL, observation_json TEXT NOT NULL,
    PRIMARY KEY(scope, repo, pr_number));
    CREATE TABLE IF NOT EXISTS github_pr_stack_clock (id INTEGER PRIMARY KEY CHECK(id=1), sequence INTEGER NOT NULL);
    INSERT OR IGNORE INTO github_pr_stack_clock VALUES (1,0);`);
  return db;
}

function retained(scope: string, repo: string, number: number, identity?: StackTargetIdentity): PullRequestStackObservation | null {
  const row = tables().prepare('SELECT observation_json FROM github_pr_stack_observations WHERE scope=? AND repo=? AND pr_number=?')
    .get(scope, repo, number) as { observation_json: string } | undefined;
  try {
    const observation = row ? JSON.parse(row.observation_json) as PullRequestStackObservation : null;
    return identity && observation?.identity?.repositoryId === identity.repositoryId && observation.identity.pullRequestId === identity.pullRequestId ? observation : null;
  } catch { return null; }
}

function nativeStack(value: unknown, number: number, target: number, repo: string, identity?: StackTargetIdentity): NativeStack {
  if (!record(value) || !positive(value.id) || value.number !== number || !record(value.base) || !text(value.base.ref)
    || !Array.isArray(value.pull_requests) || !value.pull_requests.length || value.pull_requests.length > 100) throw new StackReadError('unavailable');
  let repositoryId: number | undefined;
  const seen = new Set<number>();
  const layers: StackLayer[] = value.pull_requests.map((item: unknown) => {
    if (!record(item) || !positive(item.number) || seen.has(item.number) || !record(item.head) || !record(item.base)
      || !record(item.head.repo) || !record(item.base.repo) || !positive(item.head.repo.id) || !positive(item.base.repo.id)
      || !text(item.head.ref) || !text(item.base.ref) || !commit(item.head.sha) || !commit(item.base.sha)
      || !text(item.title) || !text(item.state)) throw new StackReadError('unavailable');
    if (identity && (item.base.repo.id !== identity.repositoryId || (item.number === target && item.id !== identity.pullRequestId))) throw new StackReadError('unavailable');
    repositoryId ??= item.base.repo.id;
    if (item.head.repo.id !== repositoryId || item.base.repo.id !== repositoryId) throw new StackReadError('unsupported_cross_fork');
    // Native membership is authoritative, but every layer must belong to the requested repository.
    const repositoryUrl = item.base.repo.url;
    if (typeof repositoryUrl !== 'string') throw new StackReadError('unavailable');
    try {
      if (new URL(repositoryUrl).pathname.toLowerCase() !== `/repos/${repo}`) throw new StackReadError('unavailable');
    } catch { throw new StackReadError('unavailable'); }
    seen.add(item.number);
    return { number: item.number, title: item.title, state: item.state,
      headRef: item.head.ref, headSha: item.head.sha, baseRef: item.base.ref, baseSha: item.base.sha };
  });
  if (!seen.has(target) || layers[0].baseRef !== value.base.ref) throw new StackReadError('unavailable');
  return { id: value.id, number, trunk: value.base.ref, layers };
}

/** A fresh authorized PR read supplies the credential scope; cached metadata never grants authority. */
export async function readPullRequestStack(repoName: string, prNumber: number, authorizedScope?: string, options: StackReadOptions = {}): Promise<PullRequestStackObservation> {
  const { trigger = 'target', priority = 'interactive', signal } = options;
  const identity = options.identity && positive(options.identity.repositoryId) && positive(options.identity.pullRequestId) ? options.identity : undefined;
  const repo = repoName.toLowerCase();
  const attemptedAt = new Date().toISOString();
  const empty = (status: StackStatus): PullRequestStackObservation => ({ status, stale: status !== 'ready' && status !== 'none',
    source: 'github-native', identity, snapshot: null, revision: null, fetchedAt: null, attemptedAt });
  if (!authorizedScope) return empty('unauthorized');
  const db = tables();
  const order = (db.prepare('UPDATE github_pr_stack_clock SET sequence=sequence+1 WHERE id=1 RETURNING sequence').get() as { sequence: number }).sequence;
  let scopeConfirmed = false;
  const read = async (path: string) => {
    scopeConfirmed = false;
    const { response, scope } = await githubInstallationFetch(repoName, path, {
      signal: signal ?? AbortSignal.timeout(18_000), headers: { 'X-GitHub-Api-Version': '2026-03-10' },
    }, { priority });
    if (scope !== authorizedScope) { void response.body?.cancel().catch(() => {}); throw new StackReadError('unauthorized'); }
    scopeConfirmed = true;
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new StackReadError(response.status === 401 || response.status === 403 ? 'unauthorized'
        : response.status === 404 ? 'unsupported_or_not_found' : response.status === 429 ? 'deferred' : 'unavailable');
    }
    if (/rel="next"/.test(response.headers.get('link') ?? '')) { void response.body?.cancel().catch(() => {}); throw new StackReadError('unavailable'); }
    return boundedJson(response);
  };
  let observation: PullRequestStackObservation;
  try {
    const list = await read(`/repos/${repoName}/stacks?pull_request=${prNumber}&per_page=2`);
    if (!Array.isArray(list) || list.length > 1 || (list.length && (!record(list[0]) || !positive(list[0].number)))) throw new StackReadError('unavailable');
    const snapshot = list.length ? nativeStack(await read(`/repos/${repoName}/stacks/${list[0].number}`), list[0].number, prNumber, repo, identity) : null;
    observation = { ...empty(snapshot ? 'ready' : 'none'), snapshot,
      revision: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), fetchedAt: new Date().toISOString() };
  } catch (error) {
    const status = error instanceof StackReadError ? error.status : error instanceof GitHubManagedUnavailableError ? 'unauthorized' : error instanceof GitHubRequestDeferredError ? 'deferred'
      : error instanceof TypeError ? 'offline' : 'unavailable';
    // A thrown transport/auth read has not confirmed its credential scope. Do not
    // disclose an earlier principal's retained data after a disconnect or switch.
    const prior = !scopeConfirmed || status === 'unauthorized' || status === 'unsupported_cross_fork' ? null : retained(authorizedScope, repo, prNumber, identity);
    observation = { ...empty(status), snapshot: prior?.snapshot ?? null, revision: prior?.revision ?? null, fetchedAt: prior?.fetchedAt ?? null };
  }
  if (identity && scopeConfirmed && observation.status !== 'unauthorized' && observation.status !== 'unsupported_cross_fork') {
    const prior = retained(authorizedScope, repo, prNumber, identity);
    const history = prior?.history ?? [];
    observation.history = observation.revision && observation.fetchedAt && ['ready', 'none'].includes(observation.status)
      && history.at(-1)?.revision !== observation.revision
      ? [...history, { revision: observation.revision, snapshot: observation.snapshot, fetchedAt: observation.fetchedAt, source: 'github-native' as const, trigger }].slice(-20)
      : history;
  }
  db.prepare(`INSERT INTO github_pr_stack_observations VALUES (?,?,?,?,?)
    ON CONFLICT(scope,repo,pr_number) DO UPDATE SET read_order=excluded.read_order,observation_json=excluded.observation_json
    WHERE excluded.read_order > github_pr_stack_observations.read_order`)
    .run(authorizedScope, repo, prNumber, order, JSON.stringify({ ...observation,
      history: observation.history ?? retained(authorizedScope, repo, prNumber, identity)?.history ?? [] }));
  // Bound retained observations. Older completions cannot replace a newer target read.
  db.prepare('DELETE FROM github_pr_stack_observations WHERE rowid NOT IN (SELECT rowid FROM github_pr_stack_observations ORDER BY read_order DESC LIMIT 1024)').run();
  if (!scopeConfirmed || observation.status === 'unauthorized' || observation.status === 'unsupported_cross_fork') return observation;
  return retained(authorizedScope, repo, prNumber, identity) ?? observation;
}
