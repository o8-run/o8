import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, readPublished, releaseRange, resolveNewFixes } from './fixed-reports.mjs';
import { contributorCreditLine, creditsForSubjects, ghCreditLookups } from './contributor-credits.mjs';
import { publishFixed } from '../publish-fixed.mjs';
import { syncReports } from '../sync-reports.mjs';
import { buildLatestShip, scrubPublicText } from './public-release.mjs';
import { formatReleaseSummary, prepareReleaseSummary } from './release-summary.mjs';

const REPO = 'o8-run/o8';
const PUBLIC_MIRROR = 'hurttlocker/o8-releases';
const SOURCE_REPO = process.env.O8_SOURCE_REPO || '';
const PING_MIN_BULLETS = Number(process.env.O8_PING_MIN_BULLETS || 4);
const PING_ALWAYS_RE = /\b(security|vulnerabilit|CVE|breaking change|breaking:|data loss|corrupt|hotfix|urgent|must update|required update)\b/i;

/** Shared by direct stable publication and promotion of authenticated beta bytes. */
export function stableReleaseEffects({ root, version, tag, range, notesRef }) {
  let metadataRange = range;
  let releaseSummary = null;
  let pendingFixes = [];
  function releaseMetadataRange() { return metadataRange ??= releaseRange(tag); }
  function releaseNotesMarkdown() {
    if (notesRef) {
      try { return execFileSync('git', ['show', `${notesRef}:release-notes/next.md`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { return ''; }
    }
    const notesPath = join(root, 'release-notes', 'next.md');
    return existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : '';
  }

  async function prepareFixed(fixedJsonPath, pubDate) {
    try {
      const { status, fresh } = await syncReports();
      if (status === 'disabled') {
        console.log('[release] external intake reconciliation intentionally disabled; continuing with the local ledger');
      }
      if (fresh.length > 0) console.log(`[release] imported ${fresh.length} report(s) from the intake channel`);
    } catch (err) {
      console.warn(`[release] ⚠ intake-channel sync failed: ${err?.message ?? err}`);
      console.warn('[release]   only self-filed reports will resolve — fixes for other people\'s bugs will be skipped.');
    }
    const { entries, missing: unknownFixes } = resolveNewFixes(releaseMetadataRange(), version);
    pendingFixes = entries;
    const fixedManifest = buildManifest([...readPublished(), ...pendingFixes], pubDate);
    writeFileSync(fixedJsonPath, JSON.stringify(fixedManifest, null, 2));
    console.log(`[release] wrote ${fixedJsonPath} (${fixedManifest.fixed.length} fixed report${fixedManifest.fixed.length === 1 ? '' : 's'}, ${pendingFixes.length} new this release)`);
    if (unknownFixes.length > 0) {
      console.warn(`[release] ⚠ ${unknownFixes.length} Fixes-Report trailer(s) name an id with no ledger entry — those reporters will NOT get a receipt:`);
      for (const { id, commit } of unknownFixes) console.warn(`[release]   ${id} (${commit.sha})`);
    }
  }

  async function complete(pubDate, progress = {}) {
    const completed = progress.completed ?? {};
    const mark = progress.mark ?? (() => {});
    // Publish the page feeds from one local mirror checkout and one mirror commit.
    // This runs only after the updater assets are available on the public mirror.
    let publicFeedPublished = false;
    const failures = [];
    try {
      if (!completed.changelog) {
        publishPublicRelease({ publishedAt: resolvePublishedAt(pubDate) });
        mark('changelog');
      }
      publicFeedPublished = true;
      console.log('[release] public changelog and latest ship synced (local path)');
    } catch (err) {
      failures.push('changelog');
      console.error('[release] public feed sync failed (non-fatal):', err?.message ?? err);
      console.error('[release] re-run manually: node scripts/release.mjs --dry-run');
    }

    if (publicFeedPublished && existsSync(join(root, 'release-notes', 'next.md'))) {
      console.log('[release] Archive release-notes/next.md through a follow-up PR; protected main is not modified by publication.');
    }

    // Announce the fixes ONLY now — the mirror is what makes v${version} real, and
    // "fixed in v0.1.592" is a lie until an operator can actually install it.
    // Non-fatal: a Discord hiccup must never fail a shipped release. The next
    // publish:fixed picks up anything missed (published.json is the dedupe).
    if (pendingFixes.length > 0 && !completed.fixed) {
      try {
        await publishFixed({ range: releaseMetadataRange(), version });
        mark('fixed');
      } catch (err) {
        failures.push('fixed announcements');
        console.error(`[release] #fixed announce failed (release is fine):`, err?.message ?? err);
        console.error(`[release] re-run later with: npm run publish:fixed`);
      }
    }

    // Community #releases announce rides the mirror for the same reason: the
    // mirror is what makes the update installable. Non-fatal, same as #fixed.
    try {
      if (!completed.announcement) {
        const sent = await announceRelease();
        if (sent) mark('announcement');
      }
    } catch (err) {
      failures.push('release announcement');
      console.error(`[release] #releases announce failed (release is fine):`, err?.message ?? err);
    }
    return { complete: failures.length === 0, failures };
  }

  /** env wins; else the gitignored o8.release.json — never a literal in source. */
  function resolveReleasesWebhook() {
    const fromEnv = process.env.O8_RELEASES_WEBHOOK_URL?.trim();
    if (fromEnv) return fromEnv;
    try {
      const cfg = JSON.parse(readFileSync(join(root, 'o8.release.json'), 'utf8'));
      const url = typeof cfg.releasesWebhookUrl === 'string' ? cfg.releasesWebhookUrl.trim() : '';
      return url || null;
    } catch {
      return null;
    }
  }

  /**
   * Bullets are the release range's public feat/perf/design subjects. A trailing
   * parenthetical is stripped because commit-local context does not belong in a
   * community announcement.
   */
  function composeReleaseAnnouncement() {
    const range = releaseMetadataRange();
    let allSubjects = [];
    try {
      allSubjects = execFileSync('git', ['log', '--format=%s', '--no-merges', range], { encoding: 'utf8' })
        .split('\n').filter(Boolean);
    } catch {}
    let subjects = [];
    try {
      subjects = execFileSync('git', ['log', '--format=%s', '--no-merges', range], { encoding: 'utf8' })
        .split('\n')
        .filter((s) => /^(feat|perf|design)(\(.*\))?:/.test(s));
    } catch {}
    const bullets = subjects
      .map((s) => scrubPublicText(s.replace(/^(feat|perf|design)(\([^)]*\))?:\s*/, '')))
      .filter(Boolean)
      .slice(0, 6)
      .map((s) => `- ${s.charAt(0).toUpperCase()}${s.slice(1)}`);
    const date = new Date().toISOString().slice(0, 10);
    // Source links remain opt-in: set O8_SOURCE_REPO=o8-run/o8 to include the code repository.
    // The release mirror remains the download destination for announcements.
    const sourceLine = SOURCE_REPO
      ? `Source: https://github.com/${SOURCE_REPO}`
      : null;
    // Ping only when it earns it: a big ship, or something nobody can safely skip.
    const necessary = allSubjects.some((x) => PING_ALWAYS_RE.test(x));
    const ping = necessary || bullets.length >= PING_MIN_BULLETS;
    const content = [
      ...(ping ? ['@everyone'] : []),
      `**o8 ${tag}** — ${date}`,
      '',
      ...(bullets.length ? bullets : ['- Fixes and maintenance.']),
      '',
      `Update: relaunch o8 (auto-updates within 30 min), or grab it fresh: https://github.com/${PUBLIC_MIRROR}/releases/tag/${tag}`,
      ...(sourceLine ? [sourceLine] : []),
    ].join('\n');
    return { content, ping, reason: necessary ? 'necessary update' : (ping ? `big ship (${bullets.length} bullets)` : `small ship (${bullets.length} bullets)`) };
  }

  // #3459: outside contributors in this release, by pull request number.
  // Resolved once (cached on the function: it runs before a module-level `let`
  // below this point would be initialized); any GitHub failure yields no
  // credits, never a failed ship.
  function releaseCredits() {
    if (releaseCredits.cached) return releaseCredits.cached;
    try {
      const commits = releaseCommits();
      const oldest = commits.at(-1)?.sha;
      const since = oldest
        ? execFileSync('git', ['show', '-s', '--format=%as', oldest], { cwd: root, encoding: 'utf8' }).trim()
        : undefined;
      releaseCredits.cached = creditsForSubjects(
        commits.map((commit) => commit.subject),
        ghCreditLookups(REPO, { since }),
      );
    } catch (error) {
      console.warn(`[release] contributor credits skipped: ${error?.message ?? error}`);
      releaseCredits.cached = {};
    }
    return releaseCredits.cached;
  }

  function releaseCommits() {
    return execFileSync('git', [
      'log',
      '--format=%H%x09%s',
      '--no-merges',
      releaseMetadataRange(),
    ], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('\t');
        return { sha: line.slice(0, separator), subject: line.slice(separator + 1) };
      });
  }

  function resolvePublishedAt(fallback) {
    try {
      return execFileSync('gh', [
        'release', 'view', tag,
        '--repo', REPO,
        '--json', 'publishedAt',
        '--jq', '.publishedAt',
      ], { encoding: 'utf8' }).trim();
    } catch {
      return fallback || execFileSync('git', [
        'show', '-s', '--format=%cI', tag,
      ], { cwd: root, encoding: 'utf8' }).trim();
    }
  }

  function publishPublicRelease({ publishedAt, dryRun: preview = false, outDir = null }) {
    const notesMarkdown = releaseNotesMarkdown();
    const latestShip = buildLatestShip({
      version,
      tag,
      publishedAt,
      releaseUrl: `https://github.com/${REPO}/releases/tag/${tag}`,
      commits: releaseCommits(),
      notesMarkdown,
      credits: releaseCredits(),
    });
    if (releaseSummary) latestShip.summary = releaseSummary.summary;
    const stagingDir = mkdtempSync(join(tmpdir(), 'o8-latest-ship-'));
    const latestShipPath = join(stagingDir, 'latest-ship.json');

    try {
      writeFileSync(latestShipPath, `${JSON.stringify(latestShip, null, 2)}\n`);
      const args = [
        join(root, 'scripts', 'sync-public-changelog.sh'),
        '--latest-ship', latestShipPath,
      ];
      if (preview) args.push('--dry-run', '--out-dir', outDir);
      execFileSync('bash', args, { cwd: root, stdio: 'inherit',
        env: { ...process.env, O8_CHANGELOG_SOURCE_REF: tag } });
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  async function announceRelease() {
    const webhookUrl = resolveReleasesWebhook();
    if (!webhookUrl) {
      console.log('[release] no #releases webhook configured — skipping community announce');
      return false;
    }
    const { content, ping, reason } = composeReleaseAnnouncement();
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // allowed_mentions is REQUIRED for the ping to land: a webhook can contain the literal
      // "@everyone" and Discord renders it as inert text unless "everyone" is parsed here.
      // It is also what SUPPRESSES the ping on a small ship — parse: [] means nothing notifies.
      body: JSON.stringify({
        username: 'o8',
        content,
        allowed_mentions: { parse: ping ? ['everyone'] : [] },
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Discord returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`);
    }
    console.log(`[release] announced in community #releases (${ping ? '@everyone' : 'no ping'} — ${reason})`);
    return true;
  }

  function prepareNotes() {
    releaseSummary = prepareReleaseSummary(buildLatestShip({ version, tag, publishedAt: new Date().toISOString(),
      releaseUrl: `https://github.com/${REPO}/releases/tag/${tag}`, commits: releaseCommits(),
      notesMarkdown: releaseNotesMarkdown() }));
    return formatReleaseSummary(releaseSummary);
  }
  return { creditLine: () => contributorCreditLine(releaseCredits()), prepareFixed, complete, prepareNotes, publishPublicRelease, resolvePublishedAt,
    releaseCredits, composeReleaseAnnouncement, announceRelease, releaseMetadataRange };
}
