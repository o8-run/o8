import { pullNumberFromSubject } from './contributor-credits.mjs';

const MAX_VERSION_LENGTH = 32;
const MAX_TAG_LENGTH = 40;
const MAX_PUBLISHED_AT_LENGTH = 40;
const MAX_TITLE_LENGTH = 100;
const MAX_SUMMARY_LENGTH = 360;
const MAX_RELEASE_URL_LENGTH = 240;
const MAX_SECTION_TITLE_LENGTH = 40;
const MAX_SECTION_ITEM_LENGTH = 220;

const DROP_PATTERNS = [
  /injection|race.condition|vulnerability|xss|csrf|exploit|CVE|credential|password/i,
  /monetization|monetiz|pricing|paywall|freemium|subscription|revenue|waitlist|gtm|go-to-market|moat/i,
  /\bopus\b|\bsonnet\b|\bhaiku\b|\bgpt-?[0-9.]+\b|\bo[134]-preview\b|deepseek|qwen|ginsu|astra|xhigh|low.reason|high.reason|reasoning.effort|thinking.effort|chain.of.thought|thinking.x-?ray/i,
  /\b[0-9]{2,4}\s*ms\b.*budget|\b[0-9]+\s*mb\b.*budget|\b[0-9]+.line.ceiling|\b800.line|budget|ceiling|line.cap|file.size.limit|token.budget|context.budget/i,
  /model rate|pricing table/i,
  /dogfood|dogfed/i,
];

const BLOCKLIST = [
  'Cortex',
  'Rainwater',
  'Symon',
  'Hurttlocker',
  'aqua-color',
  'OpenClaw',
  'NemoClaw',
  'PicoClaw',
  'Codex',
  'opencode',
  'Tauri',
  'Drizzle',
  'better-sqlite',
  'tmux',
  'Anthropic',
  'Claude',
  'Gemini',
  'GPT-4',
  'GPT-5',
  'Opus',
  'Sonnet',
  'Haiku',
  'DeepSeek',
  'Qwen',
  'Ginsu',
  'Astra',
  'xhigh',
  'BYOK',
  'Cursor',
  'Conductor',
  'monetization',
  'model rate',
  'pricing table',
  'API key',
  'cortexrules',
  'CortexClient',
  '.cortex',
  '.o8-ide',
];

function bounded(value, maxLength) {
  return value.length <= maxLength ? value : value.slice(0, maxLength).trimEnd();
}

/**
 * A release-note bullet whole, or its leading whole sentences when it is too
 * long. Null when even its first sentence is too long: the bullet then stays
 * out of the feed rather than stopping mid-sentence.
 */
function sentenceBounded(value, maxLength) {
  if (value.length <= maxLength) return value;
  let end = 0;
  for (const match of value.matchAll(/[.!?](?=\s|$)/g)) {
    if (match.index + 1 > maxLength) break;
    end = match.index + 1;
  }
  return end ? value.slice(0, end) : null;
}

function capitalize(value) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function asSentence(value) {
  const firstSentence = value.match(/^.*?[.!?](?:\s|$)/)?.[0] ?? value;
  const normalized = firstSentence.replace(/[.!?]+\s*$/, '').trim();
  return normalized ? `${capitalize(normalized)}.` : '';
}

