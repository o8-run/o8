import { NextResponse, type NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import { getActiveProjectScopeForRepoSync } from '@/lib/repos/projects';
import { readIdeSurfaceState } from '@/lib/runtime/ide-surface-state';
import { collectCrashDigest, type CrashDigest } from '@/lib/telemetry/crash-digest';
import { redactSecrets } from '@/lib/telemetry/scrub';
import { REPORT_DATA_SHARING_OFF_ERROR, REPORT_DATA_SHARING_OFF_MESSAGE } from '@/lib/feedback/data-sharing';
import { newReportId, recordReport, reportTitle } from '@/lib/feedback/report-ledger';
import { resolveCrashReportsEnabledSync } from '@/lib/operator/defaults';
import { postHostedPayload } from '@/lib/feedback/hosted-report';
import { sendMinimalFeedback } from '@/lib/feedback/minimal-feedback';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MESSAGE_LIMIT = 4000;
const DISCORD_DESCRIPTION_LIMIT = 4096;
const DISCORD_FIELD_VALUE_LIMIT = 1024;
const DISCORD_TITLE_LIMIT = 256;
const DISCORD_EMBED_TOTAL_LIMIT = 6000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // Discord's baseline webhook upload ceiling.
const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

type FeedbackCategory = 'bug' | 'request';

interface ParsedImage {
  bytes: Buffer;
  mime: string;
  filename: string;
}

interface FeedbackBody {
  kind?: unknown;
  email?: unknown;
  includeMetadata?: unknown;
  category?: unknown;
  message?: unknown;
  route?: unknown;
  userAgent?: unknown;
  image?: unknown;
  images?: unknown;
  includeDiagnostics?: unknown;
  client?: unknown;
}

/** Client-collected state snapshot — validated + clamped from body.client. */
interface ClientDiagnostics {
  ui: {
    innerW: number;
    innerH: number;
    dpr: number;
    uiZoom: string;
    bodyScrollTop: number;
    docScrollTop: number;
    dashboardTop: number | null;
    palette: string;
    surface: string;
  } | null;
  consoleErrors: Array<{ message: string; source: string; lineno: number; timestamp: number }>;
  platform: string;
  /** Workspace tile/tab snapshot (GQXEZD forensics) — free-shape JSON from the
   *  client's introspection contributors, clamped to a size cap. */
  workspace: string | null;
  /** Session-spawn breadcrumbs — "orchestrator:requested / :done tile=… tab=…". */
  spawnJournal: Array<{ ts: number; event: string }>;
}

const MAX_CLIENT_CONSOLE_ERRORS = 20;
const MAX_SPAWN_JOURNAL = 20;
const MAX_WORKSPACE_JSON = 6000;

function clampNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function clampString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Never throws; unusable input degrades to nulls/empties, never a 400 — the
 *  operator's report text always outranks its diagnostics. */
function parseClientDiagnostics(raw: unknown): ClientDiagnostics | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as { ui?: unknown; consoleErrors?: unknown; platform?: unknown; workspace?: unknown; spawnJournal?: unknown };
  const ui = source.ui && typeof source.ui === 'object'
    ? (() => {
        const u = source.ui as Record<string, unknown>;
        return {
          innerW: clampNumber(u.innerW),
          innerH: clampNumber(u.innerH),
          dpr: Number(u.dpr) || 1,
          uiZoom: clampString(u.uiZoom, 8) || '1',
          bodyScrollTop: clampNumber(u.bodyScrollTop),
          docScrollTop: clampNumber(u.docScrollTop),
          dashboardTop: u.dashboardTop == null ? null : clampNumber(u.dashboardTop),
          palette: clampString(u.palette, 16),
          surface: clampString(u.surface, 16),
        };
      })()
    : null;
  const consoleErrors = Array.isArray(source.consoleErrors)
    ? source.consoleErrors.slice(-MAX_CLIENT_CONSOLE_ERRORS).map((entry) => {
        const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
        return {
          message: clampString(e.message, 600),
          source: clampString(e.source, 200),
          lineno: clampNumber(e.lineno),
          timestamp: clampNumber(e.timestamp),
        };
      })
    : [];
  let workspace: string | null = null;
  if (source.workspace && typeof source.workspace === 'object') {
    try {
      workspace = JSON.stringify(source.workspace, null, 1).slice(0, MAX_WORKSPACE_JSON);
    } catch {
      workspace = null;
    }
  }
  const spawnJournal = Array.isArray(source.spawnJournal)
    ? source.spawnJournal.slice(-MAX_SPAWN_JOURNAL).map((entry) => {
        const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
        return { ts: clampNumber(e.ts), event: clampString(e.event, 300) };
      })
    : [];
  return { ui, consoleErrors, platform: clampString(source.platform, 64) || 'unknown', workspace, spawnJournal };
}

