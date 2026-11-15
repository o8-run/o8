import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Copy, FileText, Pencil } from '../lucide-shims';

import { ttsEngine, type TTSEngineState } from '@/lib/tts/engine';
import { userScrolledRecently } from '@/lib/tts/scroll-follow';
import { MessageActions } from '../MessageActions';
import { ToolCallChipCluster } from '@/components/desktop/thoughts/chat-panel/ToolCallChipCluster';
import { renderLLMMarkdown } from '../LLMMarkdown';
import { ChainOfThought } from './ChainOfThought';
import { deriveFileChangesFromTools, THEME_ACCENT, THEME_ACCENT_BORDER, THEME_ACCENT_SOFT, THEME_ACCENT_SOFT_STRONG, THEME_BG_CARD, THEME_PANEL_GLASS, type FileChangePreview, type LLMMessage, type ToolCallInfo } from './shared';

const ACTION_BTN_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--t-text-secondary)',
  cursor: 'pointer',
  borderRadius: 7,
  transition: 'background-color 140ms ease, border-color 140ms ease, color 140ms ease',
  paddingTop: 0,
  paddingRight: 0,
  paddingBottom: 0,
  paddingLeft: 0,
};

const STACK_HIDDEN_TOOL_NAMES = new Set([
  'edit',
  'write',
  'multiedit',
  'multi_edit',
  'notebookedit',
  'notebook_edit',
  'edit_file',
  'write_file',
  'apply_patch',
]);

