'use client';
import type React from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Clipboard, RotateCcw, Trash2 } from '../lucide-shims';
import { DiffStatusIcon, renderDiffLines } from '@/components/desktop/diff-utils';
import { renderMermaidSvg } from '@/lib/render/mermaid';
interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  additions: number | null;
  deletions: number | null;
}
interface FileDetail {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
  preview: string;
  note?: string;
  commitSummary?: string;
  commitAuthor?: string;
  commitAge?: string;
}
function MermaidViewerBase({ code }: { code: string }) {
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(2);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  useEffect(() => {
    let cancelled = false;
    async function render() {
      try {
        const svg = await renderMermaidSvg(code);
        if (!cancelled) {
          setSvgHtml(svg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setSvgHtml(null);
          setError(String(err));
        }
      }
    }
    void render();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const handleWheel = useCallback((event: React.WheelEvent) => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.15 : 0.15;
    setScale((s) => Math.min(Math.max(s + delta, 0.25), 10));
  }, []);

  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0) return;
    dragging.current = true;
    lastPos.current = { x: event.clientX, y: event.clientY };
  }, []);

  const handleMouseMove = useCallback((event: React.MouseEvent) => {
    if (!dragging.current) return;
    const dx = event.clientX - lastPos.current.x;
    const dy = event.clientY - lastPos.current.y;
    lastPos.current = { x: event.clientX, y: event.clientY };
    setTranslate((t) => ({ x: t.x + dx, y: t.y + dy }));
  }, []);

  const handleMouseUp = useCallback(() => {
    dragging.current = false;
  }, []);

  if (error) {
    return (
      <div style={{ paddingTop: 20, paddingRight: 20, paddingBottom: 20, paddingLeft: 20, fontSize: 13, color: '#ef4444', fontFamily: 'ui-monospace, monospace' }}>
        Mermaid render error: {error}
        <pre style={{ whiteSpace: 'pre-wrap', overflowX: 'auto' }}><code>{code}</code></pre>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 10,
          paddingRight: 14,
          paddingBottom: 10,
          paddingLeft: 16,
          borderBottom: '1px solid var(--t-divider)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: '#2563eb',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            fontFamily: 'var(--font-sans-system)',
          }}
        >
          Mermaid Diagram
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            onClick={() => setScale((s) => Math.max(s - 0.5, 0.25))}
            title="Zoom out"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 8,
              border: '1px solid var(--t-divider)',
              background: 'var(--t-panel-translucent)',
              color: 'var(--t-text-secondary)',
              cursor: 'pointer',
              paddingTop: 0,
              paddingRight: 0,
              paddingBottom: 0,
              paddingLeft: 0,
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>-</span>
          </button>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--t-text-secondary)',
              minWidth: 40,
              textAlign: 'center',
              fontFamily: '"SF Mono", ui-monospace, monospace',
            }}
          >
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setScale((s) => Math.min(s + 0.5, 10))}
            title="Zoom in"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 8,
              border: '1px solid var(--t-divider)',
              background: 'var(--t-panel-translucent)',
              color: 'var(--t-text-secondary)',
              cursor: 'pointer',
              paddingTop: 0,
              paddingRight: 0,
              paddingBottom: 0,
              paddingLeft: 0,
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setScale(2);
              setTranslate({ x: 0, y: 0 });
            }}
            title="Reset zoom"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: 28,
              borderRadius: 8,
              paddingTop: 0,
              paddingRight: 8,
              paddingBottom: 0,
              paddingLeft: 8,
              border: '1px solid var(--t-divider)',
              background: 'var(--t-panel-translucent)',
              color: 'var(--t-text-secondary)',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            Fit
          </button>
        </div>
      </div>
      <div
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{
          flex: 1,
          overflow: 'hidden',
          cursor: dragging.current ? 'grabbing' : 'grab',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundImage: 'linear-gradient(135deg, rgba(255,255,255,0.8) 0%, rgba(240,247,255,0.4) 100%)',
        }}
      >
        {svgHtml ? (
          <div
            dangerouslySetInnerHTML={{ __html: svgHtml }}
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
              transformOrigin: 'center center',
              transition: dragging.current ? 'none' : 'transform 100ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          />
        ) : (
          <span style={{ fontSize: 13, color: 'var(--t-text-muted)' }}>Rendering diagram...</span>
        )}
      </div>
    </div>
  );
}

