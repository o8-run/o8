import { viewerJson } from '@/lib/viewers/response';
import { NextRequest } from 'next/server';
import { performance } from 'node:perf_hooks';
import { getOwnedCodexRuntimeTail } from '@/lib/codex/owned';
import { getCodexRuntimeTail } from '@/lib/codex/sessions';
import { loadMobileLlmChatHistory } from '@/lib/llm/mobile-llm-chat';
import type { MobileInboxSnapshot, MobileTranscriptEntry } from '@/lib/mobile/types';
import { mobileInboxSignature } from '@/lib/mobile/inbox-signature';
import { getMobileInboxSnapshot } from '@/lib/mobile/inbox';
import { mergeDurableMobileTranscriptEntries, parseMobileTranscriptTimestamp } from '@/lib/mobile/history';
import '@/lib/runtimes'; // Ensure runtimes are registered
import { getRuntime } from '@/lib/runtimes/registry';
import { runtimeIdFromSessionKey } from '@/lib/runtime/transcript';
import { getReviewFileDetail } from '@/lib/review/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Types ──

interface SyncRequest {
  inbox?: { etag?: string };
  history?: { sessionKey: string; sinceId?: string; limit?: number };
  review?: { sessionKey?: string; includeFile?: string };
  linked?: { sessionKey: string; sinceId?: string };
}

interface SyncResponse {
  inbox?: MobileInboxSnapshot | null;
  inboxEtag?: string;
  history?: { sessionKey: string; entries: MobileTranscriptEntry[]; replace?: boolean };
  review?: { file?: unknown };
  linked?: { sessionKey: string; entries: MobileTranscriptEntry[]; replace?: boolean };
  serverTime: string;
  errors?: Record<string, string>;
}

