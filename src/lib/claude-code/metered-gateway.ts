import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';

import { recordLaneEvent } from '@/lib/lane/events';
import { packetSpendCapBreach, type PacketSpendCap, type PacketSpendTelemetry } from '@/lib/orchestrator/metered-spend';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import { readMeteredGatewayTelemetrySync, mergeMeteredGatewayTelemetry, persistMeteredGatewayTelemetry } from './metered-gateway-telemetry';

interface Registration {
  session: OwnedSessionRecord;
  upstreamBaseUrl: string;
  cap: PacketSpendCap;
  telemetry: PacketSpendTelemetry;
  admission: { pending: Promise<void> };
}

const registrations = new Map<string, Registration>();
const admissions = new Map<string, Registration['admission']>();
let serverPromise: Promise<{ port: number }> | null = null;

function finiteNonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function objectsIn(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return [];
  const root = value as Record<string, unknown>;
  return [root, ...Object.values(root).flatMap(objectsIn)];
}

function parseGatewayUsage(raw: string): { costUsd: number | null; inputTokens: number; outputTokens: number; generationId: string | null } {
  const values: unknown[] = [];
  for (const line of raw.split('\n')) {
    const candidate = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
    if (!candidate || candidate === '[DONE]') continue;
    try { values.push(JSON.parse(candidate)); } catch { /* non-JSON stream line */ }
  }
  if (values.length === 0) {
    try { values.push(JSON.parse(raw)); } catch { /* malformed upstream response */ }
  }
  let costUsd: number | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let generationId: string | null = null;
  for (const value of values) {
    for (const object of objectsIn(value)) {
      const usage = object.usage && typeof object.usage === 'object'
        ? object.usage as Record<string, unknown>
        : object;
      const cost = finiteNonnegative(usage.cost) ?? finiteNonnegative(usage.total_cost);
      if (cost !== null) costUsd = cost;
      inputTokens = Math.max(inputTokens, Math.round(finiteNonnegative(usage.input_tokens) ?? finiteNonnegative(usage.prompt_tokens) ?? 0));
      outputTokens = Math.max(outputTokens, Math.round(finiteNonnegative(usage.output_tokens) ?? finiteNonnegative(usage.completion_tokens) ?? 0));
      if (!generationId && typeof object.id === 'string' && object.id.trim()) generationId = object.id.trim();
    }
  }
  return { costUsd, inputTokens, outputTokens, generationId };
}

async function queryGenerationCost(registration: Registration, generationId: string, headers: Headers): Promise<number | null> {
  try {
    const url = new URL('./v1/generation', `${registration.upstreamBaseUrl.replace(/\/$/, '')}/`);
    url.searchParams.set('id', generationId);
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    return parseGatewayUsage(await response.text()).costUsd;
  } catch {
    return null;
  }
}

async function requestBody(request: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

async function enforceCap(registration: Registration): Promise<boolean> {
  const telemetry = registration.telemetry;
  const breach = packetSpendCapBreach(registration.cap, telemetry);
  if (telemetry.capHit) { await persistTelemetry(registration); return true; }
  if (!breach) return false;
  telemetry.capHit = true;
  await persistTelemetry(registration);
  const { packetId, laneId } = registration.session;
  const { patchMissionPacket } = await import('@/lib/orchestrator/operator-mission-service/packet-patch');
  const reason = breach === 'cost'
    ? `Metered packet spend cap reached ($${telemetry.costUsd!.toFixed(6)} / $${registration.cap.costUsd.toFixed(2)}).`
    : `Metered packet input cap reached (${telemetry.inputTokens} / ${registration.cap.inputTokens} tokens; gateway cost unavailable).`;
  if (packetId) {
    await patchMissionPacket(packetId, {
      spendCap: registration.cap,
      spendTelemetry: telemetry,
      status: 'failed',
      queueState: 'held',
      operatorStopped: true,
      blockedReason: reason,
      lastEventAt: telemetry.updatedAt,
      lastEventLabel: 'spend_cap_hit',
    });
  }
  if (laneId) {
    recordLaneEvent(laneId, 'spend_cap_hit', 'system', {
      packetId: packetId ?? null,
      costUsd: telemetry.costUsd,
      inputTokens: telemetry.inputTokens,
      costSource: telemetry.costSource,
      costCapUsd: registration.cap.costUsd,
      inputTokenCap: registration.cap.inputTokens,
      reason,
    });
    const { escalateInterruptOwnedSurface } = await import('@/lib/runtime/interrupt-escalation');
    const interrupted = await escalateInterruptOwnedSurface(registration.session.surfaceId);
    for (const step of interrupted?.steps ?? []) {
      recordLaneEvent(laneId, 'kill_escalated', 'system', {
        sessionKey: registration.session.surfaceId,
        stage: step.mechanism,
        pid: interrupted?.pid,
        confirmed: step.confirmedDead,
        source: 'spend_cap_hit',
      });
    }
  }
  if (packetId) {
    void import('@/lib/orchestrator/stop-packet')
      .then(({ stopPacket }) => stopPacket(packetId))
      .catch((error) => console.error('[metered-gateway] Failed to stop capped packet.', error));
  }
  return true;
}

async function persistTelemetry(registration: Registration): Promise<void> {
  registration.telemetry.updatedAt = new Date().toISOString();
  registration.telemetry = persistMeteredGatewayTelemetry(registration.session.sessionDir, registration.telemetry);
  if (registration.session.packetId) {
    const { patchMissionPacket } = await import('@/lib/orchestrator/operator-mission-service/packet-patch');
    await patchMissionPacket(registration.session.packetId, {
      spendCap: registration.cap,
      spendTelemetry: registration.telemetry,
    });
  }
}

async function relay(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const incomingUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  const [, key, ...suffix] = incomingUrl.pathname.split('/');
  const registration = registrations.get(key);
  if (!registration) {
    response.writeHead(404).end('Unknown metered gateway session.');
    return;
  }
  const previous = registration.admission.pending;
  let release!: () => void;
  registration.admission.pending = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    if (!registration.telemetry.capHit) registration.telemetry = mergeMeteredGatewayTelemetry(
      readMeteredGatewayTelemetrySync(registration.session.sessionDir), registration.telemetry);
    if (registration.telemetry.capHit) {
      response.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Packet spend cap reached.' } }));
      return;
    }
    if (await enforceCap(registration)) {
      response.writeHead(429).end('Packet spend cap reached.'); return;
    }
    await forward(registration, request, response, incomingUrl, suffix);
  } finally { release(); }
}

