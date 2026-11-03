'use client';
/* eslint-disable react-hooks/refs -- drag refs are read during render only for cursor/transition affordances */

/**
 * CodeBlock — styled code blocks for desktop chat.
 *
 * Features:
 * - Collapsible with header bar (language label, line count, copy button)
 * - Mermaid diagrams render inline with o8 theme
 * - Syntax-highlighted text with monospace font
 * - Separate from mobile CodeBlock (per our component rule)
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Copy, Expand, Minus, Plus, X, FileCode, PanelRight, Play } from './lucide-shims';
import { renderMermaidSvg } from '@/lib/render/mermaid';

interface CodeBlockProps {
  code: string;
  language?: string;
  onOpenMermaid?: (code: string) => void;
  onOpenInCanvas?: (code: string, language: string) => void;
  onApplyToFile?: (code: string, language: string) => void;
  onRunInTerminal?: (command: string) => void;
}

const LANG_ALIASES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  py: 'Python', rb: 'Ruby', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', css: 'CSS', html: 'HTML',
  sql: 'SQL', md: 'Markdown', diff: 'Diff', rust: 'Rust', go: 'Go',
  mermaid: 'Mermaid', toml: 'TOML', xml: 'XML', graphql: 'GraphQL',
};

function formatLabel(lang?: string): string {
  if (!lang) return 'code';
  if (lang === 'tool-output') return 'exec output';
  return LANG_ALIASES[lang.toLowerCase()] ?? lang;
}

// ── Glass Modal for Mermaid Zoom ──

const DEFAULT_ZOOM = 4; // 400% — diagrams render small, this fills the viewport

function MermaidModal({ svgHtml, onClose }: { svgHtml: string; onClose: () => void }) {
  const [scale, setScale] = useState(DEFAULT_ZOOM);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '=' || e.key === '+') setScale(s => Math.min(s + 0.25, 8));
      if (e.key === '-') setScale(s => Math.max(s - 0.25, 0.5));
      if (e.key === '0') { setScale(DEFAULT_ZOOM); setTranslate({ x: 0, y: 0 }); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.2 : 0.2;
    setScale(s => Math.min(Math.max(s + delta, 0.5), 8));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragging.current = true;
    lastPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setTranslate(t => ({ x: t.x + dx, y: t.y + dy }));
  }, []);

  const handleMouseUp = useCallback(() => {
    dragging.current = false;
  }, []);

  return createPortal(
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(40px) saturate(200%) brightness(1.05)',
        WebkitBackdropFilter: 'blur(40px) saturate(200%) brightness(1.05)',
        backgroundColor: 'rgba(255, 255, 255, 0.15)',
        animation: 'fadeIn 200ms ease',
      }}
    >
      {/* Glass panel */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: '90vw',
          height: '85vh',
          maxWidth: 1400,
          borderRadius: 20,
          overflow: 'hidden',
          background: 'linear-gradient(135deg, rgba(255,255,255,0.45) 0%, rgba(240,247,255,0.25) 100%)',
          border: '1px solid rgba(255,255,255,0.35)',
          boxShadow: '0 32px 80px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.03), inset 0 1px 0 rgba(255,255,255,0.6)',
          backdropFilter: 'blur(60px) saturate(180%)',
          WebkitBackdropFilter: 'blur(60px) saturate(180%)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingTop: 14,
          paddingRight: 16,
          paddingBottom: 14,
          paddingLeft: 20,
          borderBottom: '1px solid var(--t-divider)',
          background: 'var(--t-hover)',
        }}>
          <span style={{
            fontSize: 13,
            fontWeight: 700,
            color: '#ef4444',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            fontFamily: 'var(--font-sans-system)',
          }}>
            ◆ Mermaid Diagram
          </span>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* Zoom controls */}
            <button
              type="button"
              onClick={() => setScale(s => Math.max(s - 0.5, 0.5))}
              style={modalBtnStyle}
              title="Zoom out (−)"
            >
              <Minus size={14} strokeWidth={2} />
            </button>

            <span style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--t-text-secondary)',
              minWidth: 40,
              textAlign: 'center',
              fontFamily: 'SF Mono, ui-monospace, monospace',
            }}>
              {Math.round(scale * 100)}%
            </span>

            <button
              type="button"
              onClick={() => setScale(s => Math.min(s + 0.5, 8))}
              style={modalBtnStyle}
              title="Zoom in (+)"
            >
              <Plus size={14} strokeWidth={2} />
            </button>

            <button
              type="button"
              onClick={() => { setScale(DEFAULT_ZOOM); setTranslate({ x: 0, y: 0 }); }}
              style={{ ...modalBtnStyle, marginLeft: 4, fontSize: 11, width: 'auto', paddingLeft: 8, paddingRight: 8 }}
              title="Reset (0)"
            >
              Fit
            </button>

            <div style={{ width: 1, height: 20, background: 'var(--t-divider)', marginLeft: 8, marginRight: 8 }} />

            <button
              type="button"
              onClick={onClose}
              style={{ ...modalBtnStyle, color: '#ef4444' }}
              title="Close (Esc)"
            >
              <X size={15} strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* Diagram area — zoomable/pannable */}
        <div
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          style={{
            width: '100%',
            height: 'calc(100% - 52px)',
            overflow: 'hidden',
            cursor: dragging.current ? 'grabbing' : 'grab',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            dangerouslySetInnerHTML={{ __html: svgHtml }}
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
              transformOrigin: 'center center',
              transition: dragging.current ? 'none' : 'transform 100ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

const modalBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  borderRadius: 8,
  border: '1px solid var(--t-divider)',
  background: 'var(--t-panel-translucent)',
  color: 'var(--t-text-secondary)',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  fontFamily: 'var(--font-sans-system)',
  transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
  paddingLeft: 0,
};

// ── Mermaid Diagram (inline + expand) ──

const MermaidDiagram = memo(function MermaidDiagram({ code, onOpenMermaid }: { code: string; onOpenMermaid?: (code: string) => void }) {
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

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
    return () => { cancelled = true; };
  }, [code]);

  if (error) {
    return (
      <div style={{
        paddingTop: 12,
        paddingRight: 14,
        paddingBottom: 12,
        paddingLeft: 14,
        fontSize: '0.8rem',
        color: '#ef4444',
        fontFamily: 'ui-monospace, monospace',
      }}>
        Mermaid render error: {error}
        <pre style={{ whiteSpace: 'pre-wrap', overflowX: 'auto' }}><code>{code}</code></pre>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'relative',
        paddingTop: 20,
        paddingRight: 16,
        paddingBottom: 20,
        paddingLeft: 16,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: svgHtml ? undefined : 60,
        backgroundColor: 'var(--t-bg-subtle)',
        borderTop: '1px solid var(--t-divider)',
        backgroundImage: 'linear-gradient(135deg, rgba(255,255,255,0.8) 0%, rgba(240,247,255,0.4) 100%)',
      }}
    >
      {svgHtml ? (
        <>
          <div
            dangerouslySetInnerHTML={{ __html: svgHtml }}
            style={{ maxWidth: '100%', overflow: 'auto' }}
          />
          {/* Expand button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (onOpenMermaid) {
                onOpenMermaid(code);
              } else {
                setModalOpen(true);
              }
            }}
            title="Expand diagram"
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              borderRadius: 8,
              border: '1px solid var(--t-divider)',
              background: 'var(--t-panel-translucent)',
              backdropFilter: 'blur(8px)',
              color: 'var(--t-text-secondary)',
              cursor: 'pointer',
              transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
              boxShadow: 'var(--t-panel-shadow)',
              paddingTop: 0,
              paddingRight: 0,
              paddingBottom: 0,
              paddingLeft: 0,
            }}
          >
            <Expand size={14} strokeWidth={2} />
          </button>
          {modalOpen ? <MermaidModal svgHtml={svgHtml} onClose={() => setModalOpen(false)} /> : null}
        </>
      ) : (
        <span style={{ fontSize: 12, color: 'var(--t-text-muted)' }}>Rendering diagram…</span>
      )}
    </div>
  );
});

export const CodeBlock = memo(function CodeBlock({ code, language, onOpenMermaid, onOpenInCanvas, onApplyToFile, onRunInTerminal }: CodeBlockProps) {
  const lines = code.split('\n');
  const label = formatLabel(language);
  const isMermaid = language?.toLowerCase() === 'mermaid';
  const isCode = !isMermaid && (!!language && ['ts', 'tsx', 'js', 'jsx', 'py', 'css', 'html', 'json', 'yaml', 'yml', 'toml', 'sh', 'bash', 'sql', 'go', 'rust', 'md', 'xml', 'graphql', 'typescript', 'javascript', 'python', 'ruby', 'shell', 'zsh', 'console', 'terminal', 'powershell', 'fish', 'cmd'].includes(language.toLowerCase()));
  // Detect shell: explicit tags OR untagged blocks that look like commands
  const shellTags = ['sh', 'bash', 'shell', 'zsh', 'console', 'terminal', 'powershell', 'fish', 'cmd'];
  const looksLikeShell = !language && code.split('\n').every((line: string) => {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('$')) return true;
    return /^(npm|npx|yarn|pnpm|bun|brew|pip|cargo|go |git |cd |ls|mkdir|rm |cp |mv |cat |echo |curl |wget |docker |kubectl |sudo |apt|dnf|yum|chmod|chown|export |source |\.\/|node |python|ruby |make|cmake|gcc|g\+\+|rustc|deno|open |pbcopy|which|env |set )/.test(t);
  });
  const isShell = (!!language && shellTags.includes(language.toLowerCase())) || looksLikeShell;
  const [ran, setRan] = useState(false);
  const [expanded, setExpanded] = useState(isMermaid); // Mermaid auto-expands
  const [copied, setCopied] = useState(false);
  const [applied, setApplied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [code]);

  return (
    <div style={{
      margin: '8px 0',
      borderRadius: 12,
      overflow: 'hidden',
      backgroundColor: 'var(--t-bg-subtle)',
      border: '1px solid var(--t-divider)',
      boxShadow: 'var(--t-panel-shadow)',
    }}>
      {/* Header bar */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          paddingTop: 8,
          paddingRight: 12,
          paddingBottom: 8,
          paddingLeft: 14,
          border: 'none',
          backgroundColor: 'transparent',
          cursor: 'pointer',
          fontFamily: 'var(--font-sans-system)',
          gap: 8,
        }}
      >
        {/* Language label */}
        <span style={{
          fontSize: '0.75rem',
          fontWeight: 600,
          color: isMermaid ? '#2563eb' : 'var(--t-text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}>
          {isMermaid ? '◆ Mermaid' : label}
        </span>

        {/* Line count */}
        <span style={{
          fontSize: '0.7rem',
          color: 'var(--t-text-muted)',
          marginRight: 'auto',
        }}>
          {lines.length} lines
        </span>

        {/* Copy button */}
        <span
          onClick={(e) => {
            e.stopPropagation();
            void handleCopy();
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            fontSize: '0.7rem',
            color: copied ? '#22c55e' : 'var(--t-text-muted)',
            cursor: 'pointer',
          }}
        >
          {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.8} />}
          {copied ? 'Copied' : 'Copy'}
        </span>

        {/* Apply to File */}
        {isCode && onApplyToFile && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              if (!applied) {
                onApplyToFile(code, language || '');
                setApplied(true);
                setTimeout(() => setApplied(false), 2000);
              }
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              fontSize: '0.7rem',
              color: applied ? '#22c55e' : 'var(--t-text-muted)',
              cursor: 'pointer',
              transition: 'color 150ms',
            }}
            onMouseEnter={(e) => { if (!applied) (e.currentTarget).style.color = '#3b82f6'; }}
            onMouseLeave={(e) => { if (!applied) (e.currentTarget).style.color = 'var(--t-text-muted)'; }}
          >
            {applied ? <Check size={12} strokeWidth={2} /> : <FileCode size={12} strokeWidth={1.8} />}
            {applied ? 'Applied' : 'Apply'}
          </span>
        )}

        {/* Open in Canvas */}
        {isCode && onOpenInCanvas && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onOpenInCanvas(code, language || '');
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              fontSize: '0.7rem',
              color: 'var(--t-text-muted)',
              cursor: 'pointer',
              transition: 'color 150ms',
            }}
            onMouseEnter={(e) => { (e.currentTarget).style.color = '#3b82f6'; }}
            onMouseLeave={(e) => { (e.currentTarget).style.color = 'var(--t-text-muted)'; }}
          >
            <PanelRight size={12} strokeWidth={1.8} />
            Canvas
          </span>
        )}

        {/* Run in Terminal */}
        {isShell && onRunInTerminal && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              if (!ran) {
                onRunInTerminal(code);
                setRan(true);
                setTimeout(() => setRan(false), 3000);
              }
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              fontSize: '0.7rem',
              color: ran ? '#22c55e' : 'var(--t-text-muted)',
              cursor: 'pointer',
              transition: 'color 150ms',
            }}
            onMouseEnter={(e) => { if (!ran) (e.currentTarget).style.color = '#10b981'; }}
            onMouseLeave={(e) => { if (!ran) (e.currentTarget).style.color = 'var(--t-text-muted)'; }}
          >
            {ran ? <Check size={12} strokeWidth={2} /> : <Play size={12} strokeWidth={1.8} fill="currentColor" />}
            {ran ? 'Sent' : 'Run'}
          </span>
        )}

        {/* Chevron */}
        <ChevronDown
          size={13}
          strokeWidth={2}
          style={{
            color: 'var(--t-text-muted)',
            transition: 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </button>

      {/* Content */}
      {expanded ? (
        isMermaid ? (
          <MermaidDiagram code={code} onOpenMermaid={onOpenMermaid} />
        ) : (
          <pre className="cortex-scroll-fade-y cortex-themed-scroll" style={{
            margin: 0,
            paddingTop: 12,
            paddingRight: 14,
            paddingBottom: 12,
            paddingLeft: 14,
            fontSize: '0.82rem',
            lineHeight: 1.6,
            color: 'var(--t-text)',
            fontFamily: '"SF Mono", "Menlo", "Monaco", "Cascadia Code", ui-monospace, monospace',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            borderTop: '1px solid var(--t-divider)',
            backgroundColor: 'var(--t-panel)',
            maxHeight: 400,
            overflowY: 'auto',
          }}>
            <code>{code}</code>
          </pre>
        )
      ) : null}
    </div>
  );
});