const NARRATIVE_COMMAND_HINT = /\/| -[A-Za-z]|[`'"]|^(?:bash|zsh|sh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh|git|npm|npx|pnpm|yarn|node|python(?:3)?|uv|pytest|rg|grep|sed|cat|ls|find|make|cargo|go|docker|kubectl)\b/i;

function normalizeExecToolCall(tool: ToolCallInfo): ToolCallInfo {
  const name = tool.name.toLowerCase();
  if (name !== 'exec' && name !== 'exec_command') return tool;
  if (!tool.args || typeof tool.args !== 'object') return tool;

  const existingCommand = typeof tool.args.command === 'string'
    ? tool.args.command.trim()
    : typeof tool.args.cmd === 'string'
      ? tool.args.cmd.trim()
      : '';
  if (existingCommand) return tool;

  const rawInput = typeof tool.args.input === 'string' ? tool.args.input.trim() : '';
  if (!rawInput) return tool;

  const command = rawInput.replace(/^Run\s+/i, '').trim();
  if (!command || command === rawInput) return tool;

  return {
    ...tool,
    args: {
      ...tool.args,
      command,
    },
  };
}

function toolCallFromNarrative(content: string): ToolCallInfo | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.includes('\n')) return null;

  const match = trimmed.match(/^Run\s+(.+)$/i);
  const command = match?.[1]?.trim();
  if (!command || !NARRATIVE_COMMAND_HINT.test(command)) return null;

  return {
    name: 'exec_command',
    status: 'done',
    args: { command },
  };
}

function ActionButton({ active, activeColor, icon, label, onClick }: { active?: boolean; activeColor?: string; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      style={{ ...ACTION_BTN_STYLE, color: active ? (activeColor || '#10b981') : '#cbd5e1' }}
      onMouseEnter={(event) => {
        if (active) return;
        event.currentTarget.style.color = 'var(--t-text-secondary)';
        event.currentTarget.style.background = THEME_ACCENT_SOFT;
        event.currentTarget.style.borderColor = THEME_ACCENT_BORDER;
      }}
      onMouseLeave={(event) => {
        if (active) return;
        event.currentTarget.style.color = 'var(--t-text-faint)';
        event.currentTarget.style.background = 'transparent';
        event.currentTarget.style.borderColor = 'transparent';
      }}
    >
      {icon}
    </button>
  );
}

function FileChangeCard({ change }: { change: FileChangePreview }) {
  const [expanded, setExpanded] = useState(false);
  const isWrite = Boolean(change.content && !change.oldText && !change.newText);

  return (
    <div style={{ width: '100%' }}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', paddingTop: 10, paddingRight: 12, paddingBottom: 10, paddingLeft: 12, background: THEME_BG_CARD, border: '1px solid var(--t-panel-border)', borderRadius: 12, cursor: 'pointer', textAlign: 'left' }}
      >
        <ChevronRight size={14} style={{ color: 'var(--t-text-secondary)', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 160ms cubic-bezier(0.22, 1, 0.36, 1)', flexShrink: 0 }} />
        <FileText size={14} style={{ color: 'var(--t-text-secondary)', flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>1 file changed</div>
          <div style={{ fontSize: 12, color: 'var(--t-text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{change.shortFile}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#16a34a' }}>+{change.additions}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#dc2626' }}>-{change.deletions}</span>
        </div>
      </button>
      {expanded ? (
        <div style={{ marginTop: 8, border: '1px solid var(--t-panel-border)', borderRadius: 12, overflow: 'hidden', background: THEME_PANEL_GLASS }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingTop: 10, paddingRight: 12, paddingBottom: 10, paddingLeft: 12, borderBottom: '1px solid var(--t-divider)', background: THEME_BG_CARD }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-text)' }}>{change.path}</div>
            <div style={{ fontSize: 10, color: 'var(--t-text-secondary)', fontWeight: 700 }}>{change.tool}</div>
          </div>
          <div style={{ paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12 }}>
            {isWrite ? (
              <pre style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5, fontFamily: '"SF Mono", ui-monospace, monospace', color: 'var(--t-text)' }}>{change.content}</pre>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#dc2626', marginBottom: 6 }}>Before</div>
                  <pre style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10, borderRadius: 10, background: 'rgba(127, 29, 29, 0.18)', color: '#7f1d1d', whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5, fontFamily: '"SF Mono", ui-monospace, monospace', minHeight: 80 }}>{change.oldText || 'No previous content'}</pre>
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#16a34a', marginBottom: 6 }}>After</div>
                  <pre style={{ marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10, borderRadius: 10, background: 'rgba(20, 83, 45, 0.22)', color: '#14532d', whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: 1.5, fontFamily: '"SF Mono", ui-monospace, monospace', minHeight: 80 }}>{change.newText || 'No updated content'}</pre>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MessageBubbleBase({
  message,
  isLast,
  onEdit,
  onFork,
  onApplyToFile,
  onApplyDiff,
  onOpenInCanvas,
  onRunInTerminal,
}: {
  message: LLMMessage;
  isLast: boolean;
  onRetry?: () => void;
  onEdit?: (content: string) => void;
  onDelete?: () => void;
  onFork?: () => void;
  onApplyToFile?: (code: string, language: string) => void;
  onApplyDiff?: (diffText: string) => void;
  onOpenInCanvas?: (code: string, language: string) => void;
  onRunInTerminal?: (command: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [bookmarked, setBookmarked] = useState(false);
  const [hovered, setHovered] = useState(false);
  const isUser = message.role === 'user';

  // Voice-playback line highlighting — track the source span of the block being
  // read aloud while THIS message plays, and scroll-follow it. Mirrors
  // DesktopAgentMessage / MessageActions.
  const rootRef = useRef<HTMLDivElement>(null);
  const [activeRange, setActiveRange] = useState<[number, number] | null>(null);
  useEffect(() => {
    return ttsEngine.subscribe((state: TTSEngineState) => {
      const chunk = state.activeChunk;
      if (chunk && chunk.messageId === message.id) {
        setActiveRange((prev) =>
          prev && prev[0] === chunk.srcStart && prev[1] === chunk.srcEnd
            ? prev
            : [chunk.srcStart, chunk.srcEnd],
        );
      } else {
        setActiveRange((prev) => (prev === null ? prev : null));
      }
    });
  }, [message.id]);
  useEffect(() => {
    if (!activeRange) return;
    const root = rootRef.current;
    if (!root) return;
    const activeEl = root.querySelector('[data-tts-active="true"]');
    if (!activeEl || userScrolledRecently()) return;
    activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeRange]);
  const syntheticNarrativeToolCall = !isUser && !(message.toolCalls?.length) ? toolCallFromNarrative(message.content) : null;
  const visibleContent = !isUser && syntheticNarrativeToolCall ? '' : message.content;
  const hasVisibleContent = visibleContent.trim().length > 0;
  const fileChanges = !isUser ? deriveFileChangesFromTools(message.toolCalls) : [];
  const visibleToolCalls = !isUser
    ? [...(message.toolCalls ?? []).map(normalizeExecToolCall), ...(syntheticNarrativeToolCall ? [syntheticNarrativeToolCall] : [])]
      .filter((tool) => !STACK_HIDDEN_TOOL_NAMES.has(tool.name.toLowerCase()))
    : [];

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(visibleContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [visibleContent]);

  return (
    <div ref={rootRef} style={{ display: 'flex', flexDirection: 'column', alignItems: isUser ? 'flex-end' : 'flex-start', gap: 4, animation: isLast ? 'llmFadeIn 200ms ease-out' : undefined }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      {isUser || hasVisibleContent ? (
        <div style={{ maxWidth: isUser ? '85%' : '90%', paddingTop: isUser ? 8 : 16, paddingRight: isUser ? 14 : 0, paddingBottom: isUser ? 8 : 16, paddingLeft: isUser ? 14 : 0, borderRadius: isUser ? '14px 14px 4px 14px' : 0, background: isUser ? 'rgba(99, 138, 255, 0.13)' : message.isError ? 'rgba(239,68,68,0.12)' : 'transparent', color: isUser ? 'var(--t-text)' : message.isError ? '#dc2626' : 'var(--t-text)', fontSize: 13, fontWeight: isUser ? 380 : 360, lineHeight: '1.55', letterSpacing: '-0.005em', fontFamily: 'var(--font-sans-system)', wordBreak: 'break-word', ...(isUser ? { whiteSpace: 'pre-wrap' as const } : {}) }}>
          {isUser ? (
            <>
              {visibleContent}
              {message.images && message.images.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  {message.images.map((image, index) => (
                    // eslint-disable-next-line @next/next/no-img-element -- attached image is a data or local URL
                    <img key={`${image}-${index}`} src={image} alt={`Attached ${index + 1}`} style={{ maxWidth: 200, maxHeight: 200, borderRadius: 10, objectFit: 'cover', border: '1px solid var(--t-border)' }} />
                  ))}
                </div>
              ) : null}
            </>
          ) : renderLLMMarkdown(visibleContent, { onApplyToFile, onApplyDiff, onOpenInCanvas, onRunInTerminal, activeHighlightRange: activeRange ?? undefined })}
        </div>
      ) : null}

      {!isUser && message.fallbackNotice ? (
        <div style={{ maxWidth: '90%', paddingTop: 2, paddingBottom: 6, paddingLeft: 2, fontSize: 11, color: 'var(--t-text-muted)', fontStyle: 'italic', fontFamily: 'var(--font-sans-system)', display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width="12" height="12" viewBox="0 0 256 256" fill="none" style={{ flexShrink: 0, opacity: 0.7 }}>
            <path d="M236.8 188.09 149.35 36.22a24.76 24.76 0 0 0-42.7 0L19.2 188.09a23.51 23.51 0 0 0 0 23.72A24.35 24.35 0 0 0 40.55 224h174.9a24.35 24.35 0 0 0 21.33-12.19 23.51 23.51 0 0 0 .02-23.72ZM120 104a8 8 0 0 1 16 0v40a8 8 0 0 1-16 0Zm8 88a12 12 0 1 1 12-12 12 12 0 0 1-12 12Z" fill="currentColor" />
          </svg>
          {message.fallbackNotice}
        </div>
      ) : null}

      {!isUser && message.isPartial ? <div style={{ maxWidth: '90%', paddingLeft: 2, fontSize: 11, color: 'var(--t-text-muted)', fontStyle: 'italic' }}>Recovered after reload</div> : null}
      {!isUser && (message.thinkingSteps || message.thinking) ? <ChainOfThought steps={message.thinkingSteps || []} thinking={message.thinking} durationMs={message.thinkingDurationMs} /> : null}
      {!isUser && fileChanges.length > 0 ? <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: '90%', marginTop: 4 }}>{fileChanges.map((change) => <FileChangeCard key={change.id} change={change} />)}</div> : null}
      {!isUser && visibleToolCalls.length > 0 ? (
        <div style={{ marginTop: 4, width: '100%' }}>
          <ToolCallChipCluster toolCalls={visibleToolCalls} />
        </div>
      ) : null}
      {!isUser && message.sources && message.sources.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, maxWidth: '90%', marginTop: 6 }}>
          {message.sources.map((source, index) => (
            <a
              key={`${source.title}-${index}`}
              href={source.url || '#'}
              target={source.url ? '_blank' : undefined}
              rel="noopener noreferrer"
              onClick={source.path && !source.url ? (event) => event.preventDefault() : undefined}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, paddingTop: 4, paddingRight: 10, paddingBottom: 4, paddingLeft: 8, background: THEME_ACCENT_SOFT, border: `1px solid ${THEME_ACCENT_BORDER}`, borderRadius: 6, fontSize: 11, color: THEME_ACCENT, textDecoration: 'none', fontFamily: 'var(--font-sans-system)', transition: 'background 100ms', cursor: 'pointer', animation: 'llmFadeIn 200ms ease-out' }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = THEME_ACCENT_SOFT_STRONG;
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = THEME_ACCENT_SOFT;
              }}
            >
              {source.index ? <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: '50%', background: THEME_ACCENT, color: '#ffffff', fontSize: 9, fontWeight: 700, flexShrink: 0 }}>{source.index}</span> : null}
              <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{source.title}</span>
            </a>
          ))}
        </div>
      ) : null}

      {!isUser && hasVisibleContent ? (
        <div style={{ width: '100%' }}>
          <MessageActions
            messageId={message.id}
            messageText={visibleContent}
            canPinContext
            isPinnedContext={bookmarked}
            onTogglePinContext={() => setBookmarked((value) => !value)}
            onFork={onFork}
          />
        </div>
      ) : null}

      {isUser && hovered ? (
        <div style={{ display: 'flex', gap: 2, paddingTop: 2, opacity: hovered ? 1 : 0, transition: 'opacity 150ms' }}>
          <ActionButton icon={<Pencil size={13} />} label="Edit message" onClick={() => onEdit?.(visibleContent)} />
          <ActionButton icon={copied ? <Check size={13} /> : <Copy size={13} />} label="Copy" active={copied} onClick={handleCopy} />
        </div>
      ) : null}
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleBase);
