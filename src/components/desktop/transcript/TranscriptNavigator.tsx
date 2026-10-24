'use client';

import { memo, useEffect, useMemo, useState, type RefObject } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { TranscriptPeek } from './TranscriptPeek';

export function TranscriptNavigator({ entries, scrollRef }: {
  entries: MobileTranscriptEntry[]; scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const prompts = useMemo(() => entries.flatMap((entry, index) => {
    if (entry.role !== 'user') return [];
    let answer = '';
    for (let i = index + 1; i < entries.length && entries[i].role !== 'user'; i += 1) {
      if (entries[i].role === 'assistant' && entries[i].text.trim()) answer = entries[i].text;
    }
    return [{ id: entry.id, title: entry.text.trim() || 'Attached files', answer }];
  }), [entries]);
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState('');
  const [hovered, setHovered] = useState(-1);
  const promptGeometryKey = JSON.stringify(prompts.map(prompt => [prompt.id, prompt.title]));
  useEffect(() => {
    const host = scrollRef.current;
    if (!host) return;
    // Answer text changes previews without changing the prompt list. Size
    // changes and scrolling still measure through the retained observers.
    const promptIds = (JSON.parse(promptGeometryKey) as Array<[string, string]>).map(([id]) => id);
    const ids = new Set(promptIds);
    let targets: HTMLElement[] | null = null;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Retained tabs report zero width while hidden. Keep their navigation
        // DOM and active prompt, so showing a long history does not remount
        // thousands of prompt controls. A genuinely narrow visible pane still
        // hides the navigator below the existing width threshold.
        if (host.clientWidth === 0) return;
        setVisible(host.clientWidth >= 600 && host.scrollHeight > host.clientHeight + 120 && promptIds.length >= 4);
        const top = host.getBoundingClientRect().top + 80;
        // The DOM follows transcript order. Locate the last prompt above the
        // reading line with logarithmic layout reads, rather than forcing a
        // layout for every prompt on every scroll. Prefer the turn container:
        // measuring a descendant would defeat its content-visibility boundary.
        // Prompt identity/title changes restart this effect. Streaming answers
        // do not replace the retained prompt nodes; avoid a full DOM scan on
        // each frame, including when the scroller's dimensions change.
        if (!targets?.length || !host.contains(targets[0])) {
          const seen = new Set<string>();
          targets = [...host.querySelectorAll<HTMLElement>('[data-o8-turn-id], [data-o8-message-id]')].filter(element => {
            const id = element.dataset.o8TurnId ?? element.dataset.o8MessageId ?? '';
            if (!ids.has(id) || seen.has(id)) return false;
            seen.add(id); return true;
          });
        }
        let low = 0; let high = targets.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (targets[middle].getBoundingClientRect().top <= top) low = middle + 1;
          else high = middle;
        }
        const current = targets[Math.max(0, low - 1)];
        setActive(current?.dataset.o8TurnId ?? current?.dataset.o8MessageId ?? promptIds[0] ?? '');
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    if (host.firstElementChild) observer.observe(host.firstElementChild);
    host.addEventListener('scroll', measure, { passive: true });
    measure();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); host.removeEventListener('scroll', measure); };
  }, [promptGeometryKey, scrollRef]);
  if (!visible) return null;
  return <nav aria-label="Conversation prompts" onMouseLeave={() => setHovered(-1)} style={{
    position: 'absolute', left: 2, top: 24, bottom: 30, width: 24, zIndex: 4,
    display: 'flex', flexDirection: 'column', justifyContent: 'safe center', overflowY: 'auto', scrollbarWidth: 'none',
  }}>
    {prompts.map((prompt, index) => <TranscriptPrompt key={prompt.id} {...prompt} index={index} scrollRef={scrollRef}
      active={active === prompt.id} onHover={setHovered}
      highlighted={active === prompt.id || hovered === index}
      width={hovered >= 0 ? Math.max(6, 23 - Math.abs(index - hovered) * 5) : active === prompt.id ? 16 : 7}
      height={Math.max(5, Math.min(18, 500 / prompts.length))} />)}
  </nav>;
}

const TranscriptPrompt = memo(function TranscriptPrompt({ id, title, answer, index, scrollRef, active, onHover, highlighted, width, height }: {
  id: string; title: string; answer: string; index: number;
  scrollRef: RefObject<HTMLDivElement | null>; active: boolean;
  onHover: (index: number) => void; highlighted: boolean; width: number; height: number;
}) {
  return <TranscriptPeek width={340} placement="right" preview={() => <>
      <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{title}</div>
      <div style={{ fontSize: 12, lineHeight: 1.6, marginTop: 8, color: 'var(--t-text-secondary)', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>{answer || 'No response yet'}</div>
    </>}>
      <button type="button" aria-label={`Jump to prompt ${index + 1}: ${title.slice(0, 100)}`}
        aria-current={active ? 'step' : undefined} onMouseEnter={() => onHover(index)}
        onClick={() => {
          const host = scrollRef.current;
          const target = [...host?.querySelectorAll<HTMLElement>('[data-o8-turn-id], [data-o8-message-id]') ?? []]
            .find(element => (element.dataset.o8TurnId ?? element.dataset.o8MessageId) === id);
          if (!host || !target) return;
          const zoom = host.getBoundingClientRect().height / host.offsetHeight || 1;
          host.scrollTo({ top: host.scrollTop + (target.getBoundingClientRect().top - host.getBoundingClientRect().top) / zoom - 18,
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
        }} style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', width: 24, height,
          border: 0, padding: 0, background: 'transparent', cursor: 'pointer' }}>
        <span style={{ display: 'block', height: 2, borderRadius: 2,
          width, background: highlighted ? 'var(--t-text)' : 'var(--t-text-faint)', opacity: highlighted ? 1 : 0.45 }} />
      </button>
    </TranscriptPeek>;
});
