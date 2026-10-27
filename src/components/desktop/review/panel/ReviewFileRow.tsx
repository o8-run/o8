/* eslint-disable react-hooks/set-state-in-effect -- the async per-file diff fetch intentionally toggles loading/error/diff state */
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from '../../lucide-shims';
import type { ReviewChangedFile } from '@/lib/fleet/types';
import type { DiffMode, CollapseSignal, LocalDiffComment, LocalCommentTarget } from './types';
import { UI_FONT, MONO_FONT, REVIEW_CONTROL_BG_ACTIVE } from './constants';
import { DiffStatBadge, IconCheck } from './icons';
import { DiffPatch, RowMessage } from './DiffView';
import { MarkdownRender } from '../../o8-panel/markdown-render';
import { isBinaryPatch, isDirectoryPatch, reviewFileKind, type ReviewFilePresentation } from '@/lib/review/file-presentation';
import { ReviewAssetSummary } from './ReviewAssetSummary';

/** Extensions that the "Rich preview" toggle (#1088) renders inline as
 *  rendered content instead of as a raw unified diff. Anything not in this
 *  set falls back to the normal diff path even when the toggle is on. */
const MARKDOWN_PREVIEW_EXTENSIONS = new Set(['.md', '.mdx']);
const IMAGE_PREVIEW_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp']);

type PreviewKind = 'markdown' | 'image' | null;

function previewKindFor(path: string): PreviewKind {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = path.slice(dot).toLowerCase();
  if (MARKDOWN_PREVIEW_EXTENSIONS.has(ext)) return 'markdown';
  if (IMAGE_PREVIEW_EXTENSIONS.has(ext)) return 'image';
  return null;
}

type PreviewPayload =
  | { kind: 'markdown'; content: string; truncated?: boolean }
  | { kind: 'image'; dataUrl: string }
  | { kind: 'svg'; markup: string }
  | { kind: 'deleted' };

