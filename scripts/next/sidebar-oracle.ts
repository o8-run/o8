/** Production HTTP records plus desktop attention sorting, used by native tests. */
import { attentionRank, derivePrioritySplit } from '../../src/components/desktop/repo-focus/tabs/chats/sections';
import { staysInWorkingView } from '../../src/components/desktop/repo-focus/tabs/chats/sidebar-view';

type Thread = { id: string; title: string; repoPath?: string; lastMessageAt: string; status: string; unread?: boolean };
type SidebarRow = { kind: string; workspace: string; id: string | null; title: string; status: string; unread: boolean; running: boolean };
export async function sidebarOracle(origin: string) {
  const headers = { authorization: `Bearer ${process.env.O8_NEXT_API_TOKEN}` };
  async function get(path: string) {
    const response = await fetch(origin + path, { headers });
    if (!response.ok) throw new Error('Fixture route failed');
    return response.json();
  }
  const threads: Thread[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = (await get(`/api/mobile/orchestrator/threads?limit=500&offset=${offset}`)).threads as Thread[];
    threads.push(...page.map(thread => ({ ...thread, status: thread.status === 'busy' ? 'running' : thread.status })));
    if (page.length < 500) break;
  }
  const inventory = await get('/api/runtime/inventory?fresh=1');
  for (const agent of inventory.agents ?? []) {
    if (!threads.some(thread => `llm-chat:${thread.id}` === agent.sessionKey)) threads.push({
      id: agent.sessionKey, title: agent.name, status: agent.status, repoPath: agent.workspace,
      lastMessageAt: String(agent.lastActivityAt).padStart(20, '0'),
    });
  }
  const archived = await get('/api/v2/chat-history/list?include=orchestrator&archived=only');
  for (const row of archived.conversations) threads.push({ id: row.tabId, title: row.title,
    status: 'archived', repoPath: row.repoPath, lastMessageAt: row.modifiedAt });
  const section = (s: Thread) => s.status === 'archived' ? 'Archived' : s.id.includes(':') ? 'Workers'
    : attentionRank(s) > 0 ? 'Review' : staysInWorkingView(s) ? 'Working' : 'Recent';
  const label = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path;
  const workspaces = [...new Set(threads.map(thread => thread.repoPath ?? 'Unassigned'))]
    .sort((a, b) => label(a).toLowerCase().localeCompare(label(b).toLowerCase()) || a.localeCompare(b));
  return workspaces.flatMap(workspace => {
    const header = (kind: string, title: string) => ({ kind, workspace, id: null, title, status: '', unread: false, running: false });
    const result: SidebarRow[] = [header('workspace', label(workspace))];
    for (const name of ['Working', 'Review', 'Recent', 'Workers', 'Archived']) {
      const candidates = threads.filter(s => (s.repoPath ?? 'Unassigned') === workspace && section(s) === name);
      const rows = name === 'Review' ? derivePrioritySplit(candidates.map(s => ({ ...s, modifiedAt: s.lastMessageAt }))).priority
        : candidates.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
      if (!rows.length) continue;
      result.push(header('section', name));
      result.push(...rows.map(s => ({ kind: 'thread', workspace, id: s.id, title: s.title, status: s.status,
        unread: false, running: attentionRank(s) === 0 && staysInWorkingView(s) })));
    }
    return result;
  });
}
if (process.argv[1]?.endsWith('sidebar-oracle.ts')) {
  sidebarOracle(process.argv[2]).then(rows => process.stdout.write(JSON.stringify(rows))).catch(() => { process.exitCode = 1; });
}
