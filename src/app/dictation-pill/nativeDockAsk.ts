'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskTurn } from '@/components/desktop/dictation/DockAskPanel';

/** What the page's Ask panel shows: its mode, thread and pending in-panel dictation. */
export interface NativeAskInput {
  mode: 'idle' | 'listening' | 'answer';
  thread: AskTurn[];
  pending: { phase: 'listening' | 'polishing' | 'handoff'; text: string } | null;
}

/** The Ask panel the native window draws (native_pill_ask.rs). `rev` names the
 * thread a copy click was drawn for; `turns` are the newest that fit the frame. */
export interface NativeAskFrame {
  rev: number;
  listening: boolean;
  turns: { index: number; role: 'user' | 'assistant'; text: string; sources?: string }[];
  pending?: { phase: string; text: string };
  working?: { tool: string; startedAt: number };
  copied?: number;
}

/** The request body is capped at 8 KiB; the thread keeps the newest turns that fit. */
export const ASK_TEXT_BUDGET = 4500;

const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** DockAskPanel's sources line, worded identically. */
function sourcesLine(turn: AskTurn) {
  if (!turn.sources?.length) return undefined;
  return `${turn.sources.length} ${turn.sources.length === 1 ? 'source' : 'sources'} · ${turn.sources.map(source => source.title).join(' · ')}`;
}

/** Cut text to a JSON byte budget, marking the cut. */
function clip(text: string, budget: number) {
  if (size(text) <= budget) return text;
  let result = '';
  for (const char of text) {
    if (size(result + char + '…') > budget) break;
    result += char;
  }
  return result + '…';
}

/** The newest turns whose JSON fits `budget` bytes, oldest first; the newest
 * is always kept, clipped if it alone is too long. */
export function askTurns(thread: AskTurn[], budget = ASK_TEXT_BUDGET): NativeAskFrame['turns'] {
  const turns: NativeAskFrame['turns'] = [];
  let left = budget;
  for (let index = thread.length - 1; index >= 0; index--) {
    const source = thread[index];
    const sources = sourcesLine(source);
    const turn = { index, role: source.role, text: source.text, ...(sources ? { sources: clip(sources, 400) } : {}) };
    const cost = size(turn);
    if (cost <= left) { turns.unshift(turn); left -= cost; continue; }
    if (turns.length === 0) {
      const overhead = size({ ...turn, text: '' });
      turns.unshift({ ...turn, text: clip(source.text, Math.max(16, left - overhead)) });
    }
    break;
  }
  return turns;
}

/** The Ask frame for the panel DockNotchSurface would draw. */
export function askFrame(ask: NativeAskInput, rev: number, working: { agentWorking: boolean; agentTool: string; agentStartedAt: number }, copied: number | null): NativeAskFrame {
  return {
    rev,
    listening: ask.mode === 'listening' && ask.thread.length === 0,
    turns: askTurns(ask.thread),
    ...(ask.pending ? { pending: { phase: ask.pending.phase, text: clip(ask.pending.text, 600) } } : {}),
    ...(working.agentWorking ? { working: { tool: working.agentTool, startedAt: working.agentStartedAt } } : {}),
    ...(copied !== null ? { copied } : {}),
  };
}

/** A number that changes whenever `value` changes identity. */
export function useRevision(value: unknown): number {
  const [seen, setSeen] = useState({ value, rev: 0 });
  if (seen.value !== value) {
    const next = { value, rev: seen.rev + 1 };
    setSeen(next);
    return next.rev;
  }
  return seen.rev;
}

/** The native panel's copy, run by the web as DockAskPanel's own handler runs
 * it: a failed write never shows Copied; Copied clears after 1.4 s. */
export function useAskCopy(thread: AskTurn[]) {
  const [copied, setCopied] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(thread);
  useEffect(() => { latest.current = thread; }, [thread]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = useCallback(async (index: number) => {
    const text = latest.current[index]?.text ?? '';
    if (!text.trim() || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(index);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(current => (current === index ? null : current)), 1400);
    } catch {
      // A failed write must not show “Copied”.
    }
  }, []);
  return { copied, copy };
}
