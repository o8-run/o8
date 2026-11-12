export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { writeFile } from 'node:fs/promises';
import {
  recordArtifact,
  listArtifacts,
  newArtifactId,
  artifactRelPath,
  artifactAbsPath,
  artifactExtForMime,
  ensureArtifactBucket,
  toArtifactView,
  type ArtifactKind,
  type ArtifactSource,
  type ArtifactPhase,
} from '@/lib/artifacts/store';
import { publishArtifactRecorded } from '@/lib/realtime/publisher';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { packetHasRecordedPr } from '@/lib/artifacts/worker-binding';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { getLane } from '@/lib/lane/registry';

import { ARTIFACT_MAX_BYTES as MAX_BYTES } from '@/lib/artifacts/limits';
const VALID_SOURCES: ReadonlySet<string> = new Set<ArtifactSource>(['agent-capture', 'review-boundary', 'manual']);
const VALID_KINDS: ReadonlySet<string> = new Set<ArtifactKind>(['screenshot', 'video']);

interface IngestMeta {
  source: ArtifactSource;
  kind: ArtifactKind;
  packetId: string | null;
  laneId: string | null;
  repoPath: string | null;
  threadId: string | null;
  prNumber: number | null;
  label: string | null;
  phase: ArtifactPhase;
  pairId: string | null;
  width: number | null;
  height: number | null;
}

function asStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t || null;
}
function asNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function normalizePhase(v: unknown): ArtifactPhase {
  return v === 'before' || v === 'after' ? v : null;
}

/** Validate metadata common to both ingest shapes. Returns meta or an error string. */
function buildMeta(get: (k: string) => unknown): IngestMeta | string {
  const source = (asStr(get('source')) ?? 'agent-capture') as ArtifactSource;
  if (!VALID_SOURCES.has(source)) return `Invalid source. Allowed: ${[...VALID_SOURCES].join(', ')}.`;
  const kind = (asStr(get('kind')) ?? 'screenshot') as ArtifactKind;
  if (!VALID_KINDS.has(kind)) return `Invalid kind. Allowed: ${[...VALID_KINDS].join(', ')}.`;
  return {
    source,
    kind,
    packetId: asStr(get('packetId')),
    laneId: asStr(get('laneId')),
    repoPath: asStr(get('repoPath')),
    threadId: asStr(get('threadId')),
    prNumber: asNum(get('prNumber')),
    label: asStr(get('label')),
    phase: normalizePhase(get('phase')),
    pairId: asStr(get('pairId')),
    width: asNum(get('width')),
    height: asNum(get('height')),
  };
}

/**
 * GET /api/panel/artifacts?packetId=… | prNumber=… | laneId=… | threadId=…
 * Returns { artifacts: ArtifactView[] } (serve URLs attached; never raw disk paths).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const packetId = searchParams.get('packetId');
  const prRaw = searchParams.get('prNumber');
  const laneId = searchParams.get('laneId');
  const threadId = searchParams.get('threadId');
  const prNumber = prRaw !== null && Number.isFinite(Number(prRaw)) ? Number(prRaw) : null;

  if (!packetId && prNumber === null && !laneId && !threadId) {
    return NextResponse.json({ error: 'Provide one of packetId, prNumber, laneId, threadId.' }, { status: 400 });
  }
  const ownershipRefusal = workerPacketRefusal(
    resolveRequestPrincipalContext(request),
    packetId || (laneId ? getLane(laneId)?.packetId : null),
  );
  if (ownershipRefusal) {
    return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
  }

  try {
    const rows = listArtifacts({ packetId, prNumber, laneId, threadId })
      .filter((artifact) => artifact.kind !== 'receipt');
    return NextResponse.json({ artifacts: rows.map(toArtifactView) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'list failed', artifacts: [] }, { status: 500 });
  }
}

/**
 * POST /api/panel/artifacts — ingest agent-captured proof. Two shapes:
 *  - application/json: { bytesBase64, mimeType, source, kind, packetId, ... }  (the o8 CLI)
 *  - multipart/form-data: file=<bytes> + metadata fields                       (future / manual)
 *
 * Writes bytes to <dataDir>/artifacts/<packetId>/<id>.<ext>, inserts a row, and
 * returns { artifactId, url, relPath }. Never throws — structured errors only.
 */
