'use client';

import { useState } from 'react';
import { RamsButton } from '@/components/desktop/settings/shared';

/** A visualization proposes a question; the reader explicitly adds it to the draft. */
export function VisualizationQuestion({ title, question, onClose }: { title: string; question: string; onClose: () => void }) {
  const [error, setError] = useState('');
  function add() {
    const composer = document.querySelector<HTMLTextAreaElement>('textarea[data-o8-active-composer="true"]');
    // Add a question after the reader's draft rather than replace a selected phrase.
    composer?.setSelectionRange(composer.value.length, composer.value.length);
    if (!insertIntoActiveComposer(`${composer?.value.trim() ? '\n\n' : ''}About “${title}”: ${question}\n`)) {
      setError('Open a chat composer to use this question.');
      return;
    }
    onClose();
  }
  return <div role="region" aria-label="Question about this visualization" style={{ marginTop: 12, paddingTop: 12, paddingBottom: 12,
    paddingLeft: 14, paddingRight: 14, borderRadius: 12, border: '1px solid var(--t-border)', background: 'var(--t-popover-surface)',
    backdropFilter: 'blur(var(--t-popover-blur, 24px))', WebkitBackdropFilter: 'blur(var(--t-popover-blur, 24px))', color: 'var(--t-text-primary)' }}>
    <div style={{ fontSize: 11, fontWeight: 300, color: 'var(--t-text-muted)', marginBottom: 6 }}>Ask about this</div>
    <div style={{ fontSize: 13, fontWeight: 300, lineHeight: 1.55, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{question}</div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
      <RamsButton onClick={add}>Add to chat</RamsButton>
      <RamsButton variant="ghost" onClick={onClose}>Dismiss</RamsButton>
    </div>
    {error ? <div role="status" style={{ marginTop: 8, fontSize: 11, color: 'var(--t-text-muted)' }}>{error}</div> : null}
  </div>;
}

function insertIntoActiveComposer(body: string): boolean {
  const composer = document.querySelector<HTMLTextAreaElement>('textarea[data-o8-active-composer="true"]');
  if (!composer) return false;
  const start = composer.selectionStart ?? composer.value.length;
  const end = composer.selectionEnd ?? start;
  const nextValue = `${composer.value.slice(0, start)}${body}${composer.value.slice(end)}`;
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (valueSetter) valueSetter.call(composer, nextValue);
  else composer.value = nextValue;
  composer.dispatchEvent(typeof InputEvent === 'function'
    ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: body })
    : new Event('input', { bubbles: true }));
  const cursor = start + body.length;
  window.requestAnimationFrame(() => {
    composer.focus();
    composer.setSelectionRange(cursor, cursor);
  });
  return true;
}