export function scrubPublicText(value) {
  let text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text || DROP_PATTERNS.some((pattern) => pattern.test(text))) return null;

  text = text
    .replace(/~\/\.o8[a-zA-Z0-9._-]*/g, 'the user data dir')
    .replace(/~\/\.cortex[a-zA-Z0-9._-]*/g, 'the user data dir')
    .replace(/lane (governance|review transition|lifecycle|reconcile)/gi, 'workflow transition')
    .replace(/verb=merge/gi, 'workflow action')
    .replace(/approve_and_merge/gi, 'workflow action')
    .replace(/rule-check/gi, 'governance check')
    .replace(/supervisor (watch|fleet|completion)/gi, 'workflow watcher')
    .replace(/Cortex IDE/gi, 'o8')
    .replace(/Cortex-aware/gi, 'context-aware')
    .replace(/CortexClient/gi, 'client')
    .replace(/\.cortexrules/gi, 'project rules')
    .replace(/Cortex ?Memory/gi, 'memory')
    .replace(/Cortex/gi, 'o8')
    .replace(/Rainwater/gi, 'o8')
    .replace(/Symon/gi, 'voice agent')
    .replace(/Hurttlocker/gi, 'design system')
    .replace(/aqua-color/gi, 'the voice stack')
    .replace(/OpenClaw/gi, 'agent runtime')
    .replace(/NemoClaw/gi, 'agent runtime')
    .replace(/PicoClaw/gi, 'bundled runtime')
    .replace(/Codex/gi, 'agent runtime')
    .replace(/Claude Code/gi, 'agent runtime')
    .replace(/opencode/gi, 'agent runtime')
    .replace(/Tauri/gi, 'native shell')
    .replace(/Drizzle/gi, 'ORM')
    .replace(/better-sqlite3?/gi, 'database')
    .replace(/Gemini/gi, 'AI provider')
    .replace(/OpenAI/gi, 'AI provider')
    .replace(/CLAUDE\.md/g, 'project rules')
    .replace(/Claude/gi, 'AI provider')
    .replace(/Anthropic/gi, 'AI provider')
    .replace(/GPT-?[0-9.]*/gi, 'AI model')
    .replace(/Cursor/gi, 'competing product')
    .replace(/Conductor/gi, 'competing product')
    .replace(/API [Kk]ey[s]?/gi, 'configuration')
    .replace(/BYOK/gi, 'bring-your-own')
    .replace(/tmux/gi, 'terminal')
    .replace(/\s*\[via-o8\]\s*$/i, '')
    .replace(/\s*\(#[0-9]+\)/g, '')
    .replace(/\s*#[0-9]+/g, '')
    .replace(/ — .{40,}/g, '')
    .replace(/ (of|for|via|from|with|in|the)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return null;
  const lower = text.toLowerCase();
  if (BLOCKLIST.some((term) => lower.includes(term.toLowerCase()))) return null;
  return text;
}

function publicCommit(subject, credits) {
  const match = String(subject).match(/^(feat|perf|design|fix)(\([^)]*\))?:\s*(.+)$/i);
  if (!match) return null;
  const item = scrubPublicText(match[3]);
  if (!item) return null;
  const kind = match[1].toLowerCase();
  // The credit is appended after the scrub and the length bound, so neither can cut it off.
  const login = credits[pullNumberFromSubject(subject)];
  const credit = login ? ` (thanks @${login})` : '';
  return {
    group: kind === 'perf' ? 'Performance' : kind === 'fix' ? 'Fixes' : 'Features',
    isFeature: kind === 'feat',
    credited: Boolean(login),
    text: capitalize(item),
    item: `${bounded(capitalize(item), MAX_SECTION_ITEM_LENGTH - credit.length)}${credit}`,
  };
}

export function parseReleaseNotes(markdown) {
  const content = String(markdown ?? '');
  if (!content.trim()) return [];

  const items = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*[-*+]\s+(.+?)\s*$/);
    if (!match) {
      throw new Error('release-notes/next.md must contain Markdown bullets only');
    }
    const item = scrubPublicText(match[1]);
    const kept = item && sentenceBounded(capitalize(item), MAX_SECTION_ITEM_LENGTH);
    if (kept) items.push(kept);
  }
  return [...new Set(items)].slice(0, 8);
}

export function buildLatestShip({
  version,
  tag,
  publishedAt,
  releaseUrl,
  commits,
  notesMarkdown = '',
  credits = {},
}) {
  const sourceCommits = commits
    .map((commit) => String(commit.sha ?? '').trim())
    .filter((sha) => /^[a-f0-9]{7,40}$/i.test(sha))
    .slice(0, 50);
  if (sourceCommits.length === 0) throw new Error('latest-ship requires at least one source commit');

  const publicCommits = commits.map((commit) => publicCommit(commit.subject, credits ?? {})).filter(Boolean);
  const notes = parseReleaseNotes(notesMarkdown);
  const sections = [];
  if (notes.length > 0) {
    sections.push({
      title: bounded(scrubPublicText('What this ship changes for you'), MAX_SECTION_TITLE_LENGTH),
      items: notes,
    });
  }

  for (const group of ['Features', 'Performance', 'Fixes']) {
    // Credited items lead their group so the eight-item cap never drops a thank-you.
    const items = [...new Set(publicCommits
      .filter((commit) => commit.group === group)
      .sort((a, b) => Number(b.credited) - Number(a.credited))
      .map((commit) => bounded(commit.item, MAX_SECTION_ITEM_LENGTH)))]
      .slice(0, 8);
    if (items.length > 0) {
      sections.push({
        title: bounded(scrubPublicText(group), MAX_SECTION_TITLE_LENGTH),
        items,
      });
    }
  }
  if (sections.length === 0) throw new Error('latest-ship requires release notes or a public commit section');

  const topFeature = publicCommits.find((commit) => commit.isFeature)?.text;
  const fallbackTitle = scrubPublicText(`o8 ${version}`);
  const title = bounded((topFeature ?? fallbackTitle).replace(/[.!?]+$/, ''), MAX_TITLE_LENGTH);
  const summarySource = notes[0] ?? publicCommits[0]?.text ?? title;
  const summary = bounded(scrubPublicText(asSentence(summarySource)), MAX_SUMMARY_LENGTH);

  const ship = {
    schemaVersion: 1,
    version: bounded(String(version).trim(), MAX_VERSION_LENGTH),
    tag: bounded(String(tag).trim(), MAX_TAG_LENGTH),
    publishedAt: bounded(String(publishedAt).trim(), MAX_PUBLISHED_AT_LENGTH),
    title,
    summary,
    releaseUrl: bounded(String(releaseUrl).trim(), MAX_RELEASE_URL_LENGTH),
    sourceCommits,
    sections,
  };

  if (!/^\d{4}-\d{2}-\d{2}T/.test(ship.publishedAt) || Number.isNaN(Date.parse(ship.publishedAt))) {
    throw new Error('latest-ship publishedAt must be an ISO timestamp');
  }
  if (!ship.releaseUrl.startsWith('https://github.com/o8-run/o8/releases/tag/')) {
    throw new Error('latest-ship releaseUrl must point to an o8 release tag');
  }
  return ship;
}
