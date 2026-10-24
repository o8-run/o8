'use client';

/**
 * MobileDiffViewer — read-only bottom-sheet inline diff for approvals,
 * PR cards, and agent transcripts. Renders per-file headers + +/- coloured
 * hunk lines + line numbers + binary fallback. Uses the canonical
 * `parseDiff()` from `@/lib/llm/diff-parse` (no extra parser bundle).
 *
 * Mental model: read-only. Mobile is the operator's remote control —
 * editing diffs lives on desktop.
 */

import { PullRequestConversations } from '@/components/conversation-prs/PullRequestConversations';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { PrStackSummary } from '@/components/desktop/agent-panel/PrStackSummary';
import { useTheme } from './ThemeContext';
import { parseDiff, type ParsedDiffFile, type ParsedDiffHunk } from '@/lib/llm/diff-parse';
import { fetchMobileDiff, type MobileDiffPayload, type MobileDiffSource } from '@/lib/mobile/diff-fetch';

interface MobileDiffViewerProps {
  open: boolean;
  onClose: () => void;
  source: MobileDiffSource | null;
  title: string;
  subtitle?: string;
}

function fileAnchorId(filePath: string): string {
  return `mdv-file-${filePath.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
}

function isBinaryHunkText(file: ParsedDiffFile, rawSection: string | null): boolean {
  if (file.hunks.length > 0) return false;
  if (!rawSection) return false;
  return /^Binary files .* differ$/m.test(rawSection);
}

function extractFileSection(rawDiff: string, filePath: string): string | null {
  if (!rawDiff || !filePath) return null;
  const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n)diff --git a/${escaped} b/${escaped}\\b[\\s\\S]*?(?=(\\ndiff --git |$))`);
  const match = rawDiff.match(re);
  return match ? match[0].replace(/^\n/, '') : null;
}

const MAX_INITIAL_HUNK_LINES = 80;

const HunkBlock = memo(function HunkBlock({
  hunk,
  startCollapsed,
  monoBg,
  addBg,
  delBg,
  contextColor,
  numberColor,
  textColor,
  expandLabelColor,
  expandBg,
}: {
  hunk: ParsedDiffHunk;
  startCollapsed: boolean;
  monoBg: string;
  addBg: string;
  delBg: string;
  contextColor: string;
  numberColor: string;
  textColor: string;
  expandLabelColor: string;
  expandBg: string;
}) {
  const [expanded, setExpanded] = useState(!startCollapsed);
  const lines = hunk.lines;
  const visibleLines = expanded ? lines : lines.slice(0, MAX_INITIAL_HUNK_LINES);
  const hidden = Math.max(0, lines.length - visibleLines.length);

  let oldNumber = hunk.startOldLine - 1;
  let newNumber = hunk.startNewLine - 1;

  return (
    <div
      style={{
        background: monoBg,
        borderRadius: 8,
        overflow: 'hidden',
        marginBottom: 10,
      }}
    >
      <div
        style={{
          paddingTop: 6,
          paddingBottom: 6,
          paddingLeft: 10,
          paddingRight: 10,
          fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
          fontSize: 11,
          color: contextColor,
          background: expandBg,
        }}
      >
        {hunk.header}
      </div>
      <div style={{ display: 'block' }}>
        {visibleLines.map((line, idx) => {
          const isAdd = line.startsWith('+') && !line.startsWith('+++');
          const isDel = line.startsWith('-') && !line.startsWith('---');
          const isContext = !isAdd && !isDel;
          if (isAdd) newNumber += 1;
          else if (isDel) oldNumber += 1;
          else { oldNumber += 1; newNumber += 1; }
          const oldCell = isAdd ? '' : String(oldNumber);
          const newCell = isDel ? '' : String(newNumber);
          const bg = isAdd ? addBg : isDel ? delBg : 'transparent';
          return (
            <div
              key={idx}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                background: bg,
                fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
                fontSize: 11.5,
                lineHeight: 1.55,
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: 36,
                  textAlign: 'right',
                  paddingRight: 6,
                  paddingLeft: 4,
                  color: numberColor,
                  userSelect: 'none',
                }}
              >
                {oldCell}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  width: 36,
                  textAlign: 'right',
                  paddingRight: 8,
                  color: numberColor,
                  userSelect: 'none',
                }}
              >
                {newCell}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  paddingRight: 8,
                  color: isContext ? contextColor : textColor,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {line || ' '}
              </span>
            </div>
          );
        })}
        {hidden > 0 ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            onTouchEnd={(event) => {
              setExpanded(true);
              event.preventDefault();
            }}
            style={{
              width: '100%',
              minHeight: 36,
              border: 'none',
              background: expandBg,
              color: expandLabelColor,
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
            }}
          >
            Expand {hidden} more line{hidden === 1 ? '' : 's'}
          </button>
        ) : null}
      </div>
    </div>
  );
});

