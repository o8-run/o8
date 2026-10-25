'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, GitPullRequest } from '../lucide-shims';
import { PrActionMenu, prActionButton, type PrMenuItem } from './PrActionMenu';
import { PrActionConfirm } from './PrActionConfirm';
import { usePrComment, type PrWriteAction } from './usePrComment';
import type { PrComposerMode, PrDetail, PrMergeMethod } from './types';

const methods: Array<{ id: PrMergeMethod; label: string }> = [{ id: 'merge', label: 'Merge' }, { id: 'squash', label: 'Squash and merge' }, { id: 'rebase', label: 'Rebase and merge' }];
type Confirmation = { action: PrWriteAction; title: string; head: string; method?: PrMergeMethod; gate?: string };

export function PrPanelActions({ detail, repoSlug, onRefresh, onAsk, onComposerMode }: { detail: PrDetail; repoSlug?: string | null; repoPath?: string | null; onRefresh: () => void; onAsk: (prompt?: string) => void; onComposerMode: (mode: PrComposerMode) => void }) {
  const repo = detail.resolvedRepo || repoSlug;
  const write = usePrComment(repo, detail.number);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [notice, setNotice] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Completion state belongs to the hook's repository/PR key; never retarget it.
  const busy = write.busy;
  const open = detail.state.toLowerCase() === 'open' && !detail.mergedAt;
  const blocked = busy || write.uncertain;
  const gateAllowed = detail.mergeGate?.allowed ?? true;
  const confirmationChanged = Boolean(confirmation && (confirmation.head !== detail.headSha || (confirmation.gate && confirmation.gate !== detail.mergeGate?.snapshot)));
  const confirmationRefused = Boolean(confirmation && ['merge', 'enable-auto-merge'].includes(confirmation.action) && !gateAllowed);
  const allowed = methods.filter((method) => !detail.allowedMergeMethods || detail.allowedMergeMethods.includes(method.id));
  const defaultMethod = allowed.find((method) => method.id === 'squash')?.id || allowed[0]?.id;
  const prepare = (action: Confirmation['action'], title: string, method?: PrMergeMethod) => { returnFocus.current = document.activeElement instanceof HTMLButtonElement && root.current?.contains(document.activeElement) ? document.activeElement : null; setConfirmation({ action, title, head: detail.headSha || '', method, gate: ['merge', 'enable-auto-merge'].includes(action) ? detail.mergeGate?.snapshot : undefined }); };
  const cancel = () => { setConfirmation(null); returnFocus.current?.focus({ preventScroll: true }); };
  const copy = async (text: string, label: string) => { try { await navigator.clipboard.writeText(text); setNotice(label); } catch { setNotice('Could not copy. Try again.'); } };
  const mergeItems: PrMenuItem[] = methods.map((method) => ({ label: method.label, disabled: blocked || !gateAllowed || !open || detail.draft || !detail.headSha || !allowed.some((entry) => entry.id === method.id), onSelect: () => prepare('merge', method.label, method.id) }));
  const items: PrMenuItem[] = [
    { label: 'Ask Brain', onSelect: () => onAsk() },
    { label: 'Explain this pull request', onSelect: () => onAsk('Explain this pull request and what I should read closely. Be explicit about any code you have not inspected.') },
    { label: 'Discuss review findings', onSelect: () => onAsk('Help me understand the review findings on this pull request and plan the next steps. Do not make changes yet.') },
    { label: 'Write a comment', onSelect: () => onComposerMode('comment') },
    { label: 'Submit a review', onSelect: () => onComposerMode('review') },
    { label: '', divider: true },
    ...(open ? [{ label: detail.draft ? 'Ready for review' : 'Convert to draft', disabled: blocked || !detail.headSha, onSelect: () => prepare(detail.draft ? 'ready' : 'draft', detail.draft ? 'Ready for review' : 'Convert to draft') }, { label: detail.autoMergeEnabled ? 'Disable auto-merge' : 'Enable auto-merge', disabled: blocked || detail.draft || !detail.headSha || !defaultMethod || (!detail.autoMergeEnabled && !gateAllowed), onSelect: () => prepare(detail.autoMergeEnabled ? 'disable-auto-merge' : 'enable-auto-merge', detail.autoMergeEnabled ? 'Disable auto-merge' : 'Enable auto-merge', defaultMethod) }] : []),
    ...mergeItems,
    { label: '', divider: true },
    { label: 'Refresh', onSelect: onRefresh },
    { label: 'Open on GitHub', onSelect: () => window.open(detail.url, '_blank', 'noopener,noreferrer') },
    { label: 'Copy link', onSelect: () => void copy(detail.url, 'Pull request link copied.') },
    { label: 'Copy PR number', onSelect: () => void copy(String(detail.number), 'Pull request number copied.') },
    ...(open ? [{ label: '', divider: true }, { label: 'Close pull request', danger: true, disabled: blocked, onSelect: () => prepare('close', 'Close pull request') }] : []),
  ];
  const confirm = async () => {
    if (!confirmation || blocked || confirmationChanged || confirmationRefused || !confirmation.head) return;
    const action = confirmation;
    const done = await write.post('', action.action, action.head, action.method, action.gate);
    if (done && mounted.current) { setConfirmation(null); onRefresh(); setNotice(action.action === 'merge' ? 'Pull request merged.' : action.action === 'close' ? 'Pull request closed.' : action.action === 'enable-auto-merge' ? 'Auto-merge enabled.' : action.action === 'disable-auto-merge' ? 'Auto-merge disabled.' : action.action === 'draft' ? 'Converted to draft.' : 'Ready for review.'); }
  };
  return <div ref={root} data-pr-actions style={{ position: 'relative', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginLeft: 'auto', maxWidth: '100%' }}>
    <PrActionMenu label="Check out pull request" disabled={busy} items={[
      { label: 'Copy checkout command', disabled: !repo, onSelect: () => void copy(`gh pr checkout ${detail.number} --repo ${repo}`, 'Checkout command copied.') },
    ]}><GitPullRequest size={12} aria-hidden="true" />Check out<ChevronDown size={11} aria-hidden="true" /></PrActionMenu>
    {open ? detail.draft ? <button type="button" disabled={blocked || !detail.headSha} onClick={() => prepare('ready', 'Ready for review')} style={{ ...prActionButton, color: 'var(--t-accent)', opacity: blocked ? 0.45 : 1 }}>Ready for review</button> : <PrActionMenu label="Merge pull request" primary disabled={blocked || !detail.headSha || !allowed.length} items={mergeItems}><GitPullRequest size={12} aria-hidden="true" />Merge<ChevronDown size={11} aria-hidden="true" /></PrActionMenu> : null}
    <PrActionMenu label="Pull request actions" disabled={busy} items={items}><span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1, letterSpacing: 1 }}>···</span></PrActionMenu>
    {confirmation ? <PrActionConfirm title={`${confirmation.title} · #${detail.number}`} label={confirmation.title} busy={busy} disabled={blocked || confirmationChanged || confirmationRefused || !confirmation.head} onCancel={cancel} onConfirm={() => void confirm()}>
      {confirmationChanged || confirmationRefused ? <span role="alert" style={{ color: 'var(--t-danger)' }}>The pull request changed. Cancel and review the latest commit and merge gates.</span> : <>
        <div style={{ marginBottom: 8 }}>{confirmation.action === 'enable-auto-merge' ? 'GitHub will merge when its rules are satisfied. It may merge immediately if ready.' : confirmation.action === 'merge' ? `Merge into ${detail.baseRefName} using ${confirmation.method}. GitHub checks repository rules before merging.` : confirmation.action === 'close' ? 'Close this pull request on GitHub. Its branch is kept.' : 'Update this pull request on GitHub.'}</div>
        <span>Commit {confirmation.head.slice(0, 8)}</span>
      </>}
    </PrActionConfirm> : null}
    {notice ? <span role="status" style={{ width: '100%', fontSize: 11, color: 'var(--t-text-muted)' }}>{notice}</span> : null}
    {detail.mergeGate && !gateAllowed ? <span role="status" style={{ width: '100%', fontSize: 11, color: 'var(--t-danger)' }}>{detail.mergeGate.checks.find(check => check.verdict === 'fail')?.detail || 'Merge gates are unavailable. Refresh before merging.'}</span> : null}
    {write.error ? <div role="alert" style={{ width: '100%', fontSize: 11, lineHeight: 1.5, color: 'var(--t-danger)' }}>{write.error}<a href={detail.url} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 6, color: 'var(--t-accent)' }}>Check GitHub</a>{write.uncertain ? <button type="button" disabled={busy} onClick={() => { write.acknowledge(); onRefresh(); }} style={{ ...prActionButton, marginTop: 6 }}>I’ve checked the result</button> : null}</div> : null}
  </div>;
}