function computeEtag(snapshot: MobileInboxSnapshot): string {
  const sig = mobileInboxSignature(snapshot);
  let hash = 0;
  for (let i = 0; i < sig.length; i++) {
    hash = ((hash << 5) - hash + sig.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

async function resolveInbox(req: SyncRequest['inbox']): Promise<{ snapshot: MobileInboxSnapshot | null; etag: string }> {
  const snapshot = await getMobileInboxSnapshot();
  const etag = computeEtag(snapshot);

  if (req?.etag && req.etag === etag) {
    return { snapshot: null, etag };
  }
  return { snapshot, etag };
}

// ── History resolver ──

function runtimeTailRole(label: string): MobileTranscriptEntry['role'] {
  const normalized = label.toLowerCase();
  if (normalized.includes('assistant')) return 'assistant';
  if (normalized.includes('user')) return 'user';
  if (normalized.includes('tool')) return 'tool';
  return 'system';
}

async function resolveHistory(
  req: NonNullable<SyncRequest['history']>,
): Promise<{ sessionKey: string; entries: MobileTranscriptEntry[]; replace?: boolean }> {
  const { sessionKey, limit: rawLimit } = req;
  const limit = Math.min(Math.max(rawLimit ?? 18, 1), 200);

  if (sessionKey.startsWith('llm-chat:')) {
    const transcript = loadMobileLlmChatHistory(sessionKey, limit).transcript;
    return resolveHistoryDelta(sessionKey, transcript, req.sinceId);
  }

  if (sessionKey.startsWith('codex-owned:')) {
    const tail = await getOwnedCodexRuntimeTail(sessionKey, limit);
    const entries: MobileTranscriptEntry[] = [];
    for (const group of tail.groups ?? []) {
      const promptText = group.prompt?.trim();
      if (promptText) {
        entries.push({
          id: `${group.id}-prompt`,
          role: 'user',
          text: promptText,
          timestamp: parseMobileTranscriptTimestamp(group.startedAt),
          timestampLabel: group.startedAtLabel,
        });
      }
      for (const entry of group.entries) {
        const text = entry.text.trim();
        if (!text) continue;
        if (promptText && text === promptText) continue;
        if (text.startsWith('Usage •') || text.includes('Owned Codex session') || text.includes('Codex run launched')) continue;
        const role = runtimeTailRole(entry.label);
        if (role === 'assistant') {
          entries.push({
            id: entry.id,
            role: 'assistant',
            text,
            timestamp: parseMobileTranscriptTimestamp(entry.timestamp),
            timestampLabel: entry.timestampLabel,
          });
        } else if (entry.kind === 'tool') {
          entries.push({ id: entry.id, role: 'system', text: entry.text || `Tool: ${entry.label || 'Command'}`, timestampLabel: entry.timestampLabel });
          const timestamp = parseMobileTranscriptTimestamp(entry.timestamp);
          if (timestamp !== undefined) entries[entries.length - 1]!.timestamp = timestamp;
        }
      }
    }
    return resolveHistoryDelta(sessionKey, entries.slice(-limit), req.sinceId);
  }

  if (sessionKey.startsWith('codex:')) {
    const tail = await getCodexRuntimeTail(sessionKey, limit);
    const raw: MobileTranscriptEntry[] = [];
    for (const entry of tail.entries ?? []) {
      if (entry.kind === 'event' && entry.label === 'Agent update') {
        raw.push({
          id: entry.id,
          role: 'assistant',
          text: entry.text,
          timestamp: parseMobileTranscriptTimestamp(entry.timestamp),
          timestampLabel: entry.timestampLabel,
        });
        continue;
      }
      if (entry.kind === 'message') {
        const role = runtimeTailRole(entry.label);
        // Filter system noise
        if (role === 'system' || role === 'user') {
          const lt = entry.text.toLowerCase();
          if (lt.includes('<permissions') || lt.includes('collaboration_mode') || lt.includes('# agents.md') || lt.includes('sandbox_mode')) continue;
        }
        raw.push({
          id: entry.id,
          role,
          text: entry.text,
          timestamp: parseMobileTranscriptTimestamp(entry.timestamp),
          timestampLabel: entry.timestampLabel,
        });
        continue;
      }
      // Collapse tool calls — skip individual tool entries and tool output.
      // Users see the assistant's summary of what it did, not every raw function call.
      if (entry.kind === 'tool' || entry.kind === 'tool-output') {
        continue;
      }
    }
    // Deduplicate: remove entries with identical text (not just consecutive)
    const seen = new Set<string>();
    const deduped: MobileTranscriptEntry[] = [];
    for (const entry of raw) {
      // Normalize for dedup: trim and take first 200 chars
      const key = `${entry.role}:${entry.text.trim().slice(0, 200)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(entry);
    }
    return resolveHistoryDelta(sessionKey, deduped, req.sinceId);
  }

  // Claude Code sessions — read from JSONL via runtime adapter
  if (sessionKey.startsWith('claude-code:')) {
    const ccRuntime = getRuntime('claude-code');
    if (ccRuntime?.readTranscript) {
      const entries = await ccRuntime.readTranscript(sessionKey, undefined, limit);
      const transcript: MobileTranscriptEntry[] = entries.map(entry => ({
        id: entry.id,
        role: entry.role === 'user' ? 'user' : entry.role === 'assistant' ? 'assistant' : 'system',
        text: entry.text,
        type: entry.type ?? 'message',
        timestamp: entry.timestamp.getTime(),
        timestampLabel: entry.timestamp
          ? entry.timestamp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
          : '',
        toolCalls: entry.toolCalls && entry.toolCalls.length > 0
          ? entry.toolCalls.map((tool) => ({
              id: tool.id,
              name: tool.name,
              args: tool.args,
              preview: tool.preview,
              status: tool.status,
            }))
          : undefined,
        compaction: entry.compaction ? {
          timestamp: entry.compaction.timestamp.getTime(),
          tokensBefore: entry.compaction.tokensBefore,
          tokensAfter: entry.compaction.tokensAfter,
          trigger: entry.compaction.trigger,
          source: entry.compaction.source,
          summary: entry.compaction.summary,
        } : undefined,
      }));
      return resolveHistoryDelta(sessionKey, transcript, req.sinceId);
    }
  }

  // Every registered runtime with transcript support is authoritative for its
  // own session keys. Keep the bespoke mobile renderers above where they add
  // useful filtering, then fall through to the universal adapter contract so a
  // newly registered runtime never becomes an empty destructive snapshot here.
  const runtimeId = runtimeIdFromSessionKey(sessionKey);
  const registeredRuntime = runtimeId ? getRuntime(runtimeId) : undefined;
  if (registeredRuntime?.capabilities.readTranscript) {
    const runtimeEntries = await registeredRuntime.readTranscript(sessionKey, undefined, limit);
    const transcript: MobileTranscriptEntry[] = runtimeEntries.map((entry) => ({
      id: entry.id,
      role: entry.role === 'user'
        ? 'user'
        : entry.role === 'assistant'
          ? 'assistant'
          : entry.role === 'tool'
            ? 'tool'
            : 'system',
      text: entry.text,
      type: entry.type ?? 'message',
      timestamp: entry.timestamp.getTime(),
      timestampLabel: entry.timestamp.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
      }),
      toolCalls: entry.toolCalls,
      compaction: entry.compaction ? {
        timestamp: entry.compaction.timestamp.getTime(),
        tokensBefore: entry.compaction.tokensBefore,
        tokensAfter: entry.compaction.tokensAfter,
        trigger: entry.compaction.trigger,
        source: entry.compaction.source,
        summary: entry.compaction.summary,
      } : undefined,
    }));
    return resolveHistoryDelta(sessionKey, transcript, req.sinceId);
  }
  throw new Error(`Transcript sync is unsupported for ${sessionKey}`);
}

function applyDelta(entries: MobileTranscriptEntry[], sinceId?: string): {
  entries: MobileTranscriptEntry[];
  replace?: boolean;
} {
  if (!sinceId) return { entries };
  const idx = entries.findIndex((e) => e.id === sinceId);
  if (idx === -1) {
    return {
      entries,
      replace: true,
    };
  }
  return { entries: entries.slice(idx + 1) };
}

function resolveHistoryDelta(
  sessionKey: string,
  entries: MobileTranscriptEntry[],
  sinceId?: string,
): { sessionKey: string; entries: MobileTranscriptEntry[]; replace?: boolean } {
  return {
    sessionKey,
    ...applyDelta(mergeDurableMobileTranscriptEntries(sessionKey, entries), sinceId),
  };
}

// ── Review file resolver ──

const reviewFileCache = new Map<string, { data: unknown; timestamp: number }>();
const REVIEW_FILE_CACHE_TTL = 10000;

async function resolveReviewFile(filePath: string): Promise<unknown> {
  const cached = reviewFileCache.get(filePath);
  if (cached && Date.now() - cached.timestamp < REVIEW_FILE_CACHE_TTL) {
    return cached.data;
  }
  const file = await getReviewFileDetail(filePath);
  reviewFileCache.set(filePath, { data: file, timestamp: Date.now() });
  return file;
}

// ── Main handler ──

export async function POST(request: NextRequest) {
  const startedAt = performance.now();
  let body: SyncRequest;
  try {
    body = (await request.json()) as SyncRequest;
  } catch {
    return viewerJson({ error: 'Invalid or empty request body' }, { status: 400 });
  }
  const errors: Record<string, string> = {};

  // Resolve ALL requested sections in parallel — one failure doesn't block others
  const [inboxResult, historyResult, reviewResult, linkedResult] = await Promise.all([
    body.inbox
      ? resolveInbox(body.inbox).catch((e: unknown) => {
          errors.inbox = e instanceof Error ? e.message : 'inbox failed';
          return null;
        })
      : null,
    body.history?.sessionKey
      ? resolveHistory(body.history).catch((e: unknown) => {
          errors.history = e instanceof Error ? e.message : 'history failed';
          return null;
        })
      : null,
    body.review?.includeFile
      ? resolveReviewFile(body.review.includeFile).catch((e: unknown) => {
          errors.review = e instanceof Error ? e.message : 'review failed';
          return null;
        })
      : null,
    body.linked?.sessionKey
      ? resolveHistory({ sessionKey: body.linked.sessionKey, sinceId: body.linked.sinceId, limit: 18 }).catch((e: unknown) => {
          errors.linked = e instanceof Error ? e.message : 'linked failed';
          return null;
        })
      : null,
  ]);

  const response: SyncResponse = { serverTime: new Date().toISOString() };

  if (inboxResult) {
    response.inbox = inboxResult.snapshot;
    response.inboxEtag = inboxResult.etag;
  }
  if (historyResult) {
    response.history = historyResult;
  }
  if (reviewResult !== null && reviewResult !== undefined) {
    response.review = { file: reviewResult };
  }
  if (linkedResult) {
    response.linked = linkedResult;
  }
  if (Object.keys(errors).length > 0) {
    response.errors = errors;
  }

  return viewerJson(response, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}`,
    },
  });
}