/** One embed line: geometry + drift + error count. The dashboardTop/bodyScroll
 *  numbers are exactly the forensics that cracked the 0.1.605 "half window"
 *  class — a healthy shell reads `dashTop 0 · bodyScroll 0`. */
function clientStateSummary(client: ClientDiagnostics): string {
  const parts: string[] = [];
  if (client.ui) {
    const u = client.ui;
    parts.push(`${u.innerW}×${u.innerH} @${u.dpr}x`, `zoom ${u.uiZoom}`);
    parts.push(`bodyScroll ${u.bodyScrollTop}`, `dashTop ${u.dashboardTop ?? '—'}`);
    if (u.palette || u.surface) parts.push(`${u.palette}/${u.surface}`);
  }
  parts.push(`${client.consoleErrors.length} console error${client.consoleErrors.length === 1 ? '' : 's'} buffered`);
  parts.push(client.platform);
  return parts.join(' · ');
}

function renderClientDiagnostics(client: ClientDiagnostics): string {
  const lines: string[] = ['── CLIENT STATE ──', clientStateSummary(client), ''];
  if (client.spawnJournal.length > 0) {
    lines.push('── SPAWN JOURNAL (newest last) ──');
    for (const entry of client.spawnJournal) {
      const when = entry.ts ? new Date(entry.ts).toISOString() : '(no ts)';
      lines.push(`${when} ${entry.event}`);
    }
    lines.push('');
  }
  if (client.workspace) {
    lines.push('── WORKSPACE SNAPSHOT (tiles · handles · tabs) ──', client.workspace, '');
  }
  if (client.consoleErrors.length > 0) {
    lines.push('── CONSOLE ERROR RING BUFFER (newest last) ──');
    for (const entry of client.consoleErrors) {
      const when = entry.timestamp ? new Date(entry.timestamp).toISOString() : '(no ts)';
      lines.push(`${when} ${entry.source}:${entry.lineno}`, entry.message, '');
    }
  }
  return lines.join('\n');
}

const MAX_IMAGES = 5;

interface ReportDiagnostics {
  version: string;
  osLabel: string;
  nodeVersion: string;
  route: string;
  userAgent: string;
  projectLabel: string | null;
  timestamp: string;
}

// Data minimization: feedback reports no longer record who filed them. The
// `#fixed` credit loop that once needed the reporter's GitHub login is retired,
// so the login is never read from the `o8-token` cookie or stored. Reports are
// always anonymous.

let cachedVersion: string | null = null;