async function forward(registration: Registration, request: IncomingMessage, response: ServerResponse, incomingUrl: URL, suffix: string[]): Promise<void> {
  const upstream = new URL(suffix.join('/'), `${registration.upstreamBaseUrl.replace(/\/$/, '')}/`);
  upstream.search = incomingUrl.search;
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (name === 'host' || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('x-openrouter-metadata', 'enabled');
  const body = await requestBody(request);
  // Uploading can yield after relay admission. Nothing may yield between this
  // final successful durable check and starting the upstream request.
  registration.telemetry = mergeMeteredGatewayTelemetry(
    readMeteredGatewayTelemetrySync(registration.session.sessionDir), registration.telemetry);
  if (registration.telemetry.capHit || packetSpendCapBreach(registration.cap, registration.telemetry)) {
    await enforceCap(registration);
    response.writeHead(429).end('Packet spend cap reached.');
    return;
  }
  const upstreamResponse = await fetch(upstream, { method: request.method, headers, body });
  const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
  const usage = parseGatewayUsage(bytes.toString('utf8'));
  const exactCost = usage.costUsd ?? (usage.generationId ? await queryGenerationCost(registration, usage.generationId, headers) : null);
  try {
    registration.telemetry = mergeMeteredGatewayTelemetry(readMeteredGatewayTelemetrySync(registration.session.sessionDir), registration.telemetry);
  } catch (error) {
    if (packetSpendCapBreach(registration.cap, { costUsd: exactCost === null ? registration.telemetry.costUsd : (registration.telemetry.costUsd ?? 0) + exactCost,
      inputTokens: registration.telemetry.inputTokens + usage.inputTokens })) registration.telemetry.capHit = true;
    throw error;
  }
  if (exactCost !== null) {
    registration.telemetry.costUsd = (registration.telemetry.costUsd ?? 0) + exactCost;
    registration.telemetry.costSource = 'gateway';
  }
  registration.telemetry.inputTokens += usage.inputTokens;
  registration.telemetry.outputTokens += usage.outputTokens;
  if (await enforceCap(registration)) {
    response.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Packet spend cap reached.' } }));
    return;
  }
  await persistTelemetry(registration);
  const responseHeaders: Record<string, string> = {};
  upstreamResponse.headers.forEach((value, name) => { responseHeaders[name] = value; });
  delete responseHeaders['content-encoding'];
  delete responseHeaders['content-length'];
  delete responseHeaders['transfer-encoding'];
  response.writeHead(upstreamResponse.status, responseHeaders).end(bytes);
}

async function ensureServer(): Promise<{ port: number }> {
  if (serverPromise) return serverPromise;
  serverPromise = new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      void relay(request, response).catch((error) => {
        console.error('[metered-gateway] Relay failed.', error);
        if (!response.headersSent) response.writeHead(502);
        response.end('Metered gateway relay failed closed.');
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Metered gateway did not bind a TCP port.'));
      resolve({ port: address.port });
    });
  });
  return serverPromise;
}

export async function prepareMeteredGatewaySession(session: OwnedSessionRecord, upstreamBaseUrl: string, cap: PacketSpendCap): Promise<string> {
  const sessionDir = realpathSync(session.sessionDir);
  const telemetry = readMeteredGatewayTelemetrySync(sessionDir);
  const { port } = await ensureServer();
  const key = randomUUID();
  const admission = admissions.get(sessionDir) ?? { pending: Promise.resolve() };
  admissions.set(sessionDir, admission);
  registrations.set(key, {
    session: { ...session, sessionDir },
    upstreamBaseUrl,
    cap,
    admission,
    telemetry: telemetry ?? { costUsd: null, inputTokens: 0, outputTokens: 0, costSource: 'unknown', capHit: false, updatedAt: new Date().toISOString() },
  });
  return `http://127.0.0.1:${port}/${key}`;
}

export async function readMeteredGatewayTelemetry(sessionDir: string): Promise<PacketSpendTelemetry | null> {
  try {
    return readMeteredGatewayTelemetrySync(sessionDir);
  } catch {
    return null;
  }
}