export async function POST(request: Request) {
  const contentType = request.headers.get('content-type') ?? '';

  let buffer: Buffer;
  let mimeType: string;
  let meta: IngestMeta;

  try {
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown>;
      const b64 = asStr(body.bytesBase64);
      if (!b64) return NextResponse.json({ error: 'Missing `bytesBase64`.' }, { status: 400 });
      buffer = Buffer.from(b64, 'base64');
      if (buffer.length === 0) return NextResponse.json({ error: 'Decoded bytes are empty.' }, { status: 400 });
      mimeType = asStr(body.mimeType) ?? 'image/png';
      const m = buildMeta((k) => body[k]);
      if (typeof m === 'string') return NextResponse.json({ error: m }, { status: 400 });
      meta = m;
    } else {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof Blob) || file.size === 0) {
        return NextResponse.json({ error: 'Missing or empty `file` field.' }, { status: 400 });
      }
      buffer = Buffer.from(await file.arrayBuffer());
      mimeType = file.type || 'image/png';
      const m = buildMeta((k) => form.get(k));
      if (typeof m === 'string') return NextResponse.json({ error: m }, { status: 400 });
      meta = m;
    }
  } catch {
    return NextResponse.json({ error: 'Could not parse request body.' }, { status: 400 });
  }

  if (buffer.length > MAX_BYTES) {
    return NextResponse.json({ error: `Artifact too large (max ${Math.round(MAX_BYTES / 1024 / 1024)} MB).` }, { status: 413 });
  }
  const principal = resolveRequestPrincipalContext(request);
  const ownershipRefusal = workerPacketRefusal(principal,
    meta.packetId || (meta.laneId ? getLane(meta.laneId)?.packetId : null))
    || (meta.laneId ? workerPacketRefusal(principal, getLane(meta.laneId)?.packetId) : null);
  if (ownershipRefusal) {
    return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
  }

  if (principal.role === 'worker') {
    const packet = readOrchestratorControlPlaneState().packets.find(p => p.id === principal.packetId);
    if (!packet
      || (meta.prNumber !== null && !packetHasRecordedPr(packet.id, meta.prNumber))
      || (meta.threadId !== null && meta.threadId !== packet.orchestratorThreadId)
      || (meta.repoPath !== null && meta.repoPath !== packet.workspaceTargetPath)) {
      return NextResponse.json({ ok: false, error: { code: 'worker_packet_mismatch',
        message: 'Artifact associations must match the caller packet.' } }, { status: 403 });
    }
  }

  const id = newArtifactId();
  const ext = artifactExtForMime(mimeType);
  const relPath = artifactRelPath(meta.packetId, id, ext);

  try {
    ensureArtifactBucket(meta.packetId);
    await writeFile(artifactAbsPath(relPath), buffer);

    const rec = recordArtifact({ id, relPath, mimeType, bytes: buffer.length, ...meta });
    if (!rec) {
      return NextResponse.json({ error: 'Artifact stored on disk but DB unavailable.' }, { status: 500 });
    }
    // #1147 Phase 2 — notify mounted proof strips to refetch live. Fire-and-
    // forget; never blocks the ingest response or throws on a downed bridge.
    void publishArtifactRecorded({
      artifactId: rec.id,
      packetId: rec.packetId,
      prNumber: rec.prNumber,
      laneId: rec.laneId,
    });
    const view = toArtifactView(rec);
    return NextResponse.json({ artifactId: rec.id, url: view.url, relPath: rec.relPath });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Failed to store artifact.' }, { status: 500 });
  }
}