function jsonError(error: string, status = 400, message?: string) {
  return NextResponse.json({ ok: false, error, ...(message ? { message } : {}) }, { status });
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3)}...`;
}

function readServerVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const raw = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedVersion = typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function validateBody(body: FeedbackBody): { ok: true; category: FeedbackCategory; message: string; route: string; userAgent: string } | { ok: false; error: string } {
  const category = typeof body.category === 'string' ? body.category.trim().toLowerCase() : '';
  if (category !== 'bug' && category !== 'request') {
    return { ok: false, error: 'Choose Bug or Request before sending.' };
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return { ok: false, error: 'Add a short report before sending.' };
  }
  if (message.length > MESSAGE_LIMIT) {
    return { ok: false, error: `Report must be ${MESSAGE_LIMIT} characters or fewer.` };
  }

  return {
    ok: true,
    category,
    message,
    route: truncate(stringValue(body.route, 'unknown'), DISCORD_FIELD_VALUE_LIMIT),
    userAgent: truncate(stringValue(body.userAgent, 'unknown'), DISCORD_FIELD_VALUE_LIMIT),
  };
}

/**
 * Decode an optional base64 data-URL screenshot from the report body. Returns
 * { image: null } when none was attached. Fails closed on a malformed/oversized
 * payload so a bad attachment can't silently corrupt the whole report.
 */
function parseImage(raw: unknown): { ok: true; image: ParsedImage | null } | { ok: false; error: string } {
  if (raw == null) return { ok: true, image: null };
  if (typeof raw !== 'object') return { ok: false, error: 'Invalid attachment.' };
  const dataUrl = typeof (raw as { dataUrl?: unknown }).dataUrl === 'string'
    ? (raw as { dataUrl: string }).dataUrl
    : '';
  if (!dataUrl) return { ok: true, image: null };

  const match = /^data:([^;,]+)(;base64)?,(.*)$/.exec(dataUrl);
  if (!match) return { ok: false, error: 'Attachment must be an image.' };
  const mime = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_MIME.has(mime)) {
    return { ok: false, error: 'Attachment must be a PNG, JPEG, GIF, or WebP image.' };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(match[3], match[2] ? 'base64' : 'utf8');
  } catch {
    return { ok: false, error: 'Could not read the attached image.' };
  }
  if (bytes.length === 0) return { ok: true, image: null };
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'Screenshot is too large (max 8 MB). Try a smaller capture.' };
  }

  const ext = mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] || 'png');
  const rawName = typeof (raw as { name?: unknown }).name === 'string'
    ? (raw as { name: string }).name
    : '';
  const sanitized = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+/, '').slice(0, 64);
  const filename = sanitized && /\.[a-z0-9]+$/i.test(sanitized) ? sanitized : `screenshot.${ext}`;
  return { ok: true, image: { bytes, mime, filename } };
}

/**
 * Collect attachments from `body.images` (array) plus the legacy `body.image`
 * (single), cap at MAX_IMAGES, enforce an 8 MB combined ceiling (Discord's
 * baseline webhook upload limit), and de-dupe filenames so every `files[n]` part
 * and its `attachment://` ref stay unique.
 */
function parseImages(body: FeedbackBody): { ok: true; images: ParsedImage[] } | { ok: false; error: string } {
  const raw: unknown[] = [];
  if (Array.isArray(body.images)) raw.push(...body.images);
  if (body.image != null) raw.push(body.image);

  const images: ParsedImage[] = [];
  let total = 0;
  for (const item of raw.slice(0, MAX_IMAGES)) {
    const parsed = parseImage(item);
    if (!parsed.ok) return parsed;
    if (!parsed.image) continue;
    total += parsed.image.bytes.length;
    if (total > MAX_IMAGE_BYTES) {
      return { ok: false, error: 'Attachments are too large (max 8 MB total). Remove one or use smaller images.' };
    }
    images.push(parsed.image);
  }

  const seen = new Set<string>();
  for (const img of images) {
    let name = img.filename;
    let i = 1;
    while (seen.has(name)) {
      const dot = img.filename.lastIndexOf('.');
      name = dot > 0 ? `${img.filename.slice(0, dot)}-${i}${img.filename.slice(dot)}` : `${img.filename}-${i}`;
      i += 1;
    }
    img.filename = name;
    seen.add(name);
  }
  return { ok: true, images };
}

