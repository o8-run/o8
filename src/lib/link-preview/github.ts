import 'server-only';

import { promisify } from 'node:util';
import { execFile } from '@/lib/providers/child-process';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 8_000;
const FRESH_MS = 5 * 60_000;
const NAME = /^[A-Za-z0-9][\w.-]{0,99}$/;

/** A github.com link a hover card can describe: a repository, issue or pull request. */
export type GitHubLink =
  | { kind: 'repo'; repo: string }
  | { kind: 'issue' | 'pull'; repo: string; number: number };

export type GitHubPreview =
  | { kind: 'repo'; repo: string; description: string | null; stars: number; forks: number; language: string | null }
  | { kind: 'issue' | 'pull'; repo: string; number: number; title: string; state: 'open' | 'closed' | 'merged'; author: string | null; comments: number };

/** Only https://github.com/{owner}/{repo}, optionally /issues/{n} or /pull/{n}; anything else stays a plain link. */
export function parseGitHubLink(raw: string): GitHubLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.port) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const [owner, name, section, number, ...rest] = parts;
  if (!owner || !name || !NAME.test(owner) || !NAME.test(name.replace(/\.git$/, ''))) return null;
  const repo = `${owner}/${name.replace(/\.git$/, '')}`;
  if (section === undefined) return { kind: 'repo', repo };
  if ((section === 'issues' || section === 'pull') && number && /^[1-9][0-9]{0,6}$/.test(number)
    && (rest.length === 0 || section === 'pull' && rest.length === 1 && ['files', 'commits', 'checks'].includes(rest[0]))) {
    return { kind: section === 'pull' ? 'pull' : 'issue', repo, number: Number(number) };
  }
  return null;
}

type Fetch = (path: string) => Promise<unknown>;

async function ghApi(path: string): Promise<unknown> {
  const { stdout } = await execFileAsync('gh', ['api', path], {
    encoding: 'utf-8', windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** Reads what the card shows. The issues endpoint answers for pull requests too. */
export async function readGitHubPreview(link: GitHubLink, fetch: Fetch = ghApi): Promise<GitHubPreview> {
  if (link.kind === 'repo') {
    const body = await fetch(`repos/${link.repo}`) as Record<string, unknown>;
    return {
      kind: 'repo',
      repo: text(body.full_name) ?? link.repo,
      description: text(body.description),
      stars: count(body.stargazers_count),
      forks: count(body.forks_count),
      language: text(body.language),
    };
  }
  const body = await fetch(`repos/${link.repo}/issues/${link.number}`) as Record<string, unknown>;
  const pull = body.pull_request as Record<string, unknown> | undefined;
  const merged = Boolean(pull && text(pull.merged_at));
  return {
    kind: pull ? 'pull' : 'issue',
    repo: link.repo,
    number: link.number,
    title: text(body.title) ?? `#${link.number}`,
    state: merged ? 'merged' : body.state === 'closed' ? 'closed' : 'open',
    author: text((body.user as Record<string, unknown> | undefined)?.login),
    comments: count(body.comments),
  };
}

const cache = new Map<string, { at: number; preview: Promise<GitHubPreview> }>();

/** A preview read in the last five minutes answers again without asking GitHub. */
export function cachedGitHubPreview(link: GitHubLink, now = Date.now(), fetch?: Fetch): Promise<GitHubPreview> {
  const key = JSON.stringify(link);
  const hit = cache.get(key);
  if (hit && now - hit.at < FRESH_MS) return hit.preview;
  const preview = readGitHubPreview(link, fetch);
  cache.set(key, { at: now, preview });
  preview.catch(() => { if (cache.get(key)?.preview === preview) cache.delete(key); });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return preview;
}
