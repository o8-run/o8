'use client';

import { Fragment, useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  classifyToolCall as classifyToolCallChip,
  extractO8AskQuestion,
} from '@/components/desktop/orchestrator/ToolCallChip';
import { TurnChevron } from './turn-line';
import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { sanitizeTranscriptText } from '@/components/desktop/transcript-sanitize';
import { BROWSER_PIP_EVENT } from '@/components/desktop/BrowserPipCard';

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return sanitizeTranscriptText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return sanitizeTranscriptText(JSON.stringify(value, null, 2));
  } catch {
    return String(value);
  }
}

function firstDetail(args: Record<string, unknown> | undefined, keys: string[]) {
  if (!args) return null;
  for (const key of keys) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const trimmed = sanitizeTranscriptText(value).trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function compact(text: string, max = 84) {
  const singleLine = sanitizeTranscriptText(text).replace(/\s+/g, ' ').trim();
  if (singleLine.length <= max) return singleLine;
  return `${singleLine.slice(0, max - 1)}…`;
}

/** Trim an error payload for the inline failure line. Keeps newlines (so a
 *  stack/tsc dump stays legible under pre-wrap) but caps total length. */
function truncateError(text: string, max = 600) {
  const cleaned = sanitizeTranscriptText(text).trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}

function shellCommandOf(tool: MobileTranscriptToolCall): string | null {
  const name = tool.name.toLowerCase().split(/__|\./).at(-1)!;
  if (name !== 'exec' && name !== 'exec_command' && name !== 'bash' && name !== 'shell') return null;
  return firstDetail(tool.args ?? {}, ['command', 'cmd', 'shell']);
}

/** classifyToolCall with the shell command threaded through, so worker
 *  `o8 ask` execs render as the same Brain chip the orchestrator gets. */
function classifyTool(tool: MobileTranscriptToolCall) {
  if (/(?:^|__|\.)o8_command_help$/i.test(tool.name)) return { verb: 'Help', kind: 'generic' as const };
  const name = tool.name.split(/__|\./).at(-1)!;
  const classified = classifyToolCallChip(name, shellCommandOf(tool));
  return classified.kind === 'generic' ? { ...classified, verb: name.replace(/[_-]+/g, ' ') } : classified;
}

function toolArgument(tool: MobileTranscriptToolCall) {
  const args = tool.args ?? {};
  const name = tool.name.toLowerCase().split(/__|\./).at(-1)!;

  if (/(?:^|__|\.)o8_(?:run|command_help)$/.test(name)) {
    const command = firstDetail(args, ['name']);
    if (command) return compact(command);
  }
  if (name === 'exec' || name === 'exec_command' || name === 'bash' || name === 'shell') {
    const command = firstDetail(args, ['command', 'cmd', 'shell']);
    const brainQuestion = command ? extractO8AskQuestion(command) : null;
    if (brainQuestion) return compact(brainQuestion);
    return compact(command ?? 'terminal command');
  }
  if (name === 'write_stdin') {
    return compact(firstDetail(args, ['chars']) ?? firstDetail(args, ['session_id', 'sessionId']) ?? 'terminal input');
  }
  if (name.includes('read') || name === 'grep' || name === 'glob' || name === 'ls' || name === 'list_files') {
    return compact(firstDetail(args, ['file_path', 'path', 'pattern', 'query']) ?? 'workspace read');
  }
  if (name.includes('write') || name.includes('edit') || name.includes('patch')) {
    return compact(firstDetail(args, ['file_path', 'filePath', 'path', 'notebook_path']) ?? 'file change');
  }
  if (name.includes('search')) {
    return compact(firstDetail(args, ['query', 'q']) ?? 'search');
  }
  if (name.includes('fetch') || name.includes('browser')) {
    return compact(firstDetail(args, ['url', 'href', 'action']) ?? 'browser action');
  }
  if (name.endsWith('cortex_ask')) {
    return compact(firstDetail(args, ['question']) ?? 'brain question');
  }

  return compact(
    firstDetail(args, ['path', 'file_path', 'url', 'query', 'command', 'cmd', 'prompt', 'question'])
    ?? '',
  );
}

function toolStatusLabel(tool: MobileTranscriptToolCall) {
  if (tool.status === 'calling' || tool.status === 'running') return 'running';
  if (tool.status === 'error') return 'failed';
  if (tool.status === 'stopped') return 'cancelled · stopped';
  if (tool.status === 'done') return 'completed';
  return 'status unknown';
}

function detailRows(tool: MobileTranscriptToolCall) {
  return [
    { label: 'Tool ID', value: tool.id ?? '' },
    { label: 'Name', value: tool.name },
    { label: 'Status', value: toolStatusLabel(tool) },
    { label: 'Command', value: shellCommandOf(tool) ?? '' },
    { label: 'Arguments', value: stringifyValue(tool.args) },
    { label: 'Preview', value: stringifyValue(tool.preview) },
    { label: 'Result', value: stringifyValue(tool.result) },
    { label: 'Launch', value: stringifyValue(tool.launchLink) },
  ].filter((row) => row.value.trim().length > 0);
}

function toolKey(tool: MobileTranscriptToolCall, index: number) {
  return tool.id?.trim() ? tool.id : `${tool.name}-${index}`;
}

/** Settled activity uses a quiet counted summary; per-call evidence stays
 * available under the same disclosure used while the calls were running. */
export function describeToolRollupParts(toolCalls: MobileTranscriptToolCall[], mode: 'lead' | 'fold' = 'lead'): string[] {
  let explored = 0;
  let ran = 0;
  let dispatched = 0;
  let edited = 0;
  let other = 0;
  for (const tool of toolCalls) {
    const kind = classifyTool(tool).kind;
    if (kind === 'read' || kind === 'spec') explored += 1;
    else if (kind === 'shell') ran += 1;
    else if (kind === 'delegate') dispatched += 1;
    else if (kind === 'write') edited += 1;
    else other += 1;
  }
  // 'lead' capitalizes for a standalone line; 'fold' lowercases so the parts
  // read naturally inside the edit aggregate ("Edited 12 files, ran 1 command").
  const cased = (word: string) => (mode === 'lead' ? word : word.toLowerCase());
  const parts: string[] = [];
  if (explored > 0) parts.push(`${cased('Explored')} ${explored} ${explored === 1 ? 'file' : 'files'}`);
  if (ran > 0) parts.push(`${cased('Ran')} ${ran} ${ran === 1 ? 'command' : 'commands'}`);
  if (dispatched > 0) parts.push(`${cased('Dispatched')} ${dispatched} ${dispatched === 1 ? 'agent' : 'agents'}`);
  if (edited > 0) parts.push(`${cased('Edited')} ${edited} ${edited === 1 ? 'file' : 'files'}`);
  if (other > 0) parts.push(`${other} ${other === 1 ? 'tool call' : 'tool calls'}`);
  return parts;
}

function describeToolRollup(toolCalls: MobileTranscriptToolCall[]): string {
  return describeToolRollupParts(toolCalls, 'lead').join(' · ');
}

/** An entry that contributes NOTHING to the transcript except tool calls —
 *  no text, no thinking, no media, no status/compaction payload. */
function isToolOnlyEntry(entry: MobileTranscriptEntry): boolean {
  return entry.role === 'assistant'
    && (entry.toolCalls?.length ?? 0) > 0
    && !entry.text?.trim()
    && !entry.thinking?.trim()
    && !entry.thinkingActive
    && !(entry.media?.length)
    && !entry.command
    && !entry.compaction;
}

/**
 * Merge CONSECUTIVE tool-only assistant entries into one, so parallel work
 * that the backend emitted as separate assistant messages renders as a single
 * cluster (one counted "Running N commands" line) instead of a stack of
 * shimmer rows (operator ruling 2026-07-13 — five parallel eval commands ate
 * ~150px of transcript). Render-time derivation only: state is untouched, the
 * merged entry keeps the first entry's identity, and any entry with its own
 * text/thinking/media terminates the run.
 */
const toolOnlyRuns = new WeakMap<MobileTranscriptEntry, { entries: MobileTranscriptEntry[]; merged: MobileTranscriptEntry }>();

export function mergeAdjacentToolOnlyEntries(entries: MobileTranscriptEntry[]): MobileTranscriptEntry[] {
  let merged: MobileTranscriptEntry[] | null = null;
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (isToolOnlyEntry(entry) && i + 1 < entries.length && isToolOnlyEntry(entries[i + 1])) {
      const run = [entry];
      while (i + 1 < entries.length && isToolOnlyEntry(entries[i + 1])) {
        i += 1;
        run.push(entries[i]);
      }
      if (merged === null) merged = entries.slice(0, entries.indexOf(entry));
      const cached = toolOnlyRuns.get(entry);
      if (cached && cached.entries.length === run.length && run.every((item, index) => item === cached.entries[index])) {
        merged.push(cached.merged);
      } else {
        const combined = { ...entry, toolCalls: run.flatMap(item => item.toolCalls ?? []) };
        toolOnlyRuns.set(entry, { entries: run, merged: combined });
        merged.push(combined);
      }
      continue;
    }
    if (merged !== null) merged.push(entry);
  }
  return merged ?? entries;
}