export const MobileDiffViewer = memo(function MobileDiffViewer({
  open,
  onClose,
  source: initialSource,
  title,
  subtitle,
}: MobileDiffViewerProps) {
  const { colors } = useTheme();
  const owner = JSON.stringify(initialSource?.kind === 'pr' ? ['pr', initialSource.repo.toLowerCase(), initialSource.number]
    : [initialSource?.kind, initialSource?.sessionKey, initialSource?.worktreePath, initialSource?.baseBranch]);
  const [selection, setSelection] = useState<{ owner: string; source: MobileDiffSource | null }>({ owner, source: initialSource });
  const source = selection.owner === owner ? selection.source : initialSource;
  if (selection.owner !== owner) setSelection({ owner, source: initialSource });
  const [result, setResult] = useState<{ source: MobileDiffSource; payload: MobileDiffPayload } | null>(null);
  const activeResult = open && source && result?.source === source ? result : null;
  const payload = activeResult?.payload ?? null;
  const layer = source?.kind === 'pr' ? payload?.stack?.snapshot?.layers.find(layer => layer.number === source.number) : undefined;
  const navigated = source?.kind === 'pr' && initialSource?.kind === 'pr' && source.number !== initialSource.number;
  const displayTitle = navigated ? `PR #${source.number}${layer ? ` · ${layer.title}` : ''}` : title;
  const displaySubtitle = navigated ? `${source.repo} #${source.number}` : subtitle;
  const loading = Boolean(open && source && !activeResult);
  const error = activeResult?.payload.error && !activeResult.payload.rawDiff
    ? activeResult.payload.error
    : null;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || !source) return;
    let cancelled = false;
    void fetchMobileDiff(source).then((result) => {
      if (cancelled) return;
      setResult({ source, payload: result });
    });
    return () => { cancelled = true; };
  }, [open, source]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const parsedFiles = useMemo<ParsedDiffFile[]>(
    () => (payload?.rawDiff ? parseDiff(payload.rawDiff) : []),
    [payload?.rawDiff],
  );

  const stats = useMemo(() => {
    if (!payload) return { additions: 0, deletions: 0, fileCount: 0 };
    return {
      additions: payload.additions,
      deletions: payload.deletions,
      fileCount: payload.fileCount || parsedFiles.length,
    };
  }, [payload, parsedFiles.length]);

  const handleBackdropClick = useCallback((event: React.MouseEvent) => {
    if (event.target === event.currentTarget) onClose();
  }, [onClose]);

  const jumpToFile = useCallback((filePath: string) => {
    const root = scrollRef.current;
    if (!root) return;
    const target = root.querySelector(`#${fileAnchorId(filePath)}`);
    if (target instanceof HTMLElement) {
      root.scrollTo({ top: target.offsetTop - 8, behavior: 'smooth' });
    }
  }, []);

  const sheetStyle: CSSProperties = {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: '92vh',
    minHeight: '60vh',
    background: colors.frostStrong,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    transform: open ? 'translateY(0)' : 'translateY(100%)',
    transition: 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1)',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 -8px 32px rgba(0,0,0,0.18)',
    paddingBottom: 'env(safe-area-inset-bottom, 0px)',
  };

  const isDark = colors.bg !== '#f5f3ef';
  const monoBg = isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)';
  const addBg = isDark ? 'rgba(48,209,88,0.12)' : 'rgba(22,163,74,0.10)';
  const delBg = isDark ? 'rgba(255,69,58,0.14)' : 'rgba(220,38,38,0.10)';
  const contextColor = colors.textSecondary;
  const numberColor = colors.textTertiary;
  const expandBg = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Diff viewer: ${displayTitle}`}
      onClick={handleBackdropClick}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(0,0,0,0.4)',
        opacity: open ? 1 : 0,
        pointerEvents: open ? 'auto' : 'none',
        transition: 'opacity 240ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <div style={sheetStyle} onClick={(event) => event.stopPropagation()}>
        <div
          style={{
            paddingTop: 14,
            paddingRight: 16,
            paddingBottom: 12,
            paddingLeft: 16,
            borderBottomWidth: 1,
            borderBottomStyle: 'solid',
            borderBottomColor: colors.border,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: colors.text,
                letterSpacing: '-0.01em',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {displayTitle}
            </div>
            <div
              style={{
                fontSize: 11,
                color: colors.textSecondary,
                marginTop: 2,
                fontWeight: 500,
                fontFamily: '"SF Mono", ui-monospace, monospace',
              }}
            >
              {stats.fileCount} file{stats.fileCount === 1 ? '' : 's'} changed
              <span style={{ color: '#30d158', marginLeft: 8 }}>+{stats.additions}</span>
              <span style={{ color: '#ff453a', marginLeft: 6 }}>−{stats.deletions}</span>
              {displaySubtitle ? <span style={{ marginLeft: 8, color: colors.textTertiary }}>· {displaySubtitle}</span> : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close diff"
            style={{
              minWidth: 60,
              minHeight: 32,
              borderRadius: 16,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: colors.surfaceBorder,
              background: 'transparent',
              color: colors.textSecondary,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              flexShrink: 0,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Done
          </button>
        </div>

        {source?.kind === 'pr' ? <PullRequestConversations repo={source.repo} number={source.number} active={open} mobile onOpen={onClose} /> : null}
        {parsedFiles.length > 1 ? (
          <div
            style={{
              paddingTop: 8,
              paddingBottom: 8,
              paddingLeft: 12,
              paddingRight: 12,
              borderBottomWidth: 1,
              borderBottomStyle: 'solid',
              borderBottomColor: colors.border,
              display: 'flex',
              gap: 6,
              overflowX: 'auto',
              flexShrink: 0,
              WebkitOverflowScrolling: 'touch',
            }}
          >
            {parsedFiles.map((file) => (
              <button
                key={file.filePath}
                type="button"
                onClick={() => jumpToFile(file.filePath)}
                onTouchEnd={(event) => {
                  jumpToFile(file.filePath);
                  event.preventDefault();
                }}
                style={{
                  flexShrink: 0,
                  minHeight: 32,
                  paddingTop: 6,
                  paddingBottom: 6,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: colors.cardBorder,
                  background: colors.cardBg,
                  color: colors.textSecondary,
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: '"SF Mono", ui-monospace, monospace',
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                  touchAction: 'manipulation',
                  whiteSpace: 'nowrap',
                  maxWidth: 220,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {file.filePath.split('/').pop()}
              </button>
            ))}
          </div>
        ) : null}

        <div
          ref={scrollRef}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            paddingTop: 12,
            paddingRight: 12,
            paddingBottom: 12,
            paddingLeft: 12,
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {payload?.stack && source?.kind === 'pr' ? <PrStackSummary observation={payload.stack} prNumber={source.number} repo={source.repo}
            onSelect={number => setSelection({ owner, source: { kind: 'pr', repo: source.repo, number } })} /> : null}
          {loading && !payload ? (
            <div
              style={{
                fontSize: 12,
                color: colors.textTertiary,
                fontStyle: 'italic',
                marginTop: 24,
                textAlign: 'center',
              }}
            >
              Loading diff…
            </div>
          ) : null}

          {error && !loading ? (
            <div
              style={{
                paddingTop: 10,
                paddingBottom: 10,
                paddingLeft: 12,
                paddingRight: 12,
                borderRadius: 10,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'rgba(255,69,58,0.3)',
                background: 'rgba(255,69,58,0.08)',
                color: '#FF8A80',
                fontSize: 12,
                lineHeight: 1.45,
              }}
            >
              {error}
            </div>
          ) : null}

          {!loading && !error && parsedFiles.length === 0 ? (
            <div
              style={{
                fontSize: 13,
                color: colors.textTertiary,
                marginTop: 32,
                textAlign: 'center',
                maxWidth: 280,
                marginLeft: 'auto',
                marginRight: 'auto',
              }}
            >
              No diff to show. The agent may not have produced changes yet, or the source is unavailable.
            </div>
          ) : null}

          {parsedFiles.map((file) => {
            const rawSection = payload ? extractFileSection(payload.rawDiff, file.filePath) : null;
            const binary = isBinaryHunkText(file, rawSection);
            return (
              <div
                key={file.filePath}
                id={fileAnchorId(file.filePath)}
                style={{ marginBottom: 18 }}
              >
                <div
                  style={{
                    position: 'sticky',
                    top: 0,
                    zIndex: 1,
                    background: colors.frostStrong,
                    paddingTop: 6,
                    paddingBottom: 6,
                    fontSize: 12,
                    fontWeight: 700,
                    color: colors.text,
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    wordBreak: 'break-all',
                  }}
                >
                  {file.filePath}
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: 10,
                      color: colors.textTertiary,
                      fontWeight: 500,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}
                  >
                    {file.status}
                  </span>
                </div>

                {binary ? (
                  <div
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      background: monoBg,
                      color: colors.textSecondary,
                      fontSize: 12,
                      fontStyle: 'italic',
                    }}
                  >
                    Binary file changed
                  </div>
                ) : file.hunks.length === 0 ? (
                  <div
                    style={{
                      padding: '10px 12px',
                      borderRadius: 8,
                      background: monoBg,
                      color: colors.textTertiary,
                      fontSize: 12,
                    }}
                  >
                    No textual changes.
                  </div>
                ) : (
                  file.hunks.map((hunk, idx) => (
                    <HunkBlock
                      key={`${file.filePath}-${idx}`}
                      hunk={hunk}
                      startCollapsed={hunk.lines.length > MAX_INITIAL_HUNK_LINES}
                      monoBg={monoBg}
                      addBg={addBg}
                      delBg={delBg}
                      contextColor={contextColor}
                      numberColor={numberColor}
                      textColor={colors.text}
                      expandLabelColor={colors.textSecondary}
                      expandBg={expandBg}
                    />
                  ))
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
