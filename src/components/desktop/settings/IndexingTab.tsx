'use client';

/**
 * IndexingTab — the Indexing settings page (Cursor-parity pass, wave 2).
 *
 * Cursor's Indexing tab shows per-folder code-index state + ignore rules.
 * o8's analog is the Cortex v2 memory substrate: the codebase-memory symbol
 * indexer (per repo) plus spec ingestion that turns each repo's docs into the
 * Engineering Brain's directive citations. This tab surfaces both as
 * status-first, honest state — every row reflects a real store, never a mock.
 *
 * Data sources (all gated `/api/cortex/*` routes, loopback-authed):
 *   - Repositories group  → GET /api/cortex/codebase-memory (IndexState.entries)
 *   - Reindex action      → POST /api/cortex/reingest (re-runs spec ingestion)
 *   - Engineering Brain   → GET /api/cortex/diagnostics (directives + ledger counts)
 */

import { useCallback, useEffect, useState } from 'react';

import {
  APP_FONT_STACK,
  BrainIcon,
  RamsButton,
  SETTINGS_CONTENT_MAX_WIDTH,
  TabHeading,
} from './shared';
import { KnowledgeSourcesSection } from './KnowledgeSourcesSection';
import { ConversationImportSection } from './ConversationImportSection';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';
import type { IndexState, RepoIndexEntry, RepoIndexStatus } from '@/lib/codebase-memory/types';

// ── Minimal raw-SVG glyphs (React icon libs don't render in the Tauri webview).

function RepoIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function LedgerIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8M8 17h8" />
    </svg>
  );
}

function DocIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
      <path d="M15 2v5h5" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  );
}

// ── Status → label + pill tone.

interface StatusPresentation {
  label: string;
  tone: 'default' | 'success' | 'destructive';
}

function presentStatus(status: RepoIndexStatus): StatusPresentation {
  switch (status) {
    case 'ready': return { label: 'Indexed', tone: 'success' };
    case 'cached': return { label: 'Up to date', tone: 'success' };
    case 'indexing': return { label: 'Indexing…', tone: 'default' };
    case 'pending': return { label: 'Queued', tone: 'default' };
    case 'deferred': return { label: 'Deferred', tone: 'default' };
    case 'skipped': return { label: 'Skipped', tone: 'default' };
    case 'error': return { label: 'Error', tone: 'destructive' };
    default: return { label: status, tone: 'default' };
  }
}

function relativeTime(iso?: string | null): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

interface DiagnosticsResponse {
  ok?: boolean;
  outcomesCount?: number;
  directivesCount?: number;
}

// Transient per-repo reindex state.
type ReindexState =
  | { phase: 'idle' }
  | { phase: 'busy' }
  | { phase: 'done'; written: number; scanned: number }
  | { phase: 'error'; message: string };

