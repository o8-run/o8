import { allLanes, approvalLane, approvalPacket, approvalPath, repos, scope } from './scope';
import { request, rows, str, trim, type Args, type Json } from './transport';
const basename = (s: string) => s.replace(/\/+$/, '').split('/').pop() ?? '';
const attention = ['awaiting_input', 'awaiting_orchestrator', 'recovering', 'reviewing', 'failed'];
export async function reads(tool: string, args: Args, signal: AbortSignal): Promise<unknown> {
  if (tool === 'o8_attention_why') return request('/api/broadcast/why', signal);
  if (tool === 'o8_team_inbox') {
    const messages = rows(await request('/api/team/messages?limit=10', signal), 'messages');
    return { count: messages.length, messages };
  }
  if (tool === 'o8_ask') {
    const question = trim(args, 'question');
    if (!question) throw new Error("o8_ask needs a 'question'");
    const body: Json = { question };
    if (str(args, 'repo_path')) {
      const repo = await scope(args, signal);
      if (!(await repos(signal)).some(r => r.path === str(args, 'repo_path')) || (repo && repo.path !== str(args, 'repo_path'))) throw new Error('repo_path is outside the registered repository scope');
      body.repoPath = str(args, 'repo_path');
    }
    const r = await request('/api/cortex/ask/answer', signal, body);
    if (r.ok === false) throw new Error(str(r, 'error', 'the Brain returned an error'));
    return { answer: trim(r, 'answer'), sources: rows(r, 'citations').slice(0, 5).map(c => ({ kind: str(c, 'kind', 'source'), title: str(c, 'title', str(c, 'rowId')), ...(typeof c.url === 'string' ? { url: c.url } : {}) })), sources_considered: r.sourcesConsidered ?? 0 };
  }
  if (tool === 'o8_status' || tool === 'o8_needs_me') {
    const repo = await scope(args, signal), registered = await repos(signal), lanes = await allLanes(signal, true);
    const project = (l: Json) => ({ laneId: str(l, 'id'), packetId: str(l, 'packetId'), sessionKey: l.sessionKey ?? null,
      repoId: registered.find(r => r.path === str(l, 'repoPath'))?.id ?? null, repoPath: str(l, 'repoPath'), label: str(l, 'label', 'Untitled'), status: str(l, 'status', tool === 'o8_status' ? 'unknown' : ''), repo: basename(str(l, 'repoPath')) });
    if (tool === 'o8_status') {
      const items = lanes.filter(l => !repo || l.repoPath === repo.path).map(l => ({ ...project(l), name: str(l, 'codename'), runtime: str(l, 'runtime'), branch: str(l, 'branch') }));
      let peers: Json[] = [];
      try { peers = rows(await request('/api/team/presence', signal), 'peers').filter(p => !repo || [repo.path, repo.name].includes(str(p, 'repoPath', str(p, 'repo')))); } catch { signal.throwIfAborted(); }
      return { active_count: items.length, repoId: repo?.id ?? null, repoPath: repo?.path ?? null, lanes: items, peers };
    }
    const cards = rows(await request('/api/panel/approvals', signal), 'approvals').filter(a => !repo || approvalPath(a, lanes) === repo.path).map(a => {
      const l = approvalLane(a, lanes), path = approvalPath(a, lanes);
      return { approvalId: str(a, 'id'), packetId: approvalPacket(a, lanes), laneId: l ? trim(l, 'id') : null, sessionKey: l?.sessionKey ?? a.sessionKey ?? null,
        repoPath: path, repoId: registered.find(r => r.path === path)?.id ?? null, title: str(a, 'title', 'Untitled'), agent: str(a, 'agent'), risk: str(a, 'risk', 'low'), summary: [...str(a, 'summary')].slice(0, 160).join(''),
        ...(typeof a.createdAt === 'number' && a.createdAt > 1e12 && Date.now() > a.createdAt ? { age_minutes: Math.floor((Date.now() - a.createdAt) / 60000) } : {}) };
    });
    const stuck = lanes.filter(l => attention.includes(str(l, 'status')) && (!repo || l.repoPath === repo.path)).map(project);
    return { approval_count: cards.length, approvals: cards, attention_count: stuck.length, attention_lanes: stuck, ...(!cards.length && !stuck.length ? { note: 'Nothing is waiting on the user right now.' } : {}) };
  }
  if (tool === 'o8_recap') {
    const hours = Math.min(72, Math.max(1, Number.isInteger(args.hours) ? args.hours as number : 8)), cutoff = Date.now() - hours * 3600000;
    const lanes = await allLanes(signal), completed: Json[] = [], failed: Json[] = [], reviewing: Json[] = [], needs_attention: Json[] = [];
    let running = 0;
    for (const l of lanes) {
      const status = str(l, 'status');
      if (['running', 'launching', 'merging'].includes(status)) running++;
      const updated = typeof l.updatedAt === 'number' ? l.updatedAt : Date.parse(str(l, 'updatedAt')) || 0;
      if (updated < cutoff) continue;
      const item = { label: str(l, 'label', 'Untitled'), repo: basename(str(l, 'repoPath')) };
      if (status === 'completed') completed.push(item);
      if (status === 'failed') failed.push(item);
      if (status === 'reviewing') reviewing.push(item);
      if (attention.slice(0, 3).includes(status)) needs_attention.push(item);
    }
    const resolved = rows(await request('/api/panel/approvals?status=all', signal), 'approvals').filter(a => typeof a.resolvedAt === 'number' && a.resolvedAt >= cutoff).map(a => ({ title: str(a, 'title', 'Untitled'), action: str(a, 'status') }));
    return { window_hours: hours, completed, failed, reviewing, needs_attention, still_running: running, approvals_resolved: resolved,
      ...(!completed.length && !failed.length && !reviewing.length && !needs_attention.length && !resolved.length ? { note: 'A quiet stretch — nothing finished, failed, or got resolved in that window.' } : {}) };
  }
  if (tool === 'o8_usage') {
    const r = await request('/api/panel/cli-usage', signal);
    const project = (runtime: Json) => {
      const out: Json = {};
      for (const [key, name] of [['primary', 'session_window'], ['secondary', 'weekly_window']]) {
        const w = runtime[key] as Json | undefined;
        if (!w) continue;
        out[name] = { ...(typeof w.windowMinutes === 'number' ? { window_hours: w.windowMinutes / 60 } : {}), ...(typeof w.usedPercent === 'number' ? { used_percent: Math.round(w.usedPercent) } : {}), ...(typeof w.tokens === 'number' ? { tokens_used: w.tokens } : {}), ...(typeof w.resetsAt === 'number' && w.resetsAt > Date.now() ? { resets_in_minutes: Math.floor((w.resetsAt - Date.now()) / 60000) } : {}) };
      }
      return Object.keys(out).length ? out : { note: 'no usage data available right now' };
    };
    return { claude: project((r.claude ?? {}) as Json), codex: project((r.codex ?? {}) as Json) };
  }
  const kind = trim(args, 'kind').toLowerCase();
  if (!['automations', 'projects', 'repos'].includes(kind)) throw new Error(`o8_panel_read kind must be 'automations', 'projects', or 'repos' — got '${kind}'.`);
  const r = await request(kind === 'repos' ? '/api/panel/repos' : `/api/${kind}`, signal);
  const items = rows(r, kind).flatMap<unknown>(a => {
    if (kind === 'repos') return typeof a.name === 'string' ? [a.name] : [];
    if (kind === 'projects') return [{ name: str(a, 'name', 'Untitled'), repo_count: Array.isArray(a.repos) ? a.repos.length : 0 }];
    return [{ name: str(a, 'name', 'Untitled'), enabled: a.enabled === true, trigger: str(a, 'cronExpr', str(a, 'triggerKind')), last_run_status: str(a, 'lastRunStatus'), repo: basename(str(a, 'repoPath')) }];
  });
  return { count: items.length, [kind]: items };
}
