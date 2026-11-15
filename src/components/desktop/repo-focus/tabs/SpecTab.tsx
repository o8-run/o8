'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RepoFocusRepo } from '../types';

interface SpecTabProps {
  repo: RepoFocusRepo;
  onOpenInWorkspace?: (repoPath: string) => void;
}

const SAVE_DEBOUNCE_MS = 800;
// Save guard — refuse to persist when the new content is trivially small
// AND the prior on-disk content was meaningful. Stops a stray keystroke
// from clobbering a real spec. Operator can override via "Save anyway".
const GUARD_MIN_BODY_CHARS = 8;
const GUARD_PRIOR_THRESHOLD_CHARS = 100;

function nonWhitespaceLength(value: string): number {
  return value.replace(/\s+/g, '').length;
}

export function SpecTab({ repo, onOpenInWorkspace }: SpecTabProps) {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [savePending, setSavePending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Tracks the meaningful prior content length captured when the file
  // was loaded. Used by the small-save guard to decide whether a tiny
  // incoming write looks accidental.
  const priorBodyLengthRef = useRef<number>(0);
  const guardOverrideRef = useRef<boolean>(false);
  const [guardedDraft, setGuardedDraft] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);
  const repoPath = repo.localPath;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setGuardedDraft(null);
    guardOverrideRef.current = false;
    const url = `/api/repo-spec?repoPath=${encodeURIComponent(repoPath)}`;
    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.ok && typeof data.content === 'string') {
          setContent(data.content);
          // Only trip the guard when the prior FILE existed on disk
          // (data.exists === true). When the route synthesised the
          // default template because no file was present, the operator
          // is starting from a blank slate and any save is intentional.
          priorBodyLengthRef.current = data.exists === true
            ? nonWhitespaceLength(data.content)
            : 0;
        } else {
          setError(data?.error || 'Failed to load o8.md');
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [repoPath]);

  const persist = useCallback((next: string) => {
    setSavePending(true);
    setError(null);
    fetch(`/api/repo-spec?repoPath=${encodeURIComponent(repoPath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: next }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data?.ok) {
          setSavedAt(Date.now());
          // After a successful save, the new on-disk length becomes the
          // prior baseline for the next guard decision.
          priorBodyLengthRef.current = nonWhitespaceLength(next);
        } else {
          setError(data?.error || 'Save failed');
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setSavePending(false);
      });
  }, [repoPath]);

  const shouldGuard = useCallback((next: string): boolean => {
    if (guardOverrideRef.current) return false;
    const body = nonWhitespaceLength(next);
    return body < GUARD_MIN_BODY_CHARS && priorBodyLengthRef.current > GUARD_PRIOR_THRESHOLD_CHARS;
  }, []);

  const handleChange = useCallback((next: string) => {
    setContent(next);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      if (shouldGuard(next)) {
        setGuardedDraft(next);
        return;
      }
      setGuardedDraft(null);
      persist(next);
    }, SAVE_DEBOUNCE_MS) as unknown as number;
  }, [persist, shouldGuard]);

  const handleSaveAnyway = useCallback(() => {
    if (guardedDraft === null) return;
    guardOverrideRef.current = true;
    const draft = guardedDraft;
    setGuardedDraft(null);
    persist(draft);
  }, [guardedDraft, persist]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, []);

  const status = (() => {
    if (savePending) return 'Saving…';
    if (error) return error;
    if (guardedDraft !== null) return 'Save guarded — content much shorter than the saved spec';
    if (savedAt) {
      // eslint-disable-next-line react-hooks/purity -- the saved age is read at render time on purpose; it refreshes on the next edit or save
      const seconds = Math.max(0, Math.floor((Date.now() - savedAt) / 1000));
      if (seconds < 5) return 'Saved';
      if (seconds < 60) return `Saved ${seconds}s ago`;
      return `Saved ${Math.floor(seconds / 60)}m ago`;
    }
    return 'o8.md · agents read & write this';
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--t-divider)',
          fontSize: 11,
          color: 'var(--t-text-muted)',
          fontFamily: 'var(--font-sans-system)',
          letterSpacing: '-0.005em',
        }}
      >
        <span style={{ color: error ? '#dc2626' : guardedDraft !== null ? '#b45309' : 'var(--t-text-muted)' }}>{status}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {guardedDraft !== null ? (
            <button
              type="button"
              onClick={handleSaveAnyway}
              style={{
                border: '1px solid rgba(180, 83, 9, 0.32)',
                background: 'rgba(180, 83, 9, 0.08)',
                color: '#b45309',
                fontSize: 10.5,
                fontWeight: 600,
                cursor: 'pointer',
                paddingTop: 2,
                paddingRight: 8,
                paddingBottom: 2,
                paddingLeft: 8,
                borderRadius: 6,
                fontFamily: 'inherit',
                letterSpacing: '0.02em',
                textTransform: 'uppercase',
              }}
              title="The new content is much shorter than the saved spec — confirm to overwrite."
            >
              Save anyway
            </button>
          ) : null}
          {onOpenInWorkspace ? (
            <button
              type="button"
              onClick={() => onOpenInWorkspace(repoPath)}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--t-text-muted)',
                fontSize: 11,
                fontWeight: 500,
                cursor: 'pointer',
                paddingTop: 2,
                paddingRight: 6,
                paddingBottom: 2,
                paddingLeft: 6,
                borderRadius: 6,
                fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--t-text)'; e.currentTarget.style.background = 'var(--t-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--t-text-muted)'; e.currentTarget.style.background = 'transparent'; }}
            >
              Open in workspace
            </button>
          ) : null}
        </div>
      </div>
      {loading ? (
        <div style={{ padding: 16, fontSize: 12, color: 'var(--t-text-muted)' }}>Loading o8.md…</div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => handleChange(e.target.value)}
          spellCheck={false}
          style={{
            flex: 1,
            minHeight: 0,
            border: 'none',
            outline: 'none',
            // Solid paper-tinted background so light-mode text doesn't read
            // as white-on-white. The transparent fallback bled into the
            // canvas-bg in some themes; explicit input-bg is reliable.
            background: 'var(--t-input-bg)',
            color: 'var(--t-text)',
            caretColor: 'var(--t-text)',
            padding: '12px 14px',
            fontSize: 12,
            lineHeight: 1.55,
            fontFamily: '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace',
            resize: 'none',
            tabSize: 2,
          }}
          placeholder="# o8.md — mission, scope, constraints, and open questions for this repo. Agents read and write here."
        />
      )}
    </div>
  );
}
