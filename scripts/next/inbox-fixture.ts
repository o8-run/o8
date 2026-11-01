/** Persisted, account-free Inbox data for the existing production route host. */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import type { ApprovalRecord } from '../../src/lib/approvals/types';
import type { SupervisorInboxItem } from '../../src/lib/supervisor/inbox';
import type { MaintainerFeed, MaintainerContribution } from '../../src/lib/inbox/maintainer-types';
import type { AgentConversation } from '../../src/lib/agents/store';

/** Seed the existing durable bus directly, without discovery, delivery or provider turns. */
async function seedAgentExchangeFixtures(repo: string) {
  const { persistAgentMessage } = await import('../../src/lib/agents/store');
  const { getSqlite } = await import('../../src/lib/db');
  const refs = { laneId: null, packetId: null, identities: {
    from: { runtime: 'poll', sessionKey: 'poll:inbox-aster' },
    to: { runtime: 'poll', sessionKey: 'poll:inbox-birch' },
  } };
  const first = persistAgentMessage({ repo, from: 'Aster', to: 'Birch', text: 'Exchange one opening.', refs }).message;
  persistAgentMessage({ repo, from: 'Birch', to: 'Aster', text: 'Exchange one peer response.',
    replyToId: first.id, refs: { ...refs, identities: { from: refs.identities.to, to: refs.identities.from } } });
  const second = persistAgentMessage({ repo, from: 'Aster', to: 'Birch', text: 'Separate exchange, same peers.', refs }).message;
  const terminal = persistAgentMessage({ repo, from: 'Aster', to: 'Birch', text: 'Check the finished exchange.', refs }).message;
  persistAgentMessage({ repo, from: 'Birch', to: 'Aster', text: 'Final exchange response.',
    replyToId: terminal.id, close: true, refs: { ...refs, identities: { from: refs.identities.to, to: refs.identities.from } } });
  persistAgentMessage({ repo: `${repo}/exchange-secondary`, from: 'Aster', to: 'Birch', text: 'Exchange in another repository.', refs });
  const summary = getSqlite().prepare('UPDATE agent_conversations SET summary = ? WHERE id = ?');
  summary.run('Keep the exchange summary.', first.conversation!.id);
  summary.run('Separate same-peer exchange.', second.conversation!.id);
}

