/**
 * Skeleton Map — Auto-scan triggers.
 *
 * Fires skeleton scans automatically:
 * 1. On first import (boot) — scans all registered repos in background
 * 2. On repo add/open — scans the specific repo if cache is stale
 * 3. On file change — polls git diff to detect changed files
 *
 * All scans are non-blocking. Failures are logged and swallowed.
 */

import { execSync } from '@/lib/providers/child-process';
import { scanRepo } from './index';
import { getAllCached } from './store';
import { recurring } from '@/lib/background-work/ledger';

/** How old the cache can be before we rescan (5 minutes). */
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

/** Minimum interval between scans of the same repo (30 seconds). */
const SCAN_COOLDOWN_MS = 30_000;

/** Polling interval for git diff change detection (30 seconds). */
const POLL_INTERVAL_MS = 30_000;

// Track in-flight scans to avoid duplicates
const scanningRepos = new Set<string>();
const lastScanTime = new Map<string, number>();
const pollIntervals = new Map<string, ReturnType<typeof setInterval>>();

/**
 * Check if a repo's skeleton cache is stale.
 */
function isCacheStale(repoPath: string): boolean {
  const cached = getAllCached(repoPath);
  if (cached.length === 0) return true;

  const lastScan = lastScanTime.get(repoPath);
  if (!lastScan) return true;

  return Date.now() - lastScan > STALE_THRESHOLD_MS;
}

/**
 * Check scan cooldown to avoid hammering.
 */
function isOnCooldown(repoPath: string): boolean {
  const last = lastScanTime.get(repoPath);
  if (!last) return false;
  return Date.now() - last < SCAN_COOLDOWN_MS;
}

/**
 * Trigger a non-blocking background scan for a single repo.
 * Returns immediately. Deduplicates concurrent scans.
 */
export function triggerScan(repoPath: string): void {
  if (scanningRepos.has(repoPath)) {
    console.log(`[skeleton] Scan already in progress for ${repoPath}, skipping`);
    return;
  }

  if (isOnCooldown(repoPath)) {
    return;
  }

  scanningRepos.add(repoPath);

  // Fire and forget — don't await
  scanRepo({ repoPath })
    .then(map => {
      lastScanTime.set(repoPath, Date.now());
      console.log(`[skeleton] Auto-scan complete: ${map.totalFiles} files, ${map.totalSymbols} symbols (${map.scanDurationMs}ms)`);
    })
    .catch(err => {
      console.warn(`[skeleton] Auto-scan failed for ${repoPath}:`, err);
    })
    .finally(() => {
      scanningRepos.delete(repoPath);
    });
}

/**
 * Trigger scan if cache is stale. Called on repo open/touch.
 */
export function triggerScanIfStale(repoPath: string): void {
  if (isCacheStale(repoPath)) {
    triggerScan(repoPath);
  }
}

/**
 * Scan all registered repos on boot.
 * Reads the repo registry JSON directly to avoid circular imports with server-only modules.
 */
export function triggerBootScan(): void {
  const registryPath = require('node:path').join(
    require('node:os').homedir(),
    '.o8',
    'repos.json',
  );

  let repos: Array<{ localPath: string }>;
  try {
    const raw = require('node:fs').readFileSync(registryPath, 'utf-8');
    const store = JSON.parse(raw);
    repos = store.repos ?? [];
  } catch {
    // No registry yet — nothing to scan
    return;
  }

  if (repos.length === 0) return;

  console.log(`[skeleton] Boot scan: ${repos.length} registered repos`);

  // Stagger scans to avoid I/O spike (200ms between each)
  repos.forEach((repo, i) => {
    setTimeout(() => {
      triggerScanIfStale(repo.localPath);
    }, i * 200);
  });
}

/**
 * Start polling for file changes in a repo via `git diff --name-only`.
 * Re-scans only when files have actually changed.
 */
export function startChangePolling(repoPath: string): void {
  if (pollIntervals.has(repoPath)) return; // Already polling

  let lastKnownDiff = '';

  const interval = recurring('skeleton-autoscan', () => {
    try {
      const diff = execSync(
        'git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached 2>/dev/null',
        { windowsHide: true, cwd: repoPath, encoding: 'utf-8', timeout: 3000 },
      ).trim();

      // Also check for new untracked files
      const untracked = execSync(
        'git ls-files --others --exclude-standard 2>/dev/null | head -20',
        { windowsHide: true, cwd: repoPath, encoding: 'utf-8', timeout: 3000 },
      ).trim();

      const combined = `${diff}\n${untracked}`.trim();

      if (combined !== lastKnownDiff && combined.length > 0) {
        lastKnownDiff = combined;
        const changedCount = combined.split('\n').filter(Boolean).length;
        console.log(`[skeleton] Detected ${changedCount} changed files in ${repoPath}`);
        triggerScan(repoPath);
      }
    } catch {
      // Git command failed — repo might not be accessible
    }
  }, POLL_INTERVAL_MS);

  pollIntervals.set(repoPath, interval);
  console.log(`[skeleton] Started change polling for ${repoPath} (every ${POLL_INTERVAL_MS / 1000}s)`);
}

/**
 * Stop polling for a repo.
 */
export function stopChangePolling(repoPath: string): void {
  const interval = pollIntervals.get(repoPath);
  if (interval) {
    clearInterval(interval);
    pollIntervals.delete(repoPath);
    console.log(`[skeleton] Stopped change polling for ${repoPath}`);
  }
}

// ── Boot trigger ──
// Runs once when this module is first imported by the Next.js server.
// Uses setImmediate to avoid blocking module initialization.

let booted = false;

export function ensureBooted(): void {
  if (booted) return;
  booted = true;
  setImmediate(() => {
    triggerBootScan();
  });
}
