import { readFileSync } from 'node:fs';
import { isSavedConnectivityCheck } from '@/lib/orchestrator/connectivity-check';
import { resolveRepoGithubIdentity } from '@/lib/repos/github-identity';
import type { MobileOrchestratorThread } from '@/lib/mobile/types';
import { projectOrchestratorThread, type OrchestratorHistoryRecord } from './orchestrator-thread-projection';

interface HistoryStat {
  filePath: string;
  tabId: string;
  mtimeMs: number;
  size: number;
  modifiedAt: string;
}

interface CachedSummary {
  mtimeMs: number;
  size: number;
  json: string;
  bytes: number;
}

/** Discovery needs summaries, never the transcript graph. Bound even those summaries. */
class ThreadSummaryCache {
  private readonly entries = new Map<string, CachedSummary>();
  private bytes = 0;
  private readonly maxEntries = 256;
  private readonly maxBytes = 1024 * 1024;

  keys() { return this.entries.keys(); }

  delete(key: string) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }

  read(stat: HistoryStat): MobileOrchestratorThread | null {
    const cached = this.entries.get(stat.filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      this.entries.delete(stat.filePath);
      this.entries.set(stat.filePath, cached);
      const { thread, remoteUrl } = JSON.parse(cached.json) as {
        thread: MobileOrchestratorThread | null;
        remoteUrl: string | null;
      };
      // Git metadata can change independently of the history stat. Preserve the
      // previous per-list projection behavior, and return a fresh object.
      return thread ? { ...thread, ...resolveRepoGithubIdentity(thread.repoPath, remoteUrl) } : null;
    }
    this.delete(stat.filePath);
    const record = JSON.parse(readFileSync(stat.filePath, 'utf8')) as OrchestratorHistoryRecord;
    const thread = record.archivedAt || isSavedConnectivityCheck(record) ? null : projectOrchestratorThread(stat.tabId, record, stat.modifiedAt);
    const remoteUrl = typeof record.remoteUrl === 'string' ? record.remoteUrl : null;
    // Serialization also detaches title/agent substrings from larger source
    // strings, so charged bytes bound the retained allocation itself.
    const json = JSON.stringify({ thread, remoteUrl });
    // Conservative UTF-16 accounting, including the map key and entry overhead.
    const bytes = 2 * (stat.filePath.length + json.length) + 256;
    if (bytes <= this.maxBytes) {
      while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.delete(oldest);
      }
      this.entries.set(stat.filePath, { mtimeMs: stat.mtimeMs, size: stat.size, json, bytes });
      this.bytes += bytes;
    }
    return thread ? { ...thread } : null;
  }
}

export const threadSummaryCache = new ThreadSummaryCache();
