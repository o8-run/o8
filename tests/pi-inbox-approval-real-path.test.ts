import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { getDataDir } from '@/lib/data-dir-migration';
import { getRepoRegistryPath } from '@/lib/repos/registry';
import { createPiApproval } from '@/lib/pi/sdk/approval';
import { getApproval, listApprovals } from '@/lib/approvals/store';
import { GET, POST } from '@/app/api/panel/approvals/route';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { mintPacketWorkerToken } from '@/lib/auth/packet-worker-token';

vi.mock('@/lib/push/notify', () => ({ notifyApprovalCreated: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ requestRealtimeRefresh: vi.fn(async () => true), publishRealtimeMutation: vi.fn(async () => true) }));
const { requestRealtimeRefresh } = await import('@/lib/realtime/publisher');
const repo = '/fixture/pi-inbox';
const running: Array<{ abort: AbortController; result: Promise<boolean> }> = [];
beforeAll(async () => {
  await writeFile(join(getDataDir(), 'projects.json'), JSON.stringify({ activeProjectId: 'other', projects: [
    { id: 'other', name: 'Other', repoPaths: ['/fixture/other'], createdAt: new Date().toISOString() },
  ] }));
  // A registered standalone repo is a virtual project, absent from the legacy ledger.
  await writeFile(getRepoRegistryPath(), JSON.stringify({ version: 1, repos: [
    { id: 'pi-inbox', name: 'pi-inbox', localPath: repo, addedAt: new Date().toISOString() },
  ] }));
});
beforeEach(() => {
  vi.mocked(requestRealtimeRefresh).mockClear();
});
afterEach(async () => {
  for (const turn of running.splice(0)) { turn.abort.abort(); await turn.result.catch(() => {}); }
  vi.restoreAllMocks();
});
async function pending(id: string, call: Parameters<ReturnType<typeof createPiApproval>>[0] = { name: 'run_command', args: { command: 'git status --short' } }) {
  const abort = new AbortController();
  const result = createPiApproval(id, repo)(call, abort.signal);
  void result.catch(() => {}); running.push({ abort, result });
  let approval: ReturnType<typeof getApproval>;
  await vi.waitFor(() => {
    approval = listApprovals({ status: 'pending', sessionKey: id, projectId: null })[0];
    expect(approval).toBeTruthy();
  });
  return { approval: approval!, result, abort };
}
const operator = () => ({ authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' });
async function listAll() {
  const response = await GET(new NextRequest('http://localhost/api/panel/approvals?scope=all', { headers: operator() }));
  expect(response.status).toBe(200);
  return (await response.json()).approvals as Array<{ id: string } & Record<string, unknown>>;
}

describe('built-in agent approvals through Inbox', () => {
  it.each(['approve', 'reject'] as const)('lists another project’s approval and %ss it through the real route', async (action) => {
    const turn = await pending(`pi:inbox-${action}`);
    expect(turn.approval.projectId).toBe('repo:pi-inbox');
    expect(turn.approval.agent).toBe('o8');
    expect((await listAll()).map(entry => entry.id)).toContain(turn.approval.id);
    const resolution = await POST(new NextRequest('http://localhost/api/panel/approvals', {
      method: 'POST', headers: operator(), body: JSON.stringify({ action, id: turn.approval.id }),
    }));
    expect(resolution.status).toBe(200);
    expect(await turn.result).toBe(action === 'approve');
    expect(getApproval(turn.approval.id)?.status).toBe(action === 'approve' ? 'approved' : 'rejected');
  });
  it('returns the exact proposed file content before an operator decides', async () => {
    const turn = await pending('pi:inbox-write', { name: 'write_file', args: { path: 'notes.md', content: 'Updated release checklist' }, before: 'Previous checklist' });
    const entry = (await listAll()).find(candidate => candidate.id === turn.approval.id);
    expect(JSON.stringify(entry)).toContain('Updated release checklist');
  });
  it('keeps ordinary lists scoped and denies a worker the shared Inbox', async () => {
    const turn = await pending('pi:inbox-scopes');
    const headers = { authorization: `Bearer ${getOrCreateWsToken()}` };
    const scoped = await GET(new NextRequest('http://localhost/api/panel/approvals', { headers }));
    expect((await scoped.json()).approvals).toEqual([]);
    const all = await GET(new NextRequest('http://localhost/api/panel/approvals?scope=all', { headers }));
    expect((await all.json()).approvals.map((entry: { id: string }) => entry.id)).toContain(turn.approval.id);
    const worker = { authorization: `Bearer ${mintPacketWorkerToken('packet-own')}` };
    const denied = await GET(new NextRequest('http://localhost/api/panel/approvals?scope=all', { headers: worker }));
    expect(denied.status).toBe(403);
    const resolution = await POST(new NextRequest('http://localhost/api/panel/approvals', { method: 'POST', headers: worker, body: JSON.stringify({ action: 'approve', id: turn.approval.id }) }));
    expect(resolution.status).toBe(403);
    expect(getApproval(turn.approval.id)?.status).toBe('pending');
  });
  it('remains pending after one minute, refreshes the open Inbox, and rejects on stop', async () => {
    const turn = await pending('pi:inbox-wait');
    expect(requestRealtimeRefresh).toHaveBeenCalled();
    const future = Date.now() + 61_000;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(getApproval(turn.approval.id)?.status).toBe('pending');
    turn.abort.abort(); await turn.result.catch(() => {});
    expect(getApproval(turn.approval.id)?.status).toBe('rejected');
  });
  it('expires after the shared five-minute runtime approval window', async () => {
    const turn = await pending('pi:inbox-expiry');
    const future = Date.now() + 301_000;
    vi.spyOn(Date, 'now').mockReturnValue(future);
    expect(await turn.result).toBe(false);
    expect(getApproval(turn.approval.id)?.status).toBe('rejected');
  });
});