export const MermaidViewer = memo(MermaidViewerBase);

export function DiffViewer() {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDetail, setFileDetail] = useState<FileDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [commitLoading, setCommitLoading] = useState(false);
  const [actionToast, setActionToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [diffPaneWidth, setDiffPaneWidth] = useState(0);
  const diffPaneRef = useRef<HTMLDivElement | null>(null);
  const diffPaneObserverRef = useRef<ResizeObserver | null>(null);

  const refreshFiles = useCallback(async () => {
    try {
      const res = await fetch('/api/review/workspace');
      if (!res.ok) return;
      const data = await res.json();
      setFiles(data.changedFiles ?? []);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    void refreshFiles().then(() => setLoading(false));
  }, [refreshFiles]);

  const diffPaneRefCallback = useCallback((node: HTMLDivElement | null) => {
    if (diffPaneObserverRef.current) {
      diffPaneObserverRef.current.disconnect();
      diffPaneObserverRef.current = null;
    }
    diffPaneRef.current = node;
    if (node) {
      setDiffPaneWidth(node.clientWidth);
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const width = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
          setDiffPaneWidth(width);
        }
      });
      observer.observe(node);
      diffPaneObserverRef.current = observer;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (diffPaneObserverRef.current) {
        diffPaneObserverRef.current.disconnect();
      }
    };
  }, []);

  const selectFile = useCallback(async (path: string) => {
    setSelectedFile(path);
    setDetailLoading(true);
    setFileDetail(null);
    try {
      const res = await fetch(`/api/review/file?path=${encodeURIComponent(path)}`);
      if (!res.ok) return;
      const data = await res.json();
      setFileDetail(data.file ?? null);
    } catch {
      // silent
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const copyPath = useCallback(async (path: string) => {
    try { await navigator.clipboard.writeText(path); } catch { return; }
    setCopiedPath(path);
    setTimeout(() => setCopiedPath(null), 1500);
  }, []);

  const discardFile = useCallback(async (path: string) => {
    try {
      const res = await fetch('/api/review/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setActionToast({ type: 'success', message: `Discarded ${path.split('/').pop()}` });
      if (selectedFile === path) {
        setSelectedFile(null);
        setFileDetail(null);
      }
      await refreshFiles();
    } catch (err) {
      setActionToast({ type: 'error', message: err instanceof Error ? err.message : 'Failed' });
    }
  }, [refreshFiles, selectedFile]);

  const stageAndCommit = useCallback(async () => {
    if (!commitMsg.trim()) return;
    setCommitLoading(true);
    setActionToast(null);
    try {
      const res = await fetch('/api/review/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMsg }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Commit failed');
      setActionToast({ type: 'success', message: data.message || 'Committed' });
      setCommitMsg('');
      setSelectedFile(null);
      setFileDetail(null);
      await refreshFiles();
    } catch (err) {
      setActionToast({ type: 'error', message: err instanceof Error ? err.message : 'Commit failed' });
    } finally {
      setCommitLoading(false);
    }
  }, [commitMsg, refreshFiles]);

  const totalAdditions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const totalDeletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          paddingTop: 12,
          paddingRight: 16,
          paddingBottom: 12,
          paddingLeft: 20,
          borderBottom: '1px solid var(--t-divider)',
          background: 'var(--t-panel-translucent)',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--t-text)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          Workspace Diff
        </span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#22c55e' }}>+{totalAdditions}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#ef4444' }}>-{totalDeletions}</span>
        <span style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>
          {files.length} file{files.length !== 1 ? 's' : ''}
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            void refreshFiles().then(() => setLoading(false));
          }}
          title="Refresh"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 6,
            border: '1px solid var(--t-divider)',
            background: 'transparent',
            color: 'var(--t-text-secondary)',
            cursor: 'pointer',
            paddingTop: 0,
            paddingRight: 0,
            paddingBottom: 0,
            paddingLeft: 0,
          }}
        >
          <RotateCcw size={13} />
        </button>
      </div>

      {files.length > 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            paddingTop: 6,
            paddingRight: 16,
            paddingBottom: 6,
            paddingLeft: 20,
            borderBottom: '1px solid var(--t-divider)',
            background: 'var(--t-hover)',
            flexShrink: 0,
          }}
        >
          <input
            type="text"
            placeholder="Commit message..."
            value={commitMsg}
            onChange={(event) => setCommitMsg(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && commitMsg.trim()) {
                event.preventDefault();
                void stageAndCommit();
              }
            }}
            style={{
              flex: 1,
              border: '1px solid var(--t-divider)',
              borderRadius: 8,
              paddingTop: 6,
              paddingRight: 10,
              paddingBottom: 6,
              paddingLeft: 10,
              fontSize: 12,
              background: 'var(--t-panel)',
              color: 'var(--t-text)',
              outline: 'none',
              fontFamily: 'var(--font-sans-system)',
            }}
          />
          <button
            type="button"
            onClick={() => void stageAndCommit()}
            disabled={!commitMsg.trim() || commitLoading}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              paddingTop: 6,
              paddingRight: 12,
              paddingBottom: 6,
              paddingLeft: 10,
              borderRadius: 8,
              border: 'none',
              background: commitMsg.trim() ? '#22c55e' : 'var(--t-divider)',
              color: commitMsg.trim() ? '#fff' : 'var(--t-text-muted)',
              fontSize: 11,
              fontWeight: 600,
              cursor: commitMsg.trim() ? 'pointer' : 'default',
              fontFamily: 'var(--font-sans-system)',
            }}
          >
            <Check size={12} />
            {commitLoading ? 'Committing...' : 'Stage All + Commit'}
          </button>
        </div>
      ) : null}

      {actionToast ? (
        <div
          style={{
            paddingTop: 4,
            paddingRight: 20,
            paddingBottom: 4,
            paddingLeft: 20,
            fontSize: 11,
            fontWeight: 500,
            flexShrink: 0,
            color: actionToast.type === 'success' ? '#22c55e' : '#ef4444',
            background: actionToast.type === 'success' ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
          }}
        >
          {actionToast.message}
        </div>
      ) : null}

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div
          style={{
            width: 260,
            flexShrink: 0,
            borderRight: '1px solid var(--t-divider)',
            overflowY: 'auto',
            background: 'var(--t-bg-subtle)',
          }}
        >
          {loading ? (
            <div style={{ paddingTop: 20, paddingRight: 20, paddingBottom: 20, paddingLeft: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>Loading…</div>
          ) : files.length === 0 ? (
            <div style={{ paddingTop: 20, paddingRight: 20, paddingBottom: 20, paddingLeft: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>Working tree clean</div>
          ) : (
            files.map((file) => {
              const isActive = selectedFile === file.path;
              const fileName = file.path.split('/').pop() ?? file.path;
              const dirPath = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';

              return (
                <div
                  key={file.path}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    borderLeft: isActive ? '2px solid #2563eb' : '2px solid transparent',
                    background: isActive ? 'rgba(37, 99, 235, 0.06)' : 'transparent',
                    transition: 'background 100ms cubic-bezier(0.22, 1, 0.36, 1), border-left-color 100ms cubic-bezier(0.22, 1, 0.36, 1)',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => void selectFile(file.path)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flex: 1,
                      minWidth: 0,
                      paddingTop: 10,
                      paddingRight: 4,
                      paddingBottom: 10,
                      paddingLeft: 12,
                      border: 'none',
                      background: 'transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontFamily: 'var(--font-sans-system)',
                    }}
                  >
                    <DiffStatusIcon status={file.status} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: isActive ? 600 : 400,
                          color: 'var(--t-text-strong)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {fileName}
                      </div>
                      {dirPath ? (
                        <div
                          style={{
                            fontSize: 11,
                            color: 'var(--t-text-muted)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {dirPath}
                        </div>
                      ) : null}
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0, fontSize: 11, fontWeight: 600 }}>
                      {(file.additions ?? 0) > 0 ? <span style={{ color: '#22c55e' }}>+{file.additions}</span> : null}
                      {(file.deletions ?? 0) > 0 ? <span style={{ color: '#ef4444' }}>-{file.deletions}</span> : null}
                    </div>
                  </button>
                  <div style={{ display: 'flex', gap: 2, paddingRight: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      title="Copy path"
                      onClick={(event) => {
                        event.stopPropagation();
                        copyPath(file.path);
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 22,
                        height: 22,
                        borderRadius: 4,
                        border: 'none',
                        background: 'transparent',
                        color: copiedPath === file.path ? '#22c55e' : 'var(--t-text-faint)',
                        cursor: 'pointer',
                        paddingTop: 0,
                        paddingRight: 0,
                        paddingBottom: 0,
                        paddingLeft: 0,
                      }}
                    >
                      {copiedPath === file.path ? <Check size={11} /> : <Clipboard size={11} />}
                    </button>
                    <button
                      type="button"
                      title="Discard changes"
                      onClick={(event) => {
                        event.stopPropagation();
                        void discardFile(file.path);
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 22,
                        height: 22,
                        borderRadius: 4,
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--t-text-faint)',
                        cursor: 'pointer',
                        paddingTop: 0,
                        paddingRight: 0,
                        paddingBottom: 0,
                        paddingLeft: 0,
                      }}
                      onMouseEnter={(event) => {
                        event.currentTarget.style.color = '#ef4444';
                      }}
                      onMouseLeave={(event) => {
                        event.currentTarget.style.color = 'var(--t-text-faint)';
                      }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div ref={diffPaneRefCallback} style={{ flex: 1, overflowY: 'auto' }}>
          {!selectedFile ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 14, color: 'var(--t-text-muted)' }}>
              Select a file to see the diff
            </div>
          ) : detailLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: 'var(--t-text-muted)' }}>
              Loading diff…
            </div>
          ) : fileDetail ? (
            <div>
              <div
                style={{
                  paddingTop: 12,
                  paddingRight: 16,
                  paddingBottom: 12,
                  paddingLeft: 16,
                  borderBottom: '1px solid var(--t-divider)',
                  background: 'var(--t-panel-translucent)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <DiffStatusIcon status={fileDetail.status} />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-text-strong)' }}>{fileDetail.path}</span>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#22c55e' }}>+{fileDetail.additions ?? 0}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#ef4444' }}>-{fileDetail.deletions ?? 0}</span>
                  <button
                    type="button"
                    title="Copy path"
                    onClick={() => copyPath(fileDetail.path)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 26,
                      height: 26,
                      borderRadius: 6,
                      marginLeft: 4,
                      border: '1px solid var(--t-divider)',
                      background: 'transparent',
                      color: copiedPath === fileDetail.path ? '#22c55e' : 'var(--t-text-secondary)',
                      cursor: 'pointer',
                      paddingTop: 0,
                      paddingRight: 0,
                      paddingBottom: 0,
                      paddingLeft: 0,
                    }}
                  >
                    {copiedPath === fileDetail.path ? <Check size={12} /> : <Clipboard size={12} />}
                  </button>
                  <button
                    type="button"
                    title="Discard changes"
                    onClick={() => void discardFile(fileDetail.path)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 26,
                      height: 26,
                      borderRadius: 6,
                      border: '1px solid rgba(239,68,68,0.2)',
                      background: 'transparent',
                      color: '#ef4444',
                      cursor: 'pointer',
                      paddingTop: 0,
                      paddingRight: 0,
                      paddingBottom: 0,
                      paddingLeft: 0,
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              {fileDetail.commitSummary ? (
                <div
                  style={{
                    paddingTop: 8,
                    paddingRight: 16,
                    paddingBottom: 8,
                    paddingLeft: 16,
                    borderBottom: '1px solid var(--t-divider-subtle)',
                    fontSize: 12,
                    color: 'var(--t-text-secondary)',
                  }}
                >
                  {fileDetail.commitSummary} — {fileDetail.commitAuthor} ({fileDetail.commitAge})
                </div>
              ) : null}
              <pre
                style={{
                  marginTop: 0,
                  marginRight: 0,
                  marginBottom: 0,
                  marginLeft: 0,
                  paddingTop: 4,
                  paddingRight: 0,
                  paddingBottom: 14,
                  paddingLeft: 0,
                  fontSize: 12,
                  lineHeight: 1.5,
                  fontFamily: '"SF Mono", "Menlo", "Monaco", ui-monospace, monospace',
                  color: 'var(--t-text-strong)',
                }}
              >
                {renderDiffLines(fileDetail.preview, diffPaneWidth)}
              </pre>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: 13, color: '#ef4444' }}>
              Could not load file diff
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
