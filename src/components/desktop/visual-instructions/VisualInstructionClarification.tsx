'use client';

import { useEffect, useRef, useState } from 'react';
import { RamsButton } from '@/components/desktop/settings/RamsButton';
import { HeaderIconPill } from '@/components/desktop/shell/HeaderIconPill';
import { ComposerPopover } from '@/components/desktop/thoughts/chat-panel/ComposerPopover';
import { FloatingSurface } from '@/components/desktop/FloatingSurface';
import { requestRippleResolution } from '@/lib/mobile/ripple-client';
import type { RippleChoiceResolution } from '@/lib/mobile/ripple-contract';
import { openVisualQuestion, confirmVisualQuestion, currentVisualQuestion, dismissVisualQuestion } from '@/lib/composer/visual-clarification';
import { currentMeaningCheck } from '@/lib/composer/visual-meaning';
import { readVisualDraft, saveVisualDraft, type VisualInstructionDraft } from '@/lib/composer/visual-draft-store';

/** Clarification is optional and belongs to the exact words and frames the user reviewed. */
type Props = { draft: VisualInstructionDraft; disabled: boolean };
export function VisualInstructionClarification(props: Props) {
  const { request } = props.draft;
  return <ClarificationState key={JSON.stringify([props.draft.principal, request.id, request.utterance, request.frames.map(frame => [frame.id, frame.observation?.id, frame.observation?.revision]), request.clarification ?? null,
    currentVisualQuestion(props.draft)?.id, currentMeaningCheck(props.draft)?.status])} {...props} />;
}
function ClarificationState({ draft, disabled }: Props) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [choice, setChoice] = useState<RippleChoiceResolution | null>(() => currentVisualQuestion(draft));
  const [open, setOpen] = useState(() => Boolean(currentVisualQuestion(draft)));
  const anchor = useRef<HTMLDivElement | null>(null);
  const run = useRef(0);
  useEffect(() => () => { run.current += 1; }, []);
  const resolve = async () => {
    const ticket = ++run.current;
    setBusy(true); setNotice(''); setOpen(true);
    const frame = draft.request.frames.at(-1);
    if (frame?.observation) {
      const question = openVisualQuestion(draft);
      setBusy(false); setChoice(question);
      if (!question) setNotice('Your agent will inspect the picture before changing the component.');
      return;
    }
    const resolution = await requestRippleResolution({ utterance: draft.request.utterance, repoName: draft.request.target.repoPath.split('/').pop() });
    if (ticket !== run.current || readVisualDraft(draft.principal, draft.request.target) !== draft) return;
    setBusy(false);
    if (resolution.kind === 'choice') setChoice(resolution);
    else setNotice('No clarification returned. Send when ready.');
  };
  const confirm = (value: string) => {
    const current = readVisualDraft(draft.principal, draft.request.target);
    if (!choice || current !== draft || current.status !== 'draft') { setChoice(null); return; }
    if (currentVisualQuestion(draft)) { void confirmVisualQuestion(draft, value).catch(error => setNotice(String(error))); setChoice(null); setOpen(false); return; }
    void saveVisualDraft({ ...draft, request: { ...draft.request, clarification: { id: choice.id, path: choice.aodlPath, value, question: choice.question } } })
      .catch(error => setNotice(String(error)));
    setChoice(null); setOpen(false);
  };
  const dismiss = () => {
    run.current += 1;
    void dismissVisualQuestion(draft).catch(error => setNotice(String(error)));
    setChoice(null); setBusy(false); setOpen(false);
  };
  const confirmed = currentMeaningCheck(draft)?.selectedValue ?? draft.request.clarification?.value;
  return <div ref={anchor} style={{ display: 'flex', fontSize: 12, color: 'var(--t-text-muted)' }}>
    <HeaderIconPill label={confirmed ? 'Review confirmed intent' : 'Clarify intent'} title="Clarify intent · optional" expanded={open} popup="dialog" yNudge={0}
      disabled={disabled || busy || !draft.request.utterance.trim() || draft.request.utterance.length > 4000}
      icon={<svg aria-hidden width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /></svg>}
      onClick={() => { if (open) dismiss(); else if (confirmed || choice || notice) setOpen(true); else void resolve(); }} />
    <ComposerPopover anchorRef={anchor} open={open} onClose={dismiss} align="start"><FloatingSurface overlay role="dialog" aria-label="Clarify visual intent"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); dismiss(); return; }
        const option = choice?.options[Number(event.key) - 1];
        if (option && !disabled) { event.preventDefault(); confirm(option.value); }
      }}
      style={{ width: 280, maxWidth: 'calc(100vw - 24px)', borderRadius: 12 }} contentStyle={{ padding: 16, fontSize: 12, fontWeight: 300, lineHeight: 1.5 }}>
      <div style={{ fontSize: 10, color: 'var(--t-text-muted)', marginBottom: 8 }}>Clarify intent · optional</div>
      {busy ? <p role="status" style={{ margin: 0 }}>Reading your instruction…</p> : null}
      {choice ? <div><p style={{ marginTop: 0, marginBottom: 12 }}>{choice.question}</p><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {choice.options.map(option => <RamsButton key={option.value} variant="ghost" disabled={disabled} onClick={() => confirm(option.value)}>{option.label}</RamsButton>)}
      <RamsButton variant="ghost" onClick={dismiss}>Skip</RamsButton>
    </div></div> : null}
    {busy ? <RamsButton variant="ghost" onClick={dismiss}>Skip</RamsButton> : null}
    {confirmed ? <p style={{ margin: 0 }}>Confirmed: {confirmed}</p> : null}
    {notice ? <p role="status" style={{ margin: 0 }}>{notice}</p> : null}
    </FloatingSurface></ComposerPopover>
  </div>;
}
