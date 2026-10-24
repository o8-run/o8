'use client';
import { RamsButton } from '../desktop/settings/RamsButton';
import { useEffect, useId, useRef, useState } from 'react';
import { contextRequest, CONVERSATION_PR_CHANGED, useConversationPrs } from './useConversationPrs';
import { parsePullRequestLink, type LinkedPullRequest } from '../desktop/pr-panel/linked-pr-store';
import type { PullRequestContextIdentity, PullRequestContextLink } from '@/lib/orchestrator/pull-request-context';
const ENDPOINT = '/api/orchestrator/pull-request-context';
const selectStyle: React.CSSProperties = { borderWidth: 0, borderStyle: 'none', borderRadius: 6, paddingTop: 6, paddingRight: 6, paddingBottom: 6, paddingLeft: 6, fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 'inherit', background: 'var(--t-hover)', color: 'var(--t-text)', cursor: 'pointer' };
export function ConversationPullRequests(props: { threadId: string; active?: boolean; readOnly?: boolean; repo?: string | null; legacyLinks?: LinkedPullRequest[]; onOpen?: (number: number, repo: string) => void }) {
  return <ConversationLinks key={props.threadId} {...props} />;
}
function ConversationLinks({ threadId, active = true, readOnly = false, repo = null, legacyLinks = [], onOpen }: Parameters<typeof ConversationPullRequests>[0]) {
  const endpoint = readOnly ? '/api/mobile/conversation-pr-context' : ENDPOINT;
  const { links, error, loading } = useConversationPrs(endpoint, `threadId=${encodeURIComponent(threadId)}`, active);
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<'context' | 'review' | 'import'>('context');
  const [stage, setStage] = useState<string | null>(null);
  const busy = stage !== null;
  const [failure, setFailure] = useState<string | null>(null);
  const id = useId();
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), [active]);
  const mutate = async (remove: boolean, entry?: PullRequestContextLink, saved?: LinkedPullRequest) => {
    if (busy || request.current || !active || readOnly) return;
    const controller = new AbortController(); request.current = controller;
    setStage(remove ? 'Removing conversation link…' : 'Reading pull request…'); setFailure(null);
    try {
      let identity: PullRequestContextIdentity;
      if (entry) identity = entry;
      else {
        const parsed = saved ?? parsePullRequestLink(value, repo);
        if (!parsed) throw new Error('Enter a GitHub pull request URL or a number for this repository.');
        setStage('Resolving PR identity…');
        const result = await contextRequest<{ identity: PullRequestContextIdentity }>(`${ENDPOINT}?repo=${encodeURIComponent(parsed.repo)}&number=${parsed.number}&resolve=1&refresh=1`, { signal: controller.signal });
        identity = result.identity;
      }
      if (controller.signal.aborted) return;
      setStage(remove ? 'Removing conversation link…' : 'Saving conversation link…');
      await contextRequest(ENDPOINT, { method: remove ? 'DELETE' : 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...identity, threadId, kind: entry?.kind ?? (saved ? 'import' : kind) }) });
      if (!controller.signal.aborted) { setValue(''); window.dispatchEvent(new Event(CONVERSATION_PR_CHANGED)); }
    } catch (cause) { if (!controller.signal.aborted) setFailure(cause instanceof Error ? cause.message : 'The link could not be saved.'); }
    finally { if (request.current === controller) { request.current = null; setStage(null); } }
  };
  return <section aria-label="Conversation pull requests" style={{ paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: 'var(--t-divider-subtle)', fontSize: 12, color: 'var(--t-text)', flexShrink: 0 }}>
    <div style={{ color: 'var(--t-text-muted)', marginBottom: 6 }}>Linked PRs</div>
    {loading ? <div role="status">Loading linked PRs…</div> : !links.length && !error ? <div style={{ color: 'var(--t-text-muted)' }}>No linked pull requests.</div> : null}
    {links.map(link => <div key={link.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
      {onOpen ? <RamsButton variant="ghost" onClick={() => onOpen(link.number, link.repositoryFullName)}>{link.repositoryFullName} #{link.number}</RamsButton>
        : <a href={link.url} target="_blank" rel="noreferrer">{link.repositoryFullName} #{link.number}</a>}
      <span style={{ color: 'var(--t-text-muted)' }}>{link.kind === 'delivery' ? `Primary delivery · ${link.packetId}` : link.kind}</span>
      {!readOnly && link.source === 'operator' ? <RamsButton variant="ghost" disabled={busy} aria-label={`Unlink ${link.kind} PR #${link.number} in ${link.repositoryFullName}`} onClick={() => void mutate(true, link)}>Unlink</RamsButton> : null}
    </div>)}
    {!readOnly ? <details style={{ marginTop: 8 }}><summary style={{ cursor: 'pointer', color: 'var(--t-text-muted)' }}>Link PR</summary>
      <form onSubmit={event => { event.preventDefault(); void mutate(false); }} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        <label htmlFor={id}>GitHub URL{repo ? ' or PR number' : ''}</label>
        <input id={id} value={value} disabled={busy} onChange={event => setValue(event.target.value)} style={{ minWidth: 0, flex: '1 1 180px', background: 'var(--t-input-bg)', color: 'var(--t-text)', borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-divider)', borderRadius: 6, paddingTop: 6, paddingRight: 6, paddingBottom: 6, paddingLeft: 6, fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 'inherit' }} />
        <select aria-label="PR association role" value={kind} disabled={busy} onChange={event => setKind(event.target.value as typeof kind)} style={selectStyle}><option value="context">Context</option><option value="review">Review</option><option value="import">Import</option></select>
        <RamsButton type="submit" busy={busy} disabled={!value.trim()}>{stage ?? 'Link PR'}</RamsButton>
      </form>
      <p style={{ color: 'var(--t-text-muted)' }}>Saves a conversation link. The packet’s primary delivery PR stays separate.</p>
      {legacyLinks.filter(saved => !links.some(link => link.repositoryFullName.toLowerCase() === saved.repo && link.number === saved.number)).map(saved => <div key={`${saved.repo}#${saved.number}`} style={{ marginTop: 4 }}>{saved.repo} #{saved.number} · saved on this device <RamsButton variant="ghost" disabled={busy} onClick={() => void mutate(false, undefined, saved)}>Import saved link</RamsButton></div>)}
    </details> : null}
    {error || failure ? <div role="alert" style={{ color: 'var(--t-danger)', marginTop: 6 }}>{failure || error}</div> : null}
  </section>;
}