async function resolveProjectLabel(): Promise<string | null> {
  try {
    const surface = readIdeSurfaceState();
    const activeRepoPath = surface?.activeRepoPath ?? surface?.terminalRepoPaths[0] ?? null;
    const repo = activeRepoPath ? await findRepoByLocalPath(activeRepoPath) : null;
    const scope = getActiveProjectScopeForRepoSync(activeRepoPath);
    const projectName = scope.project.name.trim();
    const repoName = repo?.name?.trim() || null;

    if (projectName && repoName && projectName !== repoName) {
      return truncate(`${projectName} / ${repoName}`, DISCORD_FIELD_VALUE_LIMIT);
    }
    if (repoName) return truncate(repoName, DISCORD_FIELD_VALUE_LIMIT);
    if (projectName && projectName !== 'Workspace') return truncate(projectName, DISCORD_FIELD_VALUE_LIMIT);
  } catch {
    return null;
  }
  return null;
}

async function buildDiagnostics(route: string, userAgent: string): Promise<ReportDiagnostics> {
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  // x64 node reporting an Apple-branded CPU = running under Rosetta on Apple
  // Silicon — a distinct bug population (o8 ships x86_64-only), so name it.
  const cpuModel = os.cpus()[0]?.model ?? '';
  const rosetta = arch === 'x64' && /^Apple\b/.test(cpuModel) ? ' (Rosetta on Apple Silicon)' : '';
  return {
    version: readServerVersion(),
    osLabel: `${platform} ${release} ${arch}${rosetta}`,
    nodeVersion: process.version,
    route,
    userAgent,
    projectLabel: await resolveProjectLabel(),
    timestamp: new Date().toISOString(),
  };
}

interface Report {
  id: string;
}

function field(name: string, value: string) {
  return {
    name,
    value: truncate(value, DISCORD_FIELD_VALUE_LIMIT),
    inline: true,
  };
}

function buildEmbed(category: FeedbackCategory, message: string, diagnostics: ReportDiagnostics, crashes: CrashDigest, client: ClientDiagnostics | null, report: Report) {
  const fields = [
    field('Version', diagnostics.version),
    field('OS', diagnostics.osLabel),
    field('Node', diagnostics.nodeVersion),
    field('Route', diagnostics.route),
    ...(diagnostics.projectLabel ? [field('Project', diagnostics.projectLabel)] : []),
    field('Timestamp', diagnostics.timestamp),
    // Full-width: geometry + drift + buffered-error count. Triage starts here —
    // a healthy shell reads `bodyScroll 0 · dashTop 0`; the full ring buffer
    // rides in diagnostics.txt.
    ...(client
      ? [{ name: 'State', value: truncate(clientStateSummary(client), DISCORD_FIELD_VALUE_LIMIT), inline: false }]
      : []),
    // Full-width: the summary carries a stack-trace head that reads badly in a
    // narrow inline column, and the traces themselves ride as crashes.txt.
    ...(crashes.count > 0
      ? [{ name: 'Crashes', value: truncate(crashes.summary, DISCORD_FIELD_VALUE_LIMIT), inline: false }]
      : []),
  ];

  // The id is the handle a fix will reach back through: a commit carrying
  // `Fixes-Report: <id>` is what publishes this to #fixed, credited.
  const footer = { text: `o8 · report ${report.id} · private intake` };
  const title = truncate(`${category === 'bug' ? '[BUG]' : '[REQUEST]'} ${report.id} · ${reportTitle(message)}`, DISCORD_TITLE_LIMIT);
  const baseTextLength = title.length
    + footer.text.length
    + fields.reduce((sum, item) => sum + item.name.length + item.value.length, 0);
  const allowedDescription = Math.max(0, DISCORD_EMBED_TOTAL_LIMIT - baseTextLength);

  return {
    title,
    description: truncate(message, Math.min(DISCORD_DESCRIPTION_LIMIT, allowedDescription)),
    color: category === 'bug' ? 0xd94f3a : 0x1d4ed8,
    fields,
    footer,
  };
}

