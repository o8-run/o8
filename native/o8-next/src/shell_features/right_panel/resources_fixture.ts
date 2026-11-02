import type { SurfaceRoutes } from '../../../../../scripts/next/surface-routes';

/** Authored metrics and mutation receipts; never reads or stops host processes. */
export function install(): SurfaceRoutes {
  let mode = 'ready';
  let reads = 0;
  const stops: unknown[] = [];
  const row = (key: string, memBytes: number | null, cpuPercent: number | null, pid: number | null) => ({ key, kind: 'session', label: key, repo: 'fixture-repo', runtime: 'pi', sessionKey: `llm-chat:${key}`, pid, cpuPercent, memBytes });
  return { priority: 0, admit: ({ body }) => body ? (JSON.parse(body).key === 'session-heavy' && JSON.parse(body).pid === 424242 ? 200 : 400) : 200, routes: {
    'GET /api/panel/resource-usage': async () => {
      reads++;
      if (mode === 'failed') return Response.json({ error: 'Fixture process table unavailable' }, { status: 503 });
      if (mode === 'payload-error') return Response.json({ sessions: [], processes: [], total: { cpuPercent: 0, memBytes: 0, ramTotalBytes: 0 }, error: 'Fixture collector unavailable' });
      return Response.json({ sessions: mode === 'empty' ? [] : [row('session-unknown', null, null, null), row('session-heavy', 2147483648, mode === 'changed' ? 72 : 41, 424242)], processes: mode === 'empty' ? [] : [{ ...row('process-small', 134217728, 3, null), kind: 'process' }], total: { cpuPercent: 44, memBytes: 2281701376, ramTotalBytes: 17179869184 } });
    },
    'POST /api/panel/resource-usage': async request => {
      stops.push(await request.json());
      return Response.json(mode === 'stop-refused' ? { ok: false, error: 'Fixture process changed; refresh first' } : { ok: true });
    },
    'GET /api/resources-fixture': async request => {
      mode = request.nextUrl.searchParams.get('mode') ?? mode;
      return Response.json({ mode, reads, stops });
    },
  } };
}
