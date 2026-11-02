/**
 * Real-path test for the bug-report intake (reachability rule).
 *
 * The digest logic is unit-tested in crash-digest.test.ts. This drives the ACTUAL
 * route handler with a constructed Request and asserts the crashes reach Discord —
 * the seam that matters, and the one a helper-only test would leave unreached.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
// @ts-expect-error — plain .mjs operations script, no types
import { parseReportEmbed } from '../scripts/sync-reports.mjs';
import type { CrashRecord } from '@/lib/telemetry/crash-store';

const crashRecords = vi.hoisted(() => ({ current: [] as CrashRecord[] }));
const ledger = vi.hoisted(() => ({ written: [] as unknown[] }));
const auth = vi.hoisted(() => ({ ghUser: null as string | null }));
const relay = vi.hoisted(() => ({
  baseUrl: 'https://api.test' as string | null,
  planToken: 'signed-plan-token' as string | null,
}));
const dataSharing = vi.hoisted(() => ({ enabled: true }));
const bootstrap = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/lib/telemetry/crash-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/telemetry/crash-store')>()),
  readCrashRecords: () => crashRecords.current,
}));
// Real id + title logic; only the disk write is intercepted.
vi.mock('@/lib/feedback/report-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/feedback/report-ledger')>()),
  recordReport: (record: unknown) => { ledger.written.push(record); return true; },
}));
vi.mock('@/lib/auth/jwt', () => ({
  verifyToken: async (token: string) =>
    (token === 'valid-token' && auth.ghUser ? { uid: 'u1', plan: 'free', ghUser: auth.ghUser } : null),
}));
// Pinned, so the suite can never depend on (or post to) the real hosted relay.
vi.mock('@/lib/entitlement/bootstrap', () => ({
  ensureFreeEntitlement: bootstrap,
}));
vi.mock('@/lib/entitlement/license', () => ({
  configuredLicenseServerBaseUrl: () => relay.baseUrl,
  readCachedEntitlement: () => relay.planToken ? { licenseKey: relay.planToken } : null,
}));
vi.mock('@/lib/repos/registry', () => ({ findRepoByLocalPath: async () => null }));
vi.mock('@/lib/repos/projects', () => ({
  getActiveProjectScopeForRepoSync: () => ({ project: { name: 'Workspace' } }),
}));
vi.mock('@/lib/runtime/ide-surface-state', () => ({
  readIdeSurfaceState: () => null,
}));
vi.mock('@/lib/operator/defaults', () => ({
  resolveCrashReportsEnabledSync: () => dataSharing.enabled,
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/feedback/report/route';

interface DiscordEmbedField { name: string; value: string; inline?: boolean }
interface CapturedPost {
  form: FormData | null;
  json: unknown;
  calls: number;
  url: string | null;
  headers: Headers;
}

const captured: CapturedPost = {
  form: null,
  json: null,
  calls: 0,
  url: null,
  headers: new Headers(),
};

/**
 * A real NextRequest — not a bare Request. `request.cookies` is a NextRequest
 * affordance, so a plain Request would silently yield no reporter and the
 * attribution test would pass against a path prod never takes.
 */
