'use client';
import { RamsButton } from '../desktop/settings/RamsButton';
import { useConversationPrs } from './useConversationPrs';
export const OPEN_PR_CONVERSATION = 'o8:open-pr-conversation';
export function PullRequestConversations({ repo, number, active = true, mobile = false, onOpen }: { repo: string; number: number; active?: boolean; mobile?: boolean; onOpen?: () => void }) {
  const { links, error, loading } = useConversationPrs(mobile ? '/api/mobile/conversation-pr-context' : '/api/orchestrator/pull-request-context', `repo=${encodeURIComponent(repo)}&number=${number}&refresh=missing`, active && Boolean(repo));
  const threads = [...new Map(links.map(link => [link.threadId, link])).values()];
  return <section aria-label="Linked conversations" style={{ paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, fontSize: 12, color: 'var(--t-text-muted)' }}>
    <div>Conversations{loading ? ' · loading…' : ''}</div>
    {threads.map(link => <RamsButton variant="ghost" key={link.threadId} disabled={!link.threadAvailable} onClick={() => { window.dispatchEvent(new CustomEvent(OPEN_PR_CONVERSATION, { detail: { threadId: link.threadId, title: link.threadTitle } })); onOpen?.(); }}>{link.threadTitle} · {links.filter(other => other.threadId === link.threadId).map(other => other.kind).join(', ')}{!link.threadAvailable ? ' · history removed' : ''}</RamsButton>)}
    {error ? <div role="status">{error}</div> : null}
  </section>;
}