async function postHostedReport(category: FeedbackCategory, message: string, diagnostics: ReportDiagnostics, images: ParsedImage[], crashes: CrashDigest, client: ClientDiagnostics | null, report: Report): Promise<{ ok: true } | { ok: false; error: string }> {
  const embed = {
    ...buildEmbed(category, message, diagnostics, crashes, client, report),
    // Render the first screenshot inline in the embed; the rest ride along as
    // additional attachments. The attachment:// URL must match a file below.
    ...(images[0] ? { image: { url: `attachment://${images[0].filename}` } } : {}),
  };
  const payload = {
    username: 'o8 Report',
    embeds: [embed],
  };

  // Stack traces + the console ring buffer blow past Discord's 1024-char field
  // cap, so the full forensics ride as a file rather than inline. Image
  // filenames are caller-supplied, so step around one that claims our name.
  const diagnosticsText = redactSecrets([
    client ? renderClientDiagnostics(client) : '',
    crashes.text ? `── CRASHES (24h window) ──\n${crashes.text}` : '',
  ].filter(Boolean).join('\n'));
  const taken = new Set(images.map((img) => img.filename));
  let crashName = 'diagnostics.txt';
  for (let i = 1; taken.has(crashName); i += 1) crashName = `diagnostics-${i}.txt`;
  const crashFile = diagnosticsText
    ? { bytes: Buffer.from(diagnosticsText, 'utf8'), mime: 'text/plain', filename: crashName }
    : null;

  const files: ParsedImage[] = crashFile ? [...images, crashFile] : images;
  return postHostedPayload(payload, report.id, files);
}

export async function POST(request: NextRequest) {
  let dataSharingEnabled = false;
  try {
    dataSharingEnabled = resolveCrashReportsEnabledSync();
  } catch {
    // Privacy-first: an unreadable preference can never fall through to a send.
  }
  if (!dataSharingEnabled) {
    return jsonError(REPORT_DATA_SHARING_OFF_ERROR, 403, REPORT_DATA_SHARING_OFF_MESSAGE);
  }

  let body: FeedbackBody;
  try {
    body = (await request.json()) as FeedbackBody;
  } catch {
    return jsonError('Invalid JSON body.');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError('Invalid report body.');
  }
  if (body.kind !== undefined) {
    if (body.kind !== 'feedback') return jsonError('Invalid report kind.');
    try {
      const metadata = body.includeMetadata === true
        ? { version: readServerVersion(), os: `${os.platform()} ${os.release()}` }
        : undefined;
      const result = await sendMinimalFeedback(body as Record<string, unknown>, metadata);
      return result.ok
        ? NextResponse.json(result)
        : jsonError(result.error, result.status);
    } catch (error) {
      return jsonError(error instanceof Error ? error.message : 'Failed to send feedback.', 500);
    }
  }

  const validated = validateBody(body);
  if (!validated.ok) return jsonError(validated.error);

  const parsedImages = parseImages(body);
  if (!parsedImages.ok) return jsonError(parsedImages.error);

  try {
    const diagnostics = await buildDiagnostics(validated.route, validated.userAgent);
    // Diagnostics (crash digest + client snapshot) attach when the client sent
    // them — the shared submitReport client includes them by DEFAULT with an
    // opt-out (Q ruling 2026-07-15: a report should carry its own forensics;
    // the intake is private). Old clients omit both fields → nothing attaches.
    const crashes: CrashDigest = body.includeDiagnostics === true
      ? collectCrashDigest()
      : { count: 0, records: [], summary: '', text: '' };
    const client = body.includeDiagnostics === true ? parseClientDiagnostics(body.client) : null;
    const report: Report = { id: newReportId() };

    const posted = await postHostedReport(validated.category, validated.message, diagnostics, parsedImages.images, crashes, client, report);
    if (!posted.ok) return jsonError(posted.error, 502);

    // Only ledger a report that actually reached Discord — an id we hand back for
    // a post that never landed is an id that can never be fixed.
    recordReport({
      id: report.id,
      ts: Date.now(),
      category: validated.category,
      title: reportTitle(validated.message),
      reporter: null,
      version: diagnostics.version,
    });

    return NextResponse.json({ ok: true, reportId: report.id });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Failed to send report.', 500);
  }
}
