import { useMemo, type CSSProperties } from 'react';
import { splitUnifiedDiff, diffLineTone, wordDiffSegments, type DiffLine, type WordSegment } from '../../o8-panel/diff-render';
import type { DiffMode, LocalDiffComment, LocalCommentTarget } from './types';
import { UI_FONT, MONO_FONT, NUM_CELL } from './constants';

function lineAnchor(line: DiffLine | null): string | undefined {
  if (!line) return undefined;
  if (line.newNumber !== null) return `R:${line.newNumber}`;
  if (line.oldNumber !== null) return `L:${line.oldNumber}`;
  return `${line.kind}:${line.text}`;
}

function lineCommentTarget(line: DiffLine, index: number): LocalCommentTarget {
  const side = line.kind === 'del' ? 'L' : 'R';
  const number = line.kind === 'del' ? line.oldNumber : line.newNumber ?? line.oldNumber;
  const label = `${side}${number ?? index + 1}`;
  return { key: `${side}:${number ?? index}`, label };
}

function LocalCommentComposer({
  label,
  value,
  onChange,
  onCancel,
  onSave,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div style={{ paddingTop: 9, paddingRight: 14, paddingBottom: 10, paddingLeft: 48, background: 'var(--t-bg-card)' }}>
      <div style={{ overflow: 'hidden', borderRadius: 14, border: '1px solid var(--t-divider-subtle)', background: 'var(--t-bg)', boxShadow: '0 10px 26px rgba(15, 23, 42, 0.08)' }}>
        <div style={{ display: 'flex', alignItems: 'center', minHeight: 38, paddingLeft: 12, paddingRight: 12, borderBottom: '1px solid var(--t-divider-subtle)' }}>
          <span style={{ flex: 1, fontFamily: UI_FONT, fontSize: 13.5, fontWeight: 350, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>Local comment</span>
          <span style={{ fontFamily: UI_FONT, fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-faint)' }}>Comment on line {label}</span>
        </div>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Request change"
          autoFocus
          rows={3}
          style={{
            display: 'block',
            width: '100%',
            resize: 'vertical',
            minHeight: 82,
            paddingTop: 10,
            paddingRight: 12,
            paddingBottom: 8,
            paddingLeft: 12,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'var(--t-text)',
            fontFamily: UI_FONT,
            fontSize: 12,
            lineHeight: '18px',
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 0, paddingRight: 10, paddingBottom: 10, paddingLeft: 10 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{ height: 28, paddingLeft: 10, paddingRight: 10, border: 'none', borderRadius: 8, background: 'transparent', color: 'var(--t-text-muted)', fontFamily: UI_FONT, fontSize: 11.5, fontWeight: 300, letterSpacing: '-0.1px', cursor: 'pointer' }}
            onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!value.trim()}
            style={{ height: 28, paddingLeft: 12, paddingRight: 12, border: 'none', borderRadius: 8, background: value.trim() ? 'var(--t-text)' : 'var(--t-hover)', color: value.trim() ? 'var(--t-bg)' : 'var(--t-text-faint)', fontFamily: UI_FONT, fontSize: 11.5, fontWeight: 400, letterSpacing: '-0.1px', cursor: value.trim() ? 'pointer' : 'default' }}
          >
            Comment
          </button>
        </div>
      </div>
    </div>
  );
}

function LocalCommentNote({ comment }: { comment: LocalDiffComment }) {
  return (
    <div style={{ paddingTop: 7, paddingRight: 14, paddingBottom: 7, paddingLeft: 48, background: 'var(--t-bg-card)' }}>
      <div style={{ borderRadius: 11, border: '1px solid var(--t-divider-subtle)', background: 'var(--t-bg-subtle)', paddingTop: 8, paddingRight: 10, paddingBottom: 8, paddingLeft: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontFamily: UI_FONT, fontSize: 11.5, fontWeight: 350, letterSpacing: '-0.1px', color: 'var(--t-text)' }}>Local comment</span>
          <span style={{ fontFamily: MONO_FONT, fontSize: 9.5, fontWeight: 260, letterSpacing: '-0.4px', color: 'var(--t-text-faint)' }}>{comment.label}</span>
        </div>
        <div style={{ whiteSpace: 'pre-wrap', fontFamily: UI_FONT, fontSize: 12, lineHeight: '18px', color: 'var(--t-text)' }}>{comment.body}</div>
      </div>
    </div>
  );
}

// ── diff rendering ──

/** Renders a diff line's text with word-level change segments highlighted. */
function WordDiffText({ line, segments }: { line: DiffLine; segments: WordSegment[] }) {
  const strong = line.kind === 'add'
    ? 'color-mix(in srgb, var(--t-terminal-ansi-green, #16a34a) 40%, transparent)'
    : 'color-mix(in srgb, var(--t-brand-red, #ef4444) 40%, transparent)';
  return (
    <>
      <span>{line.text.slice(0, 1)}</span>
      {segments.map((segment, index) => (
        <span key={index} style={segment.changed ? { background: strong, borderRadius: 2 } : undefined}>
          {segment.text}
        </span>
      ))}
    </>
  );
}

function UnifiedDiff({
  lines,
  wrap,
  segMap,
  comments,
  activeComment,
  commentText,
  onOpenComment,
  onCommentTextChange,
  onCancelComment,
  onSaveComment,
}: {
  lines: DiffLine[];
  wrap: boolean;
  segMap: Map<DiffLine, WordSegment[]> | null;
  comments: LocalDiffComment[];
  activeComment: LocalCommentTarget | null;
  commentText: string;
  onOpenComment: (target: LocalCommentTarget) => void;
  onCommentTextChange: (value: string) => void;
  onCancelComment: () => void;
  onSaveComment: () => void;
}) {
  return (
    <div style={{ fontFamily: MONO_FONT, fontSize: 11, lineHeight: 1.55, background: 'var(--t-bg-card)', borderTop: '1px solid var(--t-divider-subtle)' }}>
      {lines.map((line, index) => {
        const tone = diffLineTone(line.kind);
        const segments = segMap?.get(line);
        const target = lineCommentTarget(line, index);
        const lineComments = comments.filter((comment) => comment.key === target.key);
        return (
          <div key={index}>
            <div
              className="review-diff-line"
              style={{ display: 'flex', alignItems: 'flex-start', gap: 8, paddingTop: 1, paddingBottom: 1, paddingLeft: 6, paddingRight: 12, background: tone.background, color: tone.color, whiteSpace: 'pre' }}
            >
              <button
                type="button"
                className="review-diff-comment-trigger"
                title={`Comment on line ${target.label}`}
                aria-label={`Comment on line ${target.label}`}
                onClick={() => onOpenComment(target)}
                style={{
                  width: 18,
                  height: 18,
                  border: 'none',
                  borderRadius: 4,
                  background: 'transparent',
                  color: 'var(--t-text)',
                  fontFamily: UI_FONT,
                  fontSize: 11,
                  fontWeight: 800,
                  lineHeight: '18px',
                  cursor: 'pointer',
                  flexShrink: 0,
                  padding: 0,
                  textAlign: 'center',
                }}
              >
                +
              </button>
              <span style={NUM_CELL}>{line.oldNumber ?? ''}</span>
              <span style={NUM_CELL}>{line.newNumber ?? ''}</span>
              <span data-review-line={lineAnchor(line)} style={{ flex: 1, minWidth: 0, whiteSpace: wrap ? 'pre-wrap' : 'pre', overflowWrap: wrap ? 'anywhere' : 'normal' }}>
                {segments ? <WordDiffText line={line} segments={segments} /> : (line.text || ' ')}
              </span>
            </div>
            {lineComments.map((comment) => <LocalCommentNote key={comment.id} comment={comment} />)}
            {activeComment?.key === target.key ? (
              <LocalCommentComposer
                label={target.label}
                value={commentText}
                onChange={onCommentTextChange}
                onCancel={onCancelComment}
                onSave={onSaveComment}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** Pair deletions with additions into left/right rows for the split view. */
function sideRows(lines: DiffLine[]): Array<{ left: DiffLine | null; right: DiffLine | null }> {
  const rows: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line?.kind !== 'del') {
      rows.push(line?.kind === 'add' ? { left: null, right: line } : { left: line ?? null, right: line ?? null });
      continue;
    }
    const deletions: DiffLine[] = [];
    const additions: DiffLine[] = [];
    while (lines[index]?.kind === 'del') { deletions.push(lines[index]!); index += 1; }
    while (lines[index]?.kind === 'add') { additions.push(lines[index]!); index += 1; }
    index -= 1;
    const count = Math.max(deletions.length, additions.length);
    for (let offset = 0; offset < count; offset += 1) {
      rows.push({ left: deletions[offset] ?? null, right: additions[offset] ?? null });
    }
  }
  return rows;
}

function SideDiff({ lines, wrap, segMap }: { lines: DiffLine[]; wrap: boolean; segMap: Map<DiffLine, WordSegment[]> | null }) {
  const rows = useMemo(() => sideRows(lines), [lines]);
  const textCell: CSSProperties = wrap
    ? { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', paddingRight: 8 }
    : { whiteSpace: 'pre', overflow: 'hidden', textOverflow: 'ellipsis', paddingRight: 8 };
  return (
    <div className="cortex-themed-scroll" style={{ background: 'var(--t-bg-card)', borderTop: '1px solid var(--t-divider-subtle)', overflowX: 'auto' }}>
      <div style={{ minWidth: wrap ? 0 : 680, fontFamily: MONO_FONT, fontSize: 11, lineHeight: 1.55 }}>
        {rows.map((row, index) => {
          const leftTone = diffLineTone(row.left?.kind ?? 'context');
          const rightTone = diffLineTone(row.right?.kind ?? 'context');
          const leftSegs = row.left ? segMap?.get(row.left) : undefined;
          const rightSegs = row.right ? segMap?.get(row.right) : undefined;
          return (
            <div key={index} style={{ display: 'grid', gridTemplateColumns: '30px minmax(0, 1fr) 30px minmax(0, 1fr)' }}>
              <span style={{ ...NUM_CELL, width: 'auto', paddingRight: 6 }}>{row.left?.oldNumber ?? ''}</span>
              <span data-review-line={lineAnchor(row.left)} style={{ ...textCell, background: row.left ? leftTone.background : 'transparent', color: row.left ? leftTone.color : 'var(--t-text-faint)' }}>{leftSegs && row.left ? <WordDiffText line={row.left} segments={leftSegs} /> : (row.left?.text || ' ')}</span>
              <span style={{ ...NUM_CELL, width: 'auto', paddingRight: 6 }}>{row.right?.newNumber ?? ''}</span>
              <span data-review-line={lineAnchor(row.right)} style={{ ...textCell, background: row.right ? rightTone.background : 'transparent', color: row.right ? rightTone.color : 'var(--t-text-faint)' }}>{rightSegs && row.right ? <WordDiffText line={row.right} segments={rightSegs} /> : (row.right?.text || ' ')}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffPatch({
  patch,
  mode,
  wrap,
  wordDiff,
  comments,
  activeComment,
  commentText,
  onOpenComment,
  onCommentTextChange,
  onCancelComment,
  onSaveComment,
}: {
  patch: string;
  mode: DiffMode;
  wrap: boolean;
  wordDiff: boolean;
  comments: LocalDiffComment[];
  activeComment: LocalCommentTarget | null;
  commentText: string;
  onOpenComment: (target: LocalCommentTarget) => void;
  onCommentTextChange: (value: string) => void;
  onCancelComment: () => void;
  onSaveComment: () => void;
}) {
  const lines = useMemo(() => splitUnifiedDiff(patch), [patch]);
  const segMap = useMemo(() => (wordDiff ? wordDiffSegments(lines) : null), [lines, wordDiff]);
  return mode === 'side'
    ? <SideDiff lines={lines} wrap={wrap} segMap={segMap} />
    : (
      <UnifiedDiff
        lines={lines}
        wrap={wrap}
        segMap={segMap}
        comments={comments}
        activeComment={activeComment}
        commentText={commentText}
        onOpenComment={onOpenComment}
        onCommentTextChange={onCommentTextChange}
        onCancelComment={onCancelComment}
        onSaveComment={onSaveComment}
      />
    );
}

function RowMessage({ text, tone }: { text: string; tone?: 'error' }) {
  return (
    <div style={{ paddingTop: 8, paddingBottom: 12, paddingLeft: 14, paddingRight: 14, fontFamily: UI_FONT, fontSize: 11, color: tone === 'error' ? 'var(--t-brand-red)' : 'var(--t-text-muted)', background: 'var(--t-bg-card)', borderTop: '1px solid var(--t-divider-subtle)' }}>
      {text}
    </div>
  );
}

function PanelMessage({ text, tone }: { text: string; tone?: 'error' }) {
  return (
    <div style={{ paddingTop: 18, paddingRight: 16, paddingBottom: 18, paddingLeft: 16, fontFamily: UI_FONT, fontSize: 12, color: tone === 'error' ? 'var(--t-brand-red)' : 'var(--t-text-muted)' }}>
      {text}
    </div>
  );
}

export {
  lineCommentTarget,
  LocalCommentComposer,
  LocalCommentNote,
  WordDiffText,
  UnifiedDiff,
  sideRows,
  SideDiff,
  DiffPatch,
  RowMessage,
  PanelMessage,
};
