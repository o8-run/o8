import { request, required, rows, str, trim, type Args, type Json } from './transport';
export interface Repo { id: string; name: string; path: string }
export async function repos(signal: AbortSignal): Promise<Repo[]> {
  return rows(await request('/api/panel/repos', signal), 'repos').flatMap(r => trim(r, 'id') && trim(r, 'localPath')
    ? [{ id: trim(r, 'id'), name: str(r, 'name'), path: trim(r, 'localPath') }] : []);
}
export async function scope(args: Args, signal: AbortSignal, mandatory = false): Promise<Repo | null> {
  const id = trim(args, 'repoId'), path = trim(args, 'repoPath'), legacy = trim(args, 'repo');
  if (!id && !path && !legacy && !mandatory) return null;
  const registered = await repos(signal);
  if (id || path) {
    if (!id || !path) throw new Error('repoId and repoPath are required together');
    const repo = registered.find(r => r.id === id);
    if (!repo || repo.path !== path) throw new Error('repoId and repoPath do not identify the same registered repo');
    return repo;
  }
  if (!legacy) throw new Error('repoId and repoPath are required');
  const needle = legacy.toLowerCase();
  const repo = registered.find(r => r.path === legacy || r.name.toLowerCase() === needle)
    ?? (legacy.startsWith('/') ? undefined : registered.find(r => r.name.toLowerCase().includes(needle)));
  if (!repo) throw new Error('Repository is not registered in o8');
  return repo;
}
export const allLanes = async (signal: AbortSignal, active = false) => rows(await request(`/api/lanes?active=${active}`, signal), 'lanes');
export async function lane(args: Args, key: string, signal: AbortSignal): Promise<Json> {
  const id = required(args, key), repo = await scope(args, signal);
  const target = (await allLanes(signal)).find(l => trim(l, 'id') && trim(l, 'packetId') && trim(l, key === 'laneId' ? 'id' : 'packetId') === id);
  if (!target) throw new Error(`No lane has exact ${key} '${id}'. Refresh o8_status and try again.`);
  if (repo && str(target, 'repoPath') !== repo.path) throw new Error(`${key} '${id}' is outside the active repo scope`);
  return target;
}
export const laneResult = (l: Json) => ({ packetId: trim(l, 'packetId'), laneId: trim(l, 'id'), label: str(l, 'label', 'Untitled') });
const nested = (a: Json, parent: string, key: string) => trim((a[parent] ?? {}) as Json, key);
export function approvalLane(a: Json, lanes: Json[]): Json | undefined {
  const packet = nested(a, 'metadata', 'Packet') || nested(a, 'continuation', 'packetId') || nested(a, 'args', 'packetId');
  const id = nested(a, 'metadata', 'Lane') || nested(a, 'continuation', 'laneId') || nested(a, 'args', 'laneId');
  return lanes.find(l => trim(l, 'id') && trim(l, 'packetId') && ((id && trim(l, 'id') === id) || (packet && trim(l, 'packetId') === packet) || (trim(a, 'sessionKey') && trim(a, 'sessionKey') === trim(l, 'sessionKey'))));
}
export function approvalPacket(a: Json, lanes: Json[]): string | null {
  const c = (a.continuation ?? {}) as Json;
  const laneReview = c.kind === 'lane' && ['merge', 'create_pr'].includes(str(c, 'verb'));
  if (!laneReview && a.toolName !== 'orchestrator_review' && !['lane-merge', 'merge-gate-violation', 'worker-merge-governance', 'surface-dispatcher-review'].includes(str(a, 'policyRuleId'))) return null;
  return nested(a, 'metadata', 'Packet') || nested(a, 'continuation', 'packetId') || nested(a, 'args', 'packetId')
    || (laneReview ? trim(lanes.find(l => trim(l, 'id') === trim(c, 'laneId')) ?? {}, 'packetId') : '') || null;
}
export function approvalPath(a: Json, lanes: Json[]): string | null {
  return (approvalLane(a, lanes)?.repoPath as string | undefined) ?? (nested(a, 'continuation', 'repoPath') || nested(a, 'continuation', 'cwd') || nested(a, 'metadata', 'Repo') || nested(a, 'args', 'repoPath') || null);
}
export async function approval(args: Args, signal: AbortSignal) {
  const id = required(args, 'approvalId'), repo = await scope(args, signal);
  const a = rows(await request('/api/panel/approvals', signal), 'approvals').find(a => a.id === id);
  if (!a) throw new Error(`No pending approval has exact approvalId '${id}'. Refresh o8_needs_me and try again.`);
  const lanes = await allLanes(signal);
  if (repo && approvalPath(a, lanes) !== repo.path) throw new Error(`approvalId '${id}' is outside the active repo scope`);
  return { id, title: str(a, 'title', 'Untitled'), packetId: approvalPacket(a, lanes) };
}
