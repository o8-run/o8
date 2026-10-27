'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { requestPrompt } from '@/components/shared/ConfirmToastHost';
import { pickRepoFolder } from '@/components/desktop/repo-registry/pickRepoFolder';

const TARGET_OVERRIDE_KEY = 'o8:spec:target-override';
const TARGET_RECENTS_KEY = 'o8:spec:target-recents';
const TARGET_CHANGED_EVENT = 'o8:spec-target-changed';
const RECENTS_LIMIT = 6;

interface RepoChoice {
  name: string;
  localPath: string;
  exists?: boolean;
}

function trimPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '/' || /^[A-Za-z]:[\\/]$/.test(trimmed)) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

export function normalizeO8SpecTargetPath(raw: string): string | null {
  const trimmed = trimPath(raw);
  if (!trimmed) return null;
  const parts = trimmed.split(/[\\/]/);
  if (parts.at(-1)?.toLowerCase() !== 'o8.md') return trimmed;
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (separator < 0) return null;
  const parent = trimmed.slice(0, separator);
  if (/^[A-Za-z]:$/.test(parent)) return `${parent}${trimmed[separator]}`;
  return parent || '/';
}

function pathLabel(path: string | null): string {
  if (!path) return 'Choose o8.md';
  const trimmed = trimPath(path);
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? trimmed;
}

function readStoredTarget(): string | null {
  try {
    const raw = window.localStorage.getItem(TARGET_OVERRIDE_KEY);
    return raw ? normalizeO8SpecTargetPath(raw) : null;
  } catch {
    return null;
  }
}

function readRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(TARGET_RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed)
      ? parsed.filter((value) => typeof value === 'string').map(trimPath).filter(Boolean).slice(0, RECENTS_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function rememberTarget(path: string): void {
  try {
    const next = [path, ...readRecents().filter((candidate) => candidate !== path)].slice(0, RECENTS_LIMIT);
    window.localStorage.setItem(TARGET_RECENTS_KEY, JSON.stringify(next));
  } catch {
    // A selector that cannot remember recents still controls the current pane.
  }
}

function broadcastTarget(path: string | null): void {
  try {
    if (path) window.localStorage.setItem(TARGET_OVERRIDE_KEY, path);
    else window.localStorage.removeItem(TARGET_OVERRIDE_KEY);
  } catch { /* localStorage can be unavailable in hardened webviews */ }
  window.dispatchEvent(new CustomEvent(TARGET_CHANGED_EVENT, { detail: { path } }));
}

export function useO8SpecTarget(defaultRepoPath?: string | null) {
  const normalizedDefault = defaultRepoPath ? trimPath(defaultRepoPath) : null;
  const [overridePath, setOverridePath] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) setOverridePath(readStoredTarget()); });
    const handleChange = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string | null }>).detail;
      setOverridePath(typeof detail?.path === 'string' ? normalizeO8SpecTargetPath(detail.path) : null);
    };
    window.addEventListener(TARGET_CHANGED_EVENT, handleChange);
    return () => {
      active = false;
      window.removeEventListener(TARGET_CHANGED_EVENT, handleChange);
    };
  }, []);

  const selectTarget = useCallback((path: string) => {
    const normalized = normalizeO8SpecTargetPath(path);
    if (!normalized) return;
    rememberTarget(normalized);
    const next = normalizedDefault && normalized === normalizedDefault ? null : normalized;
    setOverridePath(next);
    broadcastTarget(next);
  }, [normalizedDefault]);

  const followActiveRepo = useCallback(() => {
    setOverridePath(null);
    broadcastTarget(null);
  }, []);

  return {
    repoPath: overridePath ?? normalizedDefault,
    overridePath,
    selectTarget,
    followActiveRepo,
  };
}

async function pickO8MdFile(): Promise<{ path: string | null; error: string | null }> {
  let selected: string | null = null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({
      directory: false,
      multiple: false,
      title: 'Choose an o8.md file',
      filters: [{ name: 'o8.md', extensions: ['md'] }],
    });
    if (typeof result === 'string') selected = result;
  } catch {
    try {
      const response = await fetch('/api/panel/file-io', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'pick' }),
      });
      const data = await response.json() as { path?: string | null; unavailable?: boolean };
      // No picker program on this host: fall through to typed path entry.
      if (data.unavailable) throw new Error('native picker unavailable');
      if (typeof data.path === 'string') selected = data.path;
    } catch {
      selected = await requestPrompt({
        title: 'Choose an o8.md file',
        message: 'Enter the absolute path to an o8.md file.',
        placeholder: '/path/to/repo/o8.md',
      });
    }
  }
  if (!selected) return { path: null, error: null };
  if (trimPath(selected).split(/[\\/]/).at(-1)?.toLowerCase() !== 'o8.md') {
    return { path: null, error: 'Choose the o8.md file itself.' };
  }
  return { path: normalizeO8SpecTargetPath(selected), error: null };
}

function CheckGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function O8SpecTargetPicker({
  repoPath,
  defaultRepoPath,
  overridePath,
  onSelect,
  onFollowActiveRepo,
  compact = false,
  disabled = false,
}: {
  repoPath: string | null;
  defaultRepoPath?: string | null;
  overridePath: string | null;
  onSelect: (path: string) => void;
  onFollowActiveRepo: () => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [repos, setRepos] = useState<RepoChoice[]>([]);
  const [recents, setRecents] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/panel/repos', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        setRepos(Array.isArray(data?.repos) ? data.repos : []);
      })
      .catch((fetchError) => {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : 'Could not load repositories.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const choices = useMemo(() => {
    const byPath = new Map<string, RepoChoice>();
    for (const repo of repos) {
      if (repo.exists === false) continue;
      byPath.set(trimPath(repo.localPath), repo);
    }
    for (const path of recents) {
      if (!byPath.has(path)) byPath.set(path, { name: pathLabel(path), localPath: path });
    }
    if (repoPath && !byPath.has(repoPath)) byPath.set(repoPath, { name: pathLabel(repoPath), localPath: repoPath });
    return [...byPath.values()];
  }, [recents, repoPath, repos]);

  const choose = useCallback((path: string) => {
    onSelect(path);
    setOpen(false);
  }, [onSelect]);

  const browseFolder = useCallback(async () => {
    const path = await pickRepoFolder('Choose a repository for o8.md', 'Enter the absolute path to a repository.');
    if (path) choose(path);
  }, [choose]);

  const browseFile = useCallback(async () => {
    const result = await pickO8MdFile();
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.path) choose(result.path);
  }, [choose]);

  const toggleOpen = useCallback(() => {
    if (disabled) return;
    const next = !open;
    if (next) {
      setRecents(readRecents());
      setLoading(true);
      setError(null);
    }
    setOpen(next);
  }, [disabled, open]);

  return (
    <div style={{ position: 'relative', display: 'inline-flex', minWidth: 0, flexShrink: 1 }}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={`o8.md target: ${repoPath ?? 'none'}`}
        aria-expanded={open}
        title={repoPath ?? 'Choose an o8.md target'}
        onClick={toggleOpen}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          minWidth: 0,
          maxWidth: compact ? 112 : 170,
          height: 24,
          paddingTop: 0,
          paddingRight: 7,
          paddingBottom: 0,
          paddingLeft: 8,
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: 'var(--t-divider-subtle)',
          borderRadius: 7,
          background: open ? 'var(--t-hover)' : 'transparent',
          color: 'var(--t-text-secondary)',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.55 : 1,
          fontFamily: 'var(--font-sans-system)',
          fontSize: compact ? 9.5 : 10.5,
          fontWeight: 350,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pathLabel(repoPath)}</span>
        <span style={{ display: 'inline-flex', flexShrink: 0 }}><ChevronGlyph /></span>
      </button>

      {open ? (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 59 }} />
          <div style={{
            position: 'absolute',
            top: 'calc(100% + 7px)',
            right: 0,
            zIndex: 60,
            width: 286,
            maxWidth: 'min(286px, calc(100vw - 32px))',
            maxHeight: 360,
            overflowY: 'auto',
            paddingTop: 6,
            paddingRight: 5,
            paddingBottom: 6,
            paddingLeft: 5,
            border: '1px solid var(--t-panel-border)',
            borderRadius: 13,
            background: 'var(--t-popover-surface)',
            boxShadow: 'var(--t-panel-shadow)',
            fontFamily: 'var(--font-sans-system)',
          }}>
            <div style={{ paddingTop: 2, paddingRight: 8, paddingBottom: 5, paddingLeft: 8, color: 'var(--t-text-faint)', fontSize: 9.5, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              o8.md target
            </div>
            {overridePath && defaultRepoPath ? (
              <TargetRow
                label="Follow active repo"
                detail={defaultRepoPath}
                active={false}
                onClick={() => { onFollowActiveRepo(); setOpen(false); }}
              />
            ) : null}
            {loading ? <div style={{ paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 10, color: 'var(--t-text-faint)', fontSize: 11 }}>Loading repositories…</div> : null}
            {!loading ? choices.map((choice) => (
              <TargetRow
                key={choice.localPath}
                label={choice.name}
                detail={choice.localPath}
                active={choice.localPath === repoPath}
                onClick={() => choose(choice.localPath)}
              />
            )) : null}
            <div style={{ height: 1, marginTop: 5, marginRight: 7, marginBottom: 5, marginLeft: 7, background: 'var(--t-divider-subtle)' }} />
            <TargetRow label="Choose repository folder…" detail="Use it without adding it to Projects" active={false} onClick={() => { void browseFolder(); }} />
            <TargetRow label="Choose o8.md file…" detail="Open the file directly from disk" active={false} onClick={() => { void browseFile(); }} />
            {error ? <div style={{ paddingTop: 6, paddingRight: 9, paddingBottom: 3, paddingLeft: 9, color: 'var(--t-brand-red)', fontSize: 10.5 }}>{error}</div> : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function TargetRow({
  label,
  detail,
  active,
  onClick,
}: {
  label: string;
  detail: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) 14px',
        alignItems: 'center',
        width: '100%',
        minHeight: 38,
        paddingTop: 5,
        paddingRight: 8,
        paddingBottom: 5,
        paddingLeft: 8,
        borderWidth: 0,
        borderRadius: 8,
        background: active ? 'var(--t-hover)' : 'transparent',
        color: active ? 'var(--t-text)' : 'var(--t-text-secondary)',
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'var(--font-sans-system)',
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = active ? 'var(--t-hover)' : 'transparent'; }}
    >
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, fontWeight: active ? 500 : 400 }}>{label}</span>
        <span style={{ display: 'block', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text-faint)', fontSize: 9.5 }}>{detail}</span>
      </span>
      <span style={{ display: 'inline-flex', color: 'var(--t-accent)', visibility: active ? 'visible' : 'hidden' }}><CheckGlyph /></span>
    </button>
  );
}