function postReport(body: Record<string, unknown>, cookie?: string) {
  return POST(
    new NextRequest('http://127.0.0.1:3001/api/feedback/report', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

async function embedOf(form: FormData): Promise<{ fields: DiscordEmbedField[] }> {
  const payload = JSON.parse(String(form.get('payload_json'))) as { embeds: { fields: DiscordEmbedField[] }[] };
  return payload.embeds[0];
}

beforeEach(() => {
  bootstrap.mockReset();
  bootstrap.mockResolvedValue(undefined);
  crashRecords.current = [];
  ledger.written = [];
  auth.ghUser = null;
  relay.baseUrl = 'https://api.test';
  relay.planToken = 'signed-plan-token';
  dataSharing.enabled = true;
  captured.form = null;
  captured.json = null;
  captured.calls = 0;
  captured.url = null;
  captured.headers = new Headers();
  vi.stubGlobal('fetch', async (url: string | URL | Request, init: RequestInit = {}) => {
    captured.calls += 1;
    captured.url = String(url);
    captured.headers = new Headers(init.headers);
    if (init.body instanceof FormData) captured.form = init.body;
    else captured.json = JSON.parse(String(init.body));
    const payload = init.body instanceof FormData
      ? JSON.parse(String(init.body.get('payload_json'))) as { embeds?: Array<{ title?: string }> }
      : captured.json as { embeds?: Array<{ title?: string }> };
    const reportId = /^\[(?:BUG|REQUEST)\]\s+([2-9A-HJ-NP-TV-Z]{6})\b/.exec(payload.embeds?.[0]?.title ?? '')?.[1];
    return Response.json({ ok: true, reportId });
  });
});

function crash(overrides: Partial<CrashRecord> = {}): CrashRecord {
  return {
    ts: Date.now() - 60_000,
    source: 'renderer',
    appVersion: '0.1.591',
    kind: 'window.error',
    message: 'TypeError: diff is undefined',
    stack: 'at DiffPanel (DiffPanel.tsx:42)',
    ...overrides,
  };
}

describe('text-only feedback through POST /api/feedback/report', () => {
  it.each([undefined, 'o8-token=valid-token'])('sends only user-selected content, without account attribution (%s)', async (cookie) => {
    auth.ghUser = 'connected-account';
    crashRecords.current = [crash({ message: 'private-crash' })];
    const res = await postReport({
      kind: 'feedback',
      message: '  Getting started was confusing.  ',
      includeMetadata: false,
      route: 'private-route',
      userAgent: 'private-agent',
      prompt: 'private-prompt',
      client: { workspace: { path: 'private-repo' } },
      includeDiagnostics: true,
      image: { dataUrl: 'data:image/png;base64,c2VjcmV0', name: 'private-image.png' },
    }, cookie);

    expect(res.status).toBe(200);
    expect(captured.url).toBe('https://api.test/v1/feedback');
    expect(captured.headers.get('authorization')).toBe('Bearer signed-plan-token');
    expect(captured.form).toBeNull();
    const payload = captured.json as { username: string; embeds: Array<Record<string, unknown>> };
    expect(Object.keys(payload).sort()).toEqual(['embeds', 'username']);
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0]).toMatchObject({ description: 'Getting started was confusing.', fields: [] });
    expect(Object.keys(payload.embeds[0]).sort()).toEqual(['description', 'fields', 'footer', 'title']);
    expect(JSON.stringify(payload)).not.toMatch(/private-|connected-account|signed-plan-token/);
    expect(ledger.written).toEqual([expect.objectContaining({ reporter: null, version: 'unknown', category: 'request' })]);
  });

  it('includes optional email and server-derived version/OS only when selected', async () => {
    const res = await postReport({
      kind: 'feedback', message: 'Please improve setup.', email: ' reader@example.test ',
      includeMetadata: true, version: 'injected-version', os: 'injected-os',
    });
    expect(res.status).toBe(200);
    const payload = captured.json as { embeds: Array<{ fields: DiscordEmbedField[] }> };
    expect(payload.embeds[0].fields.map((field) => field.name)).toEqual(['Version', 'OS']);
    expect(payload.embeds[0].fields[0].value).toMatch(/^\d+\.\d+\.\d+/);
    expect(payload.embeds[0].fields[1].value).toBeTruthy();
    expect(captured.json).toMatchObject({ embeds: [{ footer: { text: expect.stringContaining('Reply email: reader@example.test') } }] });
    const synced = parseReportEmbed({ ...(captured.json as object), timestamp: new Date().toISOString() });
    expect(synced).toMatchObject({ reporter: null });
    expect(JSON.stringify(synced)).not.toContain('reader@example.test');
    expect(JSON.stringify(payload)).not.toContain('injected-');
    expect(ledger.written[0]).toMatchObject({ reporter: null });
    expect(JSON.stringify(ledger.written)).not.toContain('reader@example.test');
  });

  it('keeps maximum-length message and reply contact in separate supported relay fields', async () => {
    const message = 'm'.repeat(4000);
    const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
    expect(email).toHaveLength(254);
    const res = await postReport({ kind: 'feedback', message, email, includeMetadata: false });
    expect(res.status).toBe(200);
    expect(captured.json).toMatchObject({ embeds: [{
      description: message,
      fields: [],
      footer: { text: expect.stringContaining(`Reply email: ${email}`) },
    }] });
  });

  it('omits empty email and unselected metadata', async () => {
    const res = await postReport({ kind: 'feedback', message: 'A suggestion.', email: '  ' });
    expect(res.status).toBe(200);
    expect(captured.json).toMatchObject({ embeds: [{ fields: [] }] });
  });

  it.each([
    { message: '  ' }, { message: 'x'.repeat(4001) }, { message: 'hello', email: 'bad-address' },
    { message: 'hello', email: 123 }, { message: 'hello', includeMetadata: 'yes' },
  ])('rejects invalid feedback without sending: %j', async (body) => {
    const res = await postReport({ kind: 'feedback', ...body });
    expect(res.status).toBe(400);
    expect(captured.calls).toBe(0);
    expect(ledger.written).toHaveLength(0);
  });

  it('preserves the existing data-sharing opt-out for feedback', async () => {
    dataSharing.enabled = false;
    const res = await postReport({ kind: 'feedback', message: 'Keep this local.' });
    expect(res.status).toBe(403);
    expect(captured.calls).toBe(0);
    expect(ledger.written).toHaveLength(0);
  });

  it.each(['disabled', 'missing-token', 'rate-limit', 'invalid-receipt', 'timeout', 'bootstrap-failure'])('never records a success for %s', async (failure) => {
    if (failure === 'disabled') relay.baseUrl = null;
    if (failure === 'missing-token') relay.planToken = null;
    if (failure === 'rate-limit') vi.stubGlobal('fetch', async () => new Response(null, { status: 429 }));
    if (failure === 'invalid-receipt') vi.stubGlobal('fetch', async () => Response.json({ ok: true, reportId: 'WRONG' }));
    if (failure === 'timeout') vi.stubGlobal('fetch', async () => { throw new Error('request timed out'); });
    if (failure === 'bootstrap-failure') bootstrap.mockRejectedValueOnce(new Error('bootstrap failed'));
    const res = await postReport({ kind: 'feedback', message: 'Please improve setup.' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: expect.any(String) });
    expect(ledger.written).toHaveLength(0);
    if (failure === 'disabled' || failure === 'missing-token') expect(captured.calls).toBe(0);
  });
});

describe('POST /api/feedback/report', () => {
  it('returns a structured 403 without posting when data sharing is off', async () => {
    dataSharing.enabled = false;

    const res = await postReport({
      category: 'bug',
      message: 'screenshot report must stay local',
      route: '/dashboard',
      image: { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', name: 'screen.png' },
      includeDiagnostics: true,
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: 'data_sharing_off',
    });
    expect(captured.calls).toBe(0);
    expect(ledger.written).toHaveLength(0);
  });

  it('sends an authenticated report through the hosted relay when data sharing is on', async () => {
    const res = await postReport({ category: 'bug', message: 'sharing is enabled', route: '/dashboard' });

    expect(res.status).toBe(200);
    expect(captured.calls).toBe(1);
    expect(captured.url).toBe('https://api.test/v1/feedback');
    expect(captured.headers.get('authorization')).toBe('Bearer signed-plan-token');
    expect(captured.json).not.toBeNull();
    expect(JSON.stringify(captured.json)).not.toContain('signed-plan-token');
    expect(ledger.written).toHaveLength(1);
  });

  it('attaches recent crashes as a file and a Crashes field', async () => {
    crashRecords.current = [crash()];

    const res = await postReport({
      category: 'bug',
      message: 'diff panel went blank',
      route: '/dashboard',
      includeDiagnostics: true,
    });
    expect(res.status).toBe(200);

    const form = captured.form;
    expect(form, 'crashes must force the multipart path even with no screenshot').not.toBeNull();

    const file = form!.get('files[0]') as File;
    expect(file.name).toBe('diagnostics.txt');
    const text = await file.text();
    expect(text).toContain('TypeError: diff is undefined');
    expect(text).toContain('at DiffPanel (DiffPanel.tsx:42)');

    const embed = await embedOf(form!);
    const field = embed.fields.find((f) => f.name === 'Crashes');
    expect(field?.value).toContain('1 in the last 24h');
    expect(field?.inline).toBe(false);
  });

  it('sends plain JSON with no Crashes field when the log is clean', async () => {
    const res = await postReport({ category: 'request', message: 'add dark mode to canvas', route: '/dashboard' });
    expect(res.status).toBe(200);

    expect(captured.form, 'a clean log must not force a multipart upload').toBeNull();
    const payload = captured.json as { embeds: { fields: DiscordEmbedField[] }[] };
    expect(payload.embeds[0].fields.some((f) => f.name === 'Crashes')).toBe(false);
  });

  it('does not attach local crashes without explicit per-report consent', async () => {
    crashRecords.current = [crash()];
    const res = await postReport({ category: 'bug', message: 'no diagnostics please', route: '/dashboard' });
    expect(res.status).toBe(200);
    expect(captured.form).toBeNull();
    const payload = captured.json as { embeds: { fields: DiscordEmbedField[] }[] };
    expect(payload.embeds[0].fields.some((f) => f.name === 'Crashes')).toBe(false);
  });

  it('ignores crashes older than the 24h window', async () => {
    crashRecords.current = [crash({ ts: Date.now() - 48 * 60 * 60 * 1000 })];

    await postReport({ category: 'bug', message: 'stale crash must not ride along', route: '/dashboard' });
    expect(captured.form).toBeNull();
  });

  it('does not let a screenshot named diagnostics.txt shadow the diagnostics file', async () => {
    crashRecords.current = [crash()];

    await postReport({
      category: 'bug',
      message: 'collision',
      route: '/dashboard',
      includeDiagnostics: true,
      images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', name: 'diagnostics.txt' }],
    });

    const form = captured.form!;
    const names = form.getAll('files[0]').concat(form.getAll('files[1]')).map((f) => (f as File).name);
    expect(names).toContain('diagnostics.txt');
    expect(names).toContain('diagnostics-1.txt');
    const screenshot = form.get('files[0]') as File;
    expect(screenshot.type).toBe('image/png');
    expect(new Uint8Array(await screenshot.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it('renders the client state snapshot into the State field and the diagnostics file', async () => {
    const res = await postReport({
      category: 'bug',
      message: 'half the window is wallpaper',
      route: '/dashboard',
      includeDiagnostics: true,
      client: {
        ui: {
          innerW: 2048, innerH: 1128, dpr: 2, uiZoom: '1',
          bodyScrollTop: 491, docScrollTop: 0, dashboardTop: -491,
          palette: 'dark', surface: 'glass',
        },
        consoleErrors: [
          { message: '[workspace-spawn] orchestrator spawn failed: boom', source: 'app', lineno: 12, timestamp: 1784168000000 },
        ],
        platform: 'MacIntel',
      },
    });
    expect(res.status).toBe(200);

    const form = captured.form;
    expect(form, 'client diagnostics must force the multipart path').not.toBeNull();
    const embed = await embedOf(form!);
    const state = embed.fields.find((f) => f.name === 'State');
    expect(state?.value).toContain('bodyScroll 491');
    expect(state?.value).toContain('dashTop -491');
    expect(state?.inline).toBe(false);

    const file = form!.get('files[0]') as File;
    expect(file.name).toBe('diagnostics.txt');
    const text = await file.text();
    expect(text).toContain('CONSOLE ERROR RING BUFFER');
    expect(text).toContain('[workspace-spawn] orchestrator spawn failed: boom');
  });

  it('redacts credential-shaped values from the attached diagnostics', async () => {
    const secret = 'SYNTHETIC_FEEDBACK_SECRET_NOT_VALID';
    const res = await postReport({
      category: 'bug',
      message: 'sign-in loop',
      route: '/dashboard',
      includeDiagnostics: true,
      client: {
        ui: { innerW: 1, innerH: 1, dpr: 1, uiZoom: '1', bodyScrollTop: 0, docScrollTop: 0, dashboardTop: 0, palette: 'dark', surface: 'glass' },
        consoleErrors: [
          { message: `Clerk load failed Bearer ${secret} ?__clerk_ticket=${secret} eyJ${secret}.eyJ${secret}.${secret}`, source: 'app', lineno: 1, timestamp: 1784168000000 },
        ],
        platform: 'MacIntel',
      },
    });
    expect(res.status).toBe(200);
    const text = await (captured.form!.get('files[0]') as File).text();
    expect(text).toContain('Clerk load failed');
    expect(text).not.toContain(secret);
  });

  it('renders the workspace snapshot and spawn journal into the diagnostics file (GQXEZD forensics)', async () => {
    const res = await postReport({
      category: 'bug',
      message: 'new session does nothing',
      route: '/dashboard',
      includeDiagnostics: true,
      client: {
        ui: null,
        consoleErrors: [],
        platform: 'MacIntel',
        workspace: {
          layout: {
            activeTileId: 'tile-a',
            leaves: [{ id: 'tile-a', kind: 'terminal', repoPath: null }, { id: 'tile-b', kind: 'terminal', repoPath: '/repo' }],
            handleTileIds: ['tile-b'],
          },
          'tabs:x1y2z3': { stateScope: 'workspace', tabs: [] },
        },
        spawnJournal: [
          { ts: 1784168000000, event: 'orchestrator:requested activeTile=tile-a' },
          { ts: 1784168000500, event: 'orchestrator:done tile=tile-b tab=tab-123' },
        ],
      },
    });
    expect(res.status).toBe(200);

    const form = captured.form;
    expect(form, 'workspace forensics must force the multipart path').not.toBeNull();
    const file = form!.get('files[0]') as File;
    expect(file.name).toBe('diagnostics.txt');
    const text = await file.text();
    expect(text).toContain('SPAWN JOURNAL');
    expect(text).toContain('orchestrator:done tile=tile-b tab=tab-123');
    expect(text).toContain('WORKSPACE SNAPSHOT');
    expect(text).toContain('"handleTileIds"');
    expect(text).toContain('tabs:x1y2z3');
  });

  it('drops client diagnostics when includeDiagnostics is absent', async () => {
    const res = await postReport({
      category: 'bug',
      message: 'no consent, no forensics',
      route: '/dashboard',
      client: { ui: null, consoleErrors: [], platform: 'MacIntel' },
    });
    expect(res.status).toBe(200);
    expect(captured.form).toBeNull();
    const payload = captured.json as { embeds: { fields: DiscordEmbedField[] }[] };
    expect(payload.embeds[0].fields.some((f) => f.name === 'State')).toBe(false);
  });

  it('still rejects an invalid report before touching the crash log', async () => {
    crashRecords.current = [crash()];
    const res = await postReport({ category: 'bug', message: '   ' });
    expect(res.status).toBe(400);
    expect(captured.form).toBeNull();
    expect(captured.json).toBeNull();
    expect(ledger.written).toHaveLength(0);
  });
});

describe('report id + attribution (the #fixed loop)', () => {
  it('hands the reporter an id and ledgers it under the same id', async () => {
    const res = await postReport({ category: 'bug', message: 'diff panel went blank', route: '/dashboard' });
    const body = (await res.json()) as { ok: boolean; reportId: string };

    expect(body.ok).toBe(true);
    expect(body.reportId).toMatch(/^[2-9A-HJ-NP-TV-Z]{6}$/); // no 0/O/1/I/L/U — it gets typed into commits

    expect(ledger.written).toHaveLength(1);
    const recorded = ledger.written[0] as { id: string; title: string; category: string };
    expect(recorded.id, 'the id the user sees must be the id a fix looks up').toBe(body.reportId);
    expect(recorded.title).toBe('diff panel went blank');
    expect(recorded.category).toBe('bug');

    // Same id on the Discord card, so triage and the ledger agree.
    const payload = captured.json as { embeds: { title: string; footer: { text: string } }[] };
    expect(payload.embeds[0].title).toContain(body.reportId);
    expect(payload.embeds[0].footer.text).toContain(body.reportId);
  });

  it('never records the reporter GitHub login, even with a connected account (data minimization)', async () => {
    auth.ghUser = 'octo-user';

    await postReport(
      { category: 'bug', message: 'crash on merge', route: '/dashboard' },
      'o8-token=valid-token',
    );

    // #fixed is retired: the login is neither read from the cookie nor stored.
    const recorded = ledger.written[0] as { reporter: string | null };
    expect(recorded.reporter).toBeNull();
    expect(JSON.stringify(ledger.written[0]).includes('octo-user')).toBe(false);

    // No identity reaches the ops card either — the "Reported by" field is gone.
    const payload = captured.json as { embeds: { fields: DiscordEmbedField[] }[] };
    expect(payload.embeds[0].fields.find((f) => f.name === 'Reported by')).toBeUndefined();
  });

  it('errors loudly when no signed relay credential is available', async () => {
    relay.planToken = null;

    const res = await postReport({ category: 'bug', message: 'nowhere to send this', route: '/dashboard' });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toContain('authenticate');
    // Silence would let the operator walk away believing they were heard.
    expect(captured.form).toBeNull();
    expect(captured.json).toBeNull();
    expect(ledger.written).toHaveLength(0);
  });

  it('stays offline when hosted services are explicitly disabled', async () => {
    relay.baseUrl = null;

    const res = await postReport({ category: 'bug', message: 'hosted path is off', route: '/dashboard' });

    expect(res.status).toBe(502);
    expect(captured.calls).toBe(0);
    expect(ledger.written).toHaveLength(0);
  });

  it('does not ledger a report when the relay receipt does not match', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ ok: true, reportId: 'ZZZZZZ' }));

    const res = await postReport({ category: 'bug', message: 'receipt mismatch', route: '/dashboard' });

    expect(res.status).toBe(502);
    expect(ledger.written).toHaveLength(0);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toContain('invalid receipt');
  });

  it('does not ledger a report that never reached the hosted relay', async () => {
    vi.stubGlobal('fetch', async () => new Response('rate limited', { status: 429 }));

    const res = await postReport({ category: 'bug', message: 'went nowhere', route: '/dashboard' });

    expect(res.status).toBe(502);
    // An id handed out for a post that never landed is an id no fix can ever cite.
    expect(ledger.written).toHaveLength(0);
    const body = (await res.json()) as { ok: boolean; reportId?: string };
    expect(body.reportId).toBeUndefined();
  });
});
