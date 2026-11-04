import 'server-only';

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

const REPO = 'hurttlocker/o8-releases';
const TTL = 6 * 60 * 60_000;
const MAX_BYTES = 512_000;
export interface ReleaseNotes {
  version: string;
  summary: string;
  overview?: string;
  entries: Array<{ text: string; date?: string }>;
  source: 'release' | 'changelog';
  publishedAt: string | null;
  releaseUrl: string;
  cachedAt: string;
}
type Memo = { notes: ReleaseNotes; at: number };
const state = globalThis as typeof globalThis & { __o8ReleaseNotesV1?: { cache: Map<string, Memo>; pending: Map<string, Promise<ReleaseNotes>> } };
const shared = state.__o8ReleaseNotesV1 ??= { cache: new Map(), pending: new Map() };
const persisting = new Map<string, Promise<ReleaseNotes>>();

export function normalizeReleaseVersion(value: string): string | null {
  return value === 'latest' ? value : /^v?\d+\.\d+\.\d+(?:-preview\.\d+)?$/.test(value)
    ? value.replace(/^v/, '') : null;
}

async function publicText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': 'o8-release-notes', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(6_000), cache: 'no-store' });
  if (!response.ok) throw new Error('Published release notes are unavailable.');
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Published release notes are too large.');
  return text;
}

/** Published text rendered as text nodes; no inference or executable content. */
function releaseEntries(body: string): ReleaseNotes['entries'] {
  return body.split('\n').filter(line => /^\s*[-*]\s+/.test(line)).map(line => ({
    text: line.replace(/^\s*[-*]\s+/, '').replace(/`([0-9a-f]{7,40})`\s*/g, '').trim().slice(0, 600),
  })).filter(entry => entry.text && !/^auto-update artifacts|^see https?:/i.test(entry.text)).slice(0, 20);
}

function releaseOverview(body: string): string | undefined {
  const overview = body.match(/^## What’s changed\s*\n\s*\n([^\n]+)\n/m)?.[1]?.trim();
  return overview && overview.length <= 320 && !/[<>\x00-\x1f]/.test(overview) ? overview : undefined;
}

function changelogEntries(text: string, publishedAt: string | null): ReleaseNotes['entries'] {
  const entries: ReleaseNotes['entries'] = [];
  const through = publishedAt?.slice(0, 10);
  let date: string | undefined;
  for (const line of text.split('\n')) {
    const heading = line.match(/^## (\d{4}-\d{2}-\d{2})/);
    if (heading) date = heading[1];
    if (!date || (through && date > through) || !line.startsWith('- ')) continue;
    entries.push({ text: line.slice(2).replace(/`[0-9a-f]{7,40}`\s*/g, '').trim().slice(0, 600), date });
    if (entries.length === 16) break;
  }
  return entries;
}

export async function getReleaseNotes(version: string): Promise<ReleaseNotes> {
  const key = normalizeReleaseVersion(version);
  if (!key) throw new Error('Invalid release version.');
  const memo = shared.cache.get(key);
  if (memo && Date.now() - memo.at < TTL) return memo.notes;
  const pending = shared.pending.get(key);
  if (pending) return pending;
  const task = (async () => {
    const file = releaseNotesCacheFile(key);
    try {
      const saved = JSON.parse(await readFile(file, 'utf8')) as Memo;
      const tag = normalizeReleaseVersion(saved.notes?.version ?? '');
      if (tag && tag !== 'latest' && (key === 'latest' || tag === key) && typeof saved.notes.summary === 'string'
        && (saved.notes.overview === undefined || (typeof saved.notes.overview === 'string' && saved.notes.overview.length <= 320))
        && Array.isArray(saved.notes.entries) && saved.notes.entries.length <= 20
        && saved.notes.entries.every(entry => typeof entry.text === 'string' && entry.text.length <= 600)
        && saved.notes.releaseUrl === `https://github.com/${REPO}/releases/tag/v${tag}`
        && ['release', 'changelog'].includes(saved.notes.source) && saved.at <= Date.now()
        && Date.now() - saved.at < TTL) { shared.cache.set(key, saved); return saved.notes; }
    } catch { /* Published notes remain usable when a local cache is missing. */ }
    const endpoint = key === 'latest' ? 'latest' : `tags/v${key}`;
    const release = JSON.parse(await publicText(`https://api.github.com/repos/${REPO}/releases/${endpoint}`)) as {
      tag_name?: string; body?: string; published_at?: string;
    };
    const tag = normalizeReleaseVersion(release.tag_name ?? '');
    if (!tag || tag === 'latest' || (key !== 'latest' && tag !== key)) throw new Error('Release version could not be verified.');
    const publishedAt = typeof release.published_at === 'string' ? release.published_at : null;
    const body = typeof release.body === 'string' ? release.body : '';
    const overview = releaseOverview(body);
    let entries = releaseEntries(body);
    let source: ReleaseNotes['source'] = 'release';
    if (!entries.length) {
      const changelog = await publicText(`https://raw.githubusercontent.com/${REPO}/main/CHANGELOG.md`).catch(() => '');
      entries = changelogEntries(changelog, publishedAt);
      source = 'changelog';
    }
    const notes: ReleaseNotes = { version: tag, entries, source, publishedAt,
      ...(overview ? { overview } : {}),
      summary: overview ?? (entries.slice(0, 3).map(entry => entry.text).join(' · ') || `o8 ${tag} is published. See the release for details.`),
      releaseUrl: `https://github.com/${REPO}/releases/tag/v${tag}`, cachedAt: new Date().toISOString() };
    const value = { notes, at: Date.now() };
    shared.cache.set(key, value);
    return notes;
  })().finally(() => shared.pending.delete(key));
  shared.pending.set(key, task);
  return task;
}

function releaseNotesCacheFile(key: string): string {
  // Inject the environment to resolve the directory without running migration.
  return path.join(getDataDir({ ...process.env }), 'release-notes-cache', `${key}.json`);
}

/** Explicit cache maintenance; reads only hydrate the in-memory memo. */
export async function persistReleaseNotes(version: string): Promise<ReleaseNotes> {
  const key = normalizeReleaseVersion(version);
  if (!key) throw new Error('Invalid release version.');
  const pending = persisting.get(key);
  if (pending) return pending;
  const task = (async () => {
    const notes = await getReleaseNotes(key);
    const file = releaseNotesCacheFile(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(shared.cache.get(key)), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
    return notes;
  })().finally(() => persisting.delete(key));
  persisting.set(key, task);
  return task;
}