/** One changed file: a collapsible header + an inline diff loaded on expand. */
const ReviewFileRow = memo(function ReviewFileRow({
  file,
  repoPath,
  diffBase,
  preloadedDiff,
  mode,
  wrap,
  wordDiff,
  hideWhitespace,
  richPreview,
  initialOpen,
  collapseSignal,
  focusSignal,
  selected,
  setRowRef,
}: {
  file: ReviewChangedFile;
  repoPath: string;
  /** #1293 — when set, fetch the COMMITTED diff (`<base>...HEAD`) instead of the
   *  working-tree diff vs HEAD. Used by the best-of-N compare matrix. */
  diffBase?: string;
  preloadedDiff?: string;
  mode: DiffMode;
  wrap: boolean;
  wordDiff: boolean;
  hideWhitespace: boolean;
  /** #1088: when true, applicable files (.md / .mdx / images) render as
   *  rendered content instead of as the raw diff. Non-applicable files
   *  continue to render as diffs. */
  richPreview: boolean;
  initialOpen: boolean;
  collapseSignal: CollapseSignal;
  focusSignal: { path: string | null; nonce: number };
  selected: boolean;
  setRowRef: (path: string, node: HTMLDivElement | null) => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [comments, setComments] = useState<LocalDiffComment[]>([]);
  const [activeComment, setActiveComment] = useState<LocalCommentTarget | null>(null);
  const [commentText, setCommentText] = useState('');
  const [sourceDiff, setSourceDiff] = useState(false);
  const [presentation, setPresentation] = useState<ReviewFilePresentation>({ kind: reviewFileKind(file.path) });
  const rowRef = useRef<HTMLDivElement>(null);
  const [previewVisible, setPreviewVisible] = useState(typeof IntersectionObserver === 'undefined');

  // #1088: applicable preview kind for this file (null = not previewable; the
  // toggle has no effect on this row and the diff renders as usual).
  const previewKind = previewKindFor(file.path);
  const historical = Boolean(diffBase || preloadedDiff !== undefined);
  const svg = file.path.toLowerCase().endsWith('.svg');
  const previewActive = !historical && !sourceDiff && file.status !== 'deleted' && (previewKind === 'image' || richPreview && previewKind === 'markdown');
  useEffect(() => {
    if (!open || !previewActive || previewKind !== 'image' || typeof IntersectionObserver === 'undefined') return;
    const node = rowRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setPreviewVisible(true); observer.disconnect(); } }, { rootMargin: '120px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [open, previewActive, previewKind]);

  // Apply the panel-level bulk collapse/expand signal only when it actually
  // changes — never on mount, so the #1084 `initialOpen` default holds.
  // Comparing the previous value (not a first-run flag) stays correct under
  // React StrictMode's double-invoked mount effects.
  const lastSignal = useRef(collapseSignal);
  useEffect(() => {
    if (collapseSignal !== lastSignal.current) {
      lastSignal.current = collapseSignal;
      setOpen(collapseSignal.open);
    }
  }, [collapseSignal]);

  useEffect(() => {
    if (focusSignal.path === file.path) setOpen(true);
  }, [file.path, focusSignal]);

  useEffect(() => {
    if (!open || previewActive) return;
    if (preloadedDiff !== undefined) {
      setLoading(false);
      setError(null);
      setDiff(preloadedDiff);
      setPresentation({ kind: isDirectoryPatch(preloadedDiff) ? 'directory' : isBinaryPatch(preloadedDiff) ? reviewFileKind(file.path) === 'text' ? 'binary' : reviewFileKind(file.path) : reviewFileKind(file.path) });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setDiff(null);
    const params = new URLSearchParams({ path: file.path, workspace: repoPath });
    if (hideWhitespace) params.set('ignoreWhitespace', '1');
    if (diffBase) params.set('base', diffBase);
    fetch(`/api/panel/file-diff?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as ReviewFilePresentation & { diff?: string; stagedDiff?: string; error?: string };
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        const patch = data.diff ?? data.stagedDiff ?? '';
        setPresentation({ kind: data.kind ?? (isDirectoryPatch(patch) ? 'directory' : isBinaryPatch(patch) ? 'binary' : reviewFileKind(file.path)), size: data.size, diffStatus: data.diffStatus });
        setDiff(patch);
      })
      .catch((err) => {
        if (!cancelled && (err as { name?: string })?.name !== 'AbortError') {
          setError(err instanceof Error ? err.message : 'Unable to load diff.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // file.additions/deletions are deps so the row re-fetches when
    // useWorkspaceChanges reports the file's diff stats changed (#1084).
  }, [open, previewActive, preloadedDiff, file.path, repoPath, diffBase, hideWhitespace, file.additions, file.deletions]);

  // #1088: rich-preview fetch. Renders the new version of the file as
  // rendered content (markdown / image) instead of the unified diff.
  // Triggered only when the toggle is on AND the file is applicable.
  useEffect(() => {
    if (!open || !previewActive || previewKind === 'image' && !previewVisible) return;
    let cancelled = false;
    const controller = new AbortController();
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);

    const params = new URLSearchParams({ path: file.path, workspace: repoPath });
    const endpoint = previewKind === 'image' ? '/api/panel/file-preview' : '/api/panel/file-content';

    fetch(`${endpoint}?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          throw new Error((data.error as string) || `HTTP ${response.status}`);
        }
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        if (previewKind === 'markdown') {
          const content = typeof data.content === 'string' ? data.content : '';
          setPreview({ kind: 'markdown', content, truncated: Boolean(data.truncated) });
        } else if (previewKind === 'image') {
          setPresentation({ kind: 'image', size: typeof data.size === 'number' ? data.size : undefined });
          if (data.type === 'svg' && typeof data.content === 'string') {
            setPreview({ kind: 'svg', markup: data.content });
          } else if (typeof data.dataUrl === 'string') {
            setPreview({ kind: 'image', dataUrl: data.dataUrl });
          } else {
            throw new Error('Unexpected image response shape.');
          }
        }
      })
      .catch((err) => {
        if (!cancelled && (err as { name?: string })?.name !== 'AbortError') {
          setPreviewError(err instanceof Error ? err.message : 'Unable to load preview.');
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, previewActive, previewKind, previewVisible, file.path, repoPath, file.additions, file.deletions]);

  const openComment = useCallback((target: LocalCommentTarget) => {
    setActiveComment(target);
    setCommentText('');
  }, []);

  const cancelComment = useCallback(() => {
    setActiveComment(null);
    setCommentText('');
  }, []);

  const saveComment = useCallback(() => {
    const body = commentText.trim();
    if (!activeComment || !body) return;
    setComments((current) => [
      ...current,
      {
        id: `${activeComment.key}:${Date.now()}`,
        key: activeComment.key,
        label: activeComment.label,
        body,
        createdAt: Date.now(),
      },
    ]);
    setActiveComment(null);
    setCommentText('');
  }, [activeComment, commentText]);

  return (
    <div
      data-review-file={file.path}
      ref={(node) => { rowRef.current = node; setRowRef(file.path, node); }}
      style={{
        borderBottom: '1px solid var(--t-divider-subtle)',
        background: selected ? 'var(--t-hover)' : 'transparent',
        scrollMarginTop: 46,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={file.path}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 14, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
      >
        <span style={{ color: 'var(--t-text-faint)', display: 'inline-flex', flexShrink: 0 }}>
          {open ? <ChevronDown size={12} strokeWidth={2} /> : <ChevronRight size={12} strokeWidth={2} />}
        </span>
        <span style={{ flex: 1, minWidth: 0, fontFamily: MONO_FONT, fontSize: 12, color: 'var(--t-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}>
          <bdi dir="ltr">{file.path}</bdi>
        </span>
        {presentation.kind && presentation.kind !== 'text' && presentation.kind !== 'symlink' ? <span style={{ fontFamily: UI_FONT, color: 'var(--t-text-faint)', fontSize: 10, textTransform: 'capitalize', flexShrink: 0 }}>{file.status} · {presentation.kind === 'directory' ? 'Folder' : presentation.kind}</span> : <DiffStatBadge additions={file.additions ?? 0} deletions={file.deletions ?? 0} />}
      </button>
      {open && svg && !historical && file.status !== 'deleted' ? <div aria-label="Image view" style={{ display: 'flex', gap: 4, paddingLeft: 16, paddingBottom: 8 }}>
        {[false, true].map((source) => <button key={String(source)} type="button" aria-pressed={sourceDiff === source} onClick={() => setSourceDiff(source)} style={{ minHeight: 24, paddingLeft: 8, paddingRight: 8, border: 0, borderRadius: 6, background: sourceDiff === source ? 'var(--t-hover)' : 'transparent', color: sourceDiff === source ? 'var(--t-text)' : 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 11, cursor: 'pointer' }}>{source ? 'Source diff' : 'Preview'}</button>)}
      </div> : null}
      {open ? (
        previewActive ? (
          previewKind === 'image' && !previewVisible ? <div style={{ minHeight: 140, display: 'grid', placeItems: 'center', fontSize: 11, color: 'var(--t-text-faint)' }}>Image preview</div> : previewLoading ? (
            <RowMessage text="Loading preview…" />
          ) : previewError ? (
            <ReviewAssetSummary presentation={presentation} path={file.path} repoPath={repoPath} error={previewError} />
          ) : preview ? (
            <><RichPreviewBody payload={preview} fileName={file.path.split('/').pop() ?? file.path} />{previewKind === 'image' ? <div style={{ paddingLeft: 16, paddingBottom: 12 }}><button type="button" onClick={() => window.dispatchEvent(new CustomEvent('o8:browse-review-file', { detail: { repoPath, path: file.path } }))} style={{ padding: 0, border: 0, background: 'transparent', fontFamily: UI_FONT, fontSize: 11, color: 'var(--t-accent)', cursor: 'pointer' }}>Open in Files</button></div> : null}</>
          ) : (
            <RowMessage text="No preview available." />
          )
        ) : loading ? (
          <RowMessage text="Loading diff…" />
        ) : error ? (
          <RowMessage text={error} tone="error" />
        ) : presentation.kind === 'directory' || presentation.diffStatus === 'binary' || presentation.diffStatus === 'too_large' || (presentation.kind && !['text', 'symlink'].includes(presentation.kind) && !(diff && /^@@/m.test(diff) && !isBinaryPatch(diff))) || diff && (isBinaryPatch(diff) || isDirectoryPatch(diff)) ? (
          <ReviewAssetSummary presentation={presentation} path={file.path} repoPath={repoPath} deleted={file.status === 'deleted'} historical={historical} />
        ) : diff && diff.trim() ? (
          <><DiffPatch
            patch={diff}
            mode={mode}
            wrap={wrap}
            wordDiff={wordDiff}
            comments={comments}
            activeComment={activeComment}
            commentText={commentText}
            onOpenComment={openComment}
            onCommentTextChange={setCommentText}
            onCancelComment={cancelComment}
            onSaveComment={saveComment}
          />{presentation.diffStatus === 'truncated' ? <ReviewAssetSummary presentation={{ ...presentation, diffStatus: 'too_large' }} path={file.path} repoPath={repoPath} error="Showing the first 50 KB of this diff. Open the file for the remaining content." historical={historical} /> : null}</>
        ) : (
          <ReviewAssetSummary presentation={presentation} path={file.path} repoPath={repoPath} deleted={file.status === 'deleted'} historical={historical} />
        )
      ) : null}
    </div>
  );
});

// ── rich preview body (#1088) ──

function RichPreviewBody({ payload, fileName }: { payload: PreviewPayload; fileName: string }) {
  if (payload.kind === 'markdown') {
    return (
      <div style={{ paddingTop: 8, paddingBottom: 16, paddingLeft: 16, paddingRight: 16 }}>
        <MarkdownRender content={payload.content} />
        {payload.truncated ? (
          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--t-text-faint)', fontFamily: UI_FONT }}>
            … (truncated at 100KB)
          </div>
        ) : null}
      </div>
    );
  }
  if (payload.kind === 'image') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-start', paddingTop: 12, paddingBottom: 16, paddingLeft: 16, paddingRight: 16 }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- data URL, not a remote asset */}
        <img src={payload.dataUrl} alt={fileName} loading="lazy" style={{ maxWidth: '100%', maxHeight: 240, objectFit: 'contain', height: 'auto', borderRadius: 6, border: '1px solid var(--t-divider-subtle)' }} />
      </div>
    );
  }
  if (payload.kind === 'svg') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 12, paddingBottom: 16, paddingLeft: 16, paddingRight: 16 }}>
        {/* Render SVG as a data URL rather than dangerouslySetInnerHTML: a
            file from the branch under review is untrusted input, and an <img>
            loads SVG in script-disabled static mode (no inline scripts/handlers
            execute), unlike raw HTML injection. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- data URL, not a remote asset */}
        <img
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(payload.markup)}`}
          alt={fileName}
          loading="lazy"
          style={{ maxWidth: '100%', maxHeight: 240, objectFit: 'contain', height: 'auto' }}
        />
      </div>
    );
  }
  return <RowMessage text="File deleted — no preview." />;
}

// ── header toolbar ──

function ToolbarButton({ active, title, onClick, children }: { active?: boolean; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        padding: 0,
        border: 'none',
        borderRadius: 8,
        background: active ? REVIEW_CONTROL_BG_ACTIVE : 'transparent',
        color: active ? 'var(--t-text)' : 'var(--t-text-muted)',
        cursor: 'pointer',
        flexShrink: 0,
      }}
      onMouseEnter={(event) => { if (!active) event.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(event) => { if (!active) event.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

/** One row of the `···` overflow menu. Toggle items pass `checked`; plain actions omit it. */
function MenuItem({ onClick, checked, children }: { onClick: () => void; checked?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        height: 30,
        paddingLeft: 9,
        paddingRight: 8,
        border: 'none',
        borderRadius: 7,
        background: 'transparent',
        color: 'var(--t-text)',
        fontFamily: UI_FONT,
        fontSize: 12,
        cursor: 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {checked !== undefined ? (
        <span style={{ display: 'inline-flex', width: 14, justifyContent: 'center', color: checked ? 'var(--t-accent)' : 'transparent' }}>
          <IconCheck size={13} />
        </span>
      ) : null}
    </button>
  );
}

function fileDisplayParts(path: string) {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop() ?? path;
  const folder = parts.join('/');
  return { folder, name };
}

export { ReviewFileRow, ToolbarButton, MenuItem, fileDisplayParts };