export async function seedInboxFixture(repo: string, dataDir: string) {
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/inbox-fixture.git']);
  const { addRepo } = await import('../../src/lib/repos/registry');
  await addRepo(repo);
  const store = await import('../../src/lib/github-broker/store');
  const date = new Date(Date.now() - 48 * 3_600_000).toISOString();
  for (const number of [41, 43, 44]) {
    store.upsertGitHubIssue({ issueId: number, repoFullName: 'example/inbox-fixture', number,
      title: `Fixture issue ${number}`, state: 'open', author: { login: 'contributor' },
      assignees: number === 43 ? [{ login: 'contributor' }] : [],
      labels: number === 43 ? [{ name: 'claimed', color: 'ededed' }] : [], comments: 1,
      body: 'Fixture conversation', url: `https://github.com/example/inbox-fixture/issues/${number}`,
      createdAt: date, updatedAt: date, closedAt: null });
    if (number !== 43) store.updateGitHubThreadAttention({ repoFullName: 'example/inbox-fixture', kind: 'issue', number,
      lastHumanCommentAuthorLogin: 'contributor', lastHumanCommentAuthorAssociation: 'FIRST_TIME_CONTRIBUTOR',
      lastHumanCommentAt: date, lastInsiderCommentAt: null });
  }
  store.upsertGitHubPullRequest({ pullRequestId: 42, repoFullName: 'example/inbox-fixture', number: 42,
    title: 'Fixture pull request', state: 'open', author: { login: 'contributor' }, body: 'Fixture change',
    headRefName: 'fixture/change', baseRefName: 'main', additions: 1, deletions: 0, changedFiles: 1,
    reviewDecision: null, statusCheckRollup: [], url: 'https://github.com/example/inbox-fixture/pull/42',
    createdAt: date, updatedAt: date, closedAt: null, mergedAt: null });
  store.markGitHubSyncSuccess('example/inbox-fixture', 'issues');
  store.markGitHubSyncSuccess('example/inbox-fixture', 'pull_requests');
  const inbox = await import('../../src/lib/supervisor/inbox');
  inbox.buildOutsideHumanWaitingInbox();
  const outside = inbox.listInboxItems({ includeAllProjects: true }).find((item) => item.payload.threadNumber === 44)!;
  inbox.dismissInboxItem(outside.id);
  for (const [kind, status] of [
    ['verification_failed', 'human_required'], ['session_lost', 'healing'],
    ['merge_blocked', 'escalated'], ['possible_loop', 'pending'],
    ['packet_no_changes', 'resolved'], ['silent_exit_but_work_present', 'self_healed'],
  ] as const) inbox.enqueueInboxItem({ repoPath: repo, kind, status, payload: {
    title: `Fixture ${kind}`, body: `Details for ${kind}`, sessionKey: 'llm-chat:thoughts-review',
  } });
  const { createApproval } = await import('../../src/lib/approvals/store');
  const approvals = ['Native approve', 'Desktop approve', 'Native reject', 'Worker denied', 'Unconfirmed continuation'].map((title) => createApproval({
    source: 'test', runtime: 'pi', agent: 'Fixture agent', sessionKey: 'llm-chat:thoughts-review',
    title, description: `Inspect ${title}`, summary: title, toolName: 'fixture_action', risk: 'medium',
    metadata: { RepoPath: repo },
  }));
  // A recorded decision with an uncertain continuation remains visible but cannot be resolved again.
  const { getSqlite } = await import('../../src/lib/db');
  const uncertain = approvals.at(-1)!;
  const columns = getSqlite().prepare('PRAGMA table_info(approvals)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'resolution_json')) throw new Error('Approval fixture schema changed');
  getSqlite().prepare("UPDATE approvals SET status = 'approved', resolution_json = ? WHERE id = ?")
    .run(JSON.stringify({ action: 'approved', actor: 'desktop', continuationStatus: 'outcome_unknown' }), uncertain.id);
  writeFileSync(`${dataDir}/worker-token`, 'fixture-inbox-worker-credential', { mode: 0o600 });
  await seedAgentExchangeFixtures(repo);
  return approvals;
}

/** Oracle uses desktop routes and its reply queue, independently of the Rust model. */
export async function writeInboxOracle(file: string, repo: string, token: string) {
  const { GET: inbox } = await import('../../src/app/api/panel/supervisor-inbox/route');
  const { GET: approvals } = await import('../../src/app/api/panel/approvals/route');
  const { maintainerReplyQueue } = await import('../../src/lib/inbox/maintainer-replies');
  const { GET: conversations } = await import('../../src/app/api/agents/conversation/route');
  const { getSqlite } = await import('../../src/lib/db');
  const agentExchanges: AgentConversation[] = [];
  for (const scope of [repo, `${repo}/exchange-secondary`]) {
    const result = await conversations(new NextRequest(`http://127.0.0.1/api/agents/conversation?repo=${encodeURIComponent(scope)}&limit=100`, {
      headers: { authorization: `Bearer ${token}` },
    }));
    if (result.status !== 200) throw new Error(`Conversation fixture failed with HTTP ${result.status}`);
    agentExchanges.push(...(await result.json() as { conversations: AgentConversation[] }).conversations);
  }
  const response = await inbox(new Request('http://127.0.0.1/api/panel/supervisor-inbox?scope=all&includeDismissed=1&includeMaintainer=1'));
  const body = await response.json() as { items: SupervisorInboxItem[]; maintainer: MaintainerFeed };
  const approvalBody = await (await approvals(new NextRequest('http://127.0.0.1/api/panel/approvals?status=pending&scope=all'))).json() as { approvals: ApprovalRecord[] };
  const items = body.items.filter((item) => !item.problemDossierId);
  const active = (item: SupervisorInboxItem) => ['pending', 'healing', 'human_required', 'escalated'].includes(item.status);
  const card = (item: SupervisorInboxItem | MaintainerContribution | ApprovalRecord) => ({
    id: item.id, status: 'status' in item ? item.status : item.kind === 'claim' ? 'claimed' : item.kind === 'reply' ? 'waiting' : 'open',
    source: 'payload' in item ? item.kind : 'source' in item ? item.source : item.repo,
    title: 'payload' in item && item.kind === 'outside_human_waiting' ? String(item.payload.threadTitle) : 'title' in item ? item.title : String(item.payload.title),
  });
  writeFileSync(file, JSON.stringify({
    replies: maintainerReplyQueue(items, body.maintainer.replies).map(card),
    contributions: body.maintainer.contributions.map(card), approvals: approvalBody.approvals.map(card),
    agents: items.filter((item) => active(item) && item.kind !== 'outside_human_waiting').map(card),
    history: items.filter((item) => !active(item)).map(card),
    agentExchanges,
    agentExchangeMessages: getSqlite().prepare('SELECT id, text, conversation_id AS conversationId FROM agent_messages ORDER BY sequence').all(),
  }));
}
