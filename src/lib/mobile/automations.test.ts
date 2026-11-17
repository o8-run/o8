import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/mobile/automations/route';
import { POST } from '@/app/api/mobile/automations/[id]/enabled/route';
import { POST as run } from '@/app/api/mobile/automations/[id]/run/route';
import { projectAutomation } from './automations';
import { listAutomationRows, updateAutomationRow } from '@/lib/automations/store';
import { runManualAutomationRequest } from '@/lib/automations/manual-run';
vi.mock('@/lib/automations/store', () => ({ listAutomationRows: vi.fn(), updateAutomationRow: vi.fn() }));
vi.mock('@/lib/automations/manual-run', () => ({ runManualAutomationRequest: vi.fn() }));
const row = { id: 'auto_1', name: 'Daily check', triggerKind: 'cron' as const, cronExpr: '0 9 * * *', enabled: true,
  lastRunAt: 123, lastRunStatus: 'ok' as const, nextRunAt: 456 };
const ctx = { params: Promise.resolve({ id: row.id }) };
const request = (body: unknown) => new Request('http://localhost/api/mobile/automations/auto_1', {
  method: 'POST', body: JSON.stringify(body),
});
beforeEach(() => vi.resetAllMocks());
describe('mobile automations', () => {
  it('projects only permitted fields through the list route', async () => {
    vi.mocked(listAutomationRows).mockReturnValue([{ ...row, owner: 'private@example.test', token: 'secret',
      repoPath: '/private/repo', prompt: 'private prompt', lastErrorMessage: 'secret failure', organisationId: 'private' }] as never);
    expect(await (await GET()).json()).toEqual({ automations: [{ ...row, triggerKind: undefined, cronExpr: undefined,
      schedule: { kind: 'cron', cronExpr: row.cronExpr, timezone: 'desktop-local', description: 'Daily at 09:00 (desktop time)' } }] });
  });
  it('hides next run for disabled and unscheduled rows', () => {
    expect(projectAutomation({ ...row, enabled: false }).nextRunAt).toBeNull();
    expect(projectAutomation({ ...row, triggerKind: 'manual' }).nextRunAt).toBeNull();
    expect(projectAutomation({ ...row, triggerKind: 'watch' }).schedule.cronExpr).toBeNull();
  });
  it.each([true, false])('sets enabled=%s through the shared desktop store only', async enabled => {
    vi.mocked(updateAutomationRow).mockReturnValue({ ...row, enabled } as never);
    expect((await POST(request({ enabled }), ctx)).status).toBe(200);
    expect(updateAutomationRow).toHaveBeenCalledWith(row.id, { enabled, updatedAt: expect.any(String) });
  });
  it.each([null, [], {}, { enabled: 'false' }, { enabled: true, prompt: 'edit' }])('rejects invalid toggle %j', async body => {
    expect((await POST(request(body), ctx)).status).toBe(400);
    expect(updateAutomationRow).not.toHaveBeenCalled();
  });
  it('returns 404 for missing rows and 503 for unavailable storage', async () => {
    vi.mocked(updateAutomationRow).mockReturnValue(null);
    expect((await POST(request({ enabled: true }), ctx)).status).toBe(404);
    vi.mocked(listAutomationRows).mockImplementation(() => { throw new Error('secret path'); });
    expect(await (await GET()).json()).toEqual({ error: 'Automations unavailable' });
  });
  it.each([null, [], {}, { clientMutationId: '' }, { clientMutationId: 'x'.repeat(129) },
    { clientMutationId: 'one', runAnyway: true }])('rejects unsafe run %j', async body => {
    expect((await run(request(body), ctx)).status).toBe(400);
    expect(runManualAutomationRequest).not.toHaveBeenCalled();
  });
  it('uses the desktop manual run with prechecks and strips private results', async () => {
    vi.mocked(runManualAutomationRequest).mockResolvedValue(Response.json({ ok: true,
      fire: { id: 'fire_1', status: 'succeeded', prompt: 'secret', repoPath: '/private/repo' }, note: 'private', laneId: 'private' }) as never);
    expect(await (await run(request({ clientMutationId: 'one' }), ctx)).json()).toEqual({
      ok: true, queued: false, replayed: false, fireId: 'fire_1', status: 'succeeded',
    });
    const forwarded = vi.mocked(runManualAutomationRequest).mock.calls[0][0];
    expect(await forwarded.json()).toEqual({ clientMutationId: 'one' });
  });
  it.each([409, 404, 502, 202])('preserves desktop run status %s', async status => {
    vi.mocked(runManualAutomationRequest).mockResolvedValue(Response.json({ error: 'private' }, { status }) as never);
    expect((await run(request({ clientMutationId: 'one' }), ctx)).status).toBe(status);
  });
});