export function IndexingTab() {
  const [index, setIndex] = useState<IndexState | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [indexLoading, setIndexLoading] = useState(true);

  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);
  const [diagLoading, setDiagLoading] = useState(true);

  const [reindex, setReindex] = useState<Record<string, ReindexState>>({});

  const loadIndex = useCallback(async () => {
    setIndexLoading(true);
    setIndexError(null);
    try {
      const res = await fetch('/api/cortex/codebase-memory', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as IndexState;
      setIndex(data);
    } catch (err) {
      setIndexError(err instanceof Error ? err.message : String(err));
    } finally {
      setIndexLoading(false);
    }
  }, []);

  const loadDiagnostics = useCallback(async () => {
    setDiagLoading(true);
    try {
      const res = await fetch('/api/cortex/diagnostics', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as DiagnosticsResponse;
      setDiagnostics(data);
    } catch {
      setDiagnostics(null);
    } finally {
      setDiagLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadIndex();
    void loadDiagnostics();
  }, [loadIndex, loadDiagnostics]);

  const runReindex = useCallback(async (entry: RepoIndexEntry) => {
    setReindex((prev) => ({ ...prev, [entry.repoId]: { phase: 'busy' } }));
    try {
      const res = await fetch('/api/cortex/reingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath: entry.localPath }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        result?: { writtenDirectives?: number; scannedFiles?: number };
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setReindex((prev) => ({
        ...prev,
        [entry.repoId]: {
          phase: 'done',
          written: data.result?.writtenDirectives ?? 0,
          scanned: data.result?.scannedFiles ?? 0,
        },
      }));
      // Directive counts changed — refresh the Brain totals.
      void loadDiagnostics();
    } catch (err) {
      setReindex((prev) => ({
        ...prev,
        [entry.repoId]: { phase: 'error', message: err instanceof Error ? err.message : String(err) },
      }));
    }
  }, [loadDiagnostics]);

  const entries = index?.entries ?? [];

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 8,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <TabHeading
        title="indexing"
        subtitle="See which repositories o8 has indexed and refresh the documentation used for repository answers."
      />

      {/* ── Repositories ─────────────────────────────────────────────── */}
      <section style={{ marginBottom: 28 }}>
        <SettingsGroup
          header="Repositories"
          footnote="Each connected repo is indexed for code symbols so agents can navigate it. Refresh docs re-reads the repo's docs (README, CLAUDE.md, AGENTS.md, DESIGN.md, and docs/) into the Brain's citations — run it after editing those files."
        >
          {indexLoading ? (
            <SettingsRow icon={<RepoIcon />} label="Loading index state…" />
          ) : indexError ? (
            <SettingsRow
              icon={<RepoIcon />}
              label="Couldn't read index state"
              subtitle={indexError}
              value="Retry"
              onPress={() => void loadIndex()}
            />
          ) : entries.length === 0 ? (
            <SettingsRow
              icon={<RepoIcon />}
              label="No repositories connected yet"
              subtitle="Connect a repo from the sidebar and o8 will index it here."
            />
          ) : (
            entries.map((entry, i) => {
              const status = presentStatus(entry.status);
              const indexedAt = relativeTime(entry.lastIndexedAt);
              const rx = reindex[entry.repoId] ?? { phase: 'idle' };

              let subtitle: string;
              if (entry.status === 'error' && entry.error) {
                subtitle = entry.error;
              } else if (indexedAt) {
                subtitle = `Symbols indexed ${indexedAt}`;
              } else {
                subtitle = entry.localPath;
              }

              const busy = rx.phase === 'busy';
              const actionLabel = busy
                ? 'Refreshing…'
                : rx.phase === 'done'
                  ? `${rx.written} section${rx.written === 1 ? '' : 's'}`
                  : rx.phase === 'error'
                    ? 'Retry'
                    : 'Refresh docs';

              return (
                <SettingsRow
                  key={entry.repoId}
                  icon={<RepoIcon />}
                  label={entry.repoName}
                  subtitle={rx.phase === 'error' ? rx.message : subtitle}
                  accessory={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <ValuePill tone={status.tone}>{status.label}</ValuePill>
                      <RamsButton variant="ghost" disabled={busy} busy={busy} onClick={() => void runReindex(entry)}>
                        {actionLabel}
                      </RamsButton>
                    </span>
                  }
                  divider={i < entries.length - 1}
                />
              );
            })
          )}
        </SettingsGroup>
      </section>

      {/* ── Engineering Brain ────────────────────────────────────────── */}
      <section style={{ marginBottom: 28 }}>
        <SettingsGroup
          header="Engineering Brain"
          footnote="Repository answers can cite saved documentation, project guidance, and recorded task outcomes. These totals cover all connected repositories."
        >
          <SettingsRow
            icon={<DocIcon />}
            label="Saved instructions"
            subtitle="Documentation and project guidance available to repository answers"
            value={diagLoading ? '…' : diagnostics ? String(diagnostics.directivesCount ?? 0) : '—'}
            pill
            divider
          />
          <SettingsRow
            icon={<LedgerIcon />}
            label="Recorded task outcomes"
            subtitle="Completed agent sessions recorded as memory"
            value={diagLoading ? '…' : diagnostics ? String(diagnostics.outcomesCount ?? 0) : '—'}
            pill
            divider
          />
          <SettingsRow
            icon={<BrainIcon />}
            label="Knowledge storage"
            subtitle="Instructions and task history are stored locally"
            value="Local"
          />
        </SettingsGroup>
      </section>
      <KnowledgeSourcesSection />
      <ConversationImportSection />
    </div>
  );
}