const activityButton: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, width: '100%',
  minHeight: 22, border: 'none', background: 'transparent', padding: 0,
  textAlign: 'left', cursor: 'pointer', color: 'var(--t-text-muted)',
  fontFamily: 'var(--font-sans-system)', fontSize: 12, fontWeight: 300,
  letterSpacing: '-0.1px', lineHeight: 1.5, transition: 'none',
};
const clipped: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

/** One stable disclosure throughout the call lifecycle. Stream updates change
 * text in place; only an explicit disclosure changes the block's height. */
export function ToolCallChipCluster({ toolCalls, suppressSettledRollup = false, waiting = false, children }: {
  toolCalls: MobileTranscriptToolCall[];
  suppressSettledRollup?: boolean;
  waiting?: boolean;
  children?: ReactNode;
}) {
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const detailsId = useId();
  const hasBrowserWork = useMemo(() => toolCalls.some(tool => tool.name.toLowerCase().includes('browser')), [toolCalls]);
  const broadcastPipHover = (hovering: boolean) => {
    if (hasBrowserWork) window.dispatchEvent(new CustomEvent(BROWSER_PIP_EVENT, { detail: { hovering } }));
  };
  useEffect(() => () => {
    if (hasBrowserWork) window.dispatchEvent(new CustomEvent(BROWSER_PIP_EVENT, { detail: { hovering: false } }));
  }, [hasBrowserWork]);
  if (!toolCalls.length) return null;
  const running = toolCalls.filter(tool => tool.status === 'running' || tool.status === 'calling');
  const failed = toolCalls.filter(tool => tool.status === 'error');
  const stopped = toolCalls.filter(tool => tool.status === 'stopped');
  const unknown = toolCalls.some(tool => !tool.status);
  const current = running[0];
  const currentLabel = current ? `${classifyTool(current).kind === 'shell' ? '' : classifyTool(current).verb} ${toolArgument(current)}`.trim() : '';
  const label = current ? `Running · ${currentLabel}`
    : failed.length ? `${failed.length} ${failed.length === 1 ? 'tool' : 'tools'} failed`
      : stopped.length ? 'Cancelled · stopped'
        : unknown ? 'Tool status unknown'
          : waiting ? 'Waiting for response' : describeToolRollup(toolCalls);
  const suffix = current ? `${running.length > 1 ? ` · ${running.length} running` : ''}${failed.length ? ` · ${failed.length} failed` : ''}` : '';
  if (suppressSettledRollup && !waiting && !current && !failed.length && !stopped.length && !unknown && !showAll && !children) return null;
  return <div data-tool-activity="" onMouseEnter={() => broadcastPipHover(true)} onMouseLeave={() => broadcastPipHover(false)}
    style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, gap: 3 }}>
    <button type="button" onClick={() => setShowAll(value => !value)} aria-expanded={showAll} aria-controls={detailsId}
      aria-label={showAll ? 'Collapse the tool call list' : `Show all ${toolCalls.length} tool calls in this turn`}
      title={`${label}${suffix}`} style={activityButton}>
      <span style={clipped}>{label}</span>
      {suffix ? <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 260 }}>{suffix}</span> : null}
      <TurnChevron open={showAll} reducedMotion />
    </button>
    {failed.map((tool, index) => <div key={`error-${toolKey(tool, index)}`} role="alert" style={{
      color: 'var(--t-brand-red)', fontSize: 11, fontWeight: 300, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap',
    }}>{truncateError(tool.result ?? tool.preview ?? 'Tool call failed')}</div>)}
    <div id={detailsId} hidden={!showAll} style={{ minWidth: 0 }}>
      {children}
      {showAll ? toolCalls.map((tool, index) => {
        const key = toolKey(tool, index);
        const open = expandedToolId === key;
        const id = `${detailsId}-${index}`;
        return <Fragment key={key}>
          <button type="button" onClick={() => setExpandedToolId(value => value === key ? null : key)}
            aria-label={`${classifyTool(tool).verb} ${toolArgument(tool)} — show detail`}
            aria-expanded={open} aria-controls={id} style={{ ...activityButton, paddingLeft: 12 }}>
            <span style={clipped}>{classifyTool(tool).verb} {toolArgument(tool)}</span>
            <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 10, fontWeight: 260,
              color: tool.status === 'error' ? 'var(--t-brand-red)' : 'var(--t-text-faint)' }}>{toolStatusLabel(tool)}</span>
            <TurnChevron open={open} reducedMotion />
          </button>
          <div id={id} hidden={!open} style={{ paddingLeft: 12, minWidth: 0 }}>
            {open ? detailRows(tool).map(row => <div key={row.label} style={{ paddingTop: 6 }}>
              <div style={{ color: 'var(--t-text-faint)', fontSize: 9.5, fontWeight: 260 }}>{row.label}</div>
              <pre tabIndex={0} style={{ margin: 0, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere', color: 'var(--t-text-secondary)', fontFamily: 'var(--font-mono)',
                fontSize: 11, fontWeight: 300, lineHeight: 1.5 }}>{row.value}</pre>
            </div>) : null}
          </div>
        </Fragment>;
      }) : null}
    </div>
  </div>;
}
