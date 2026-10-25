import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizePacketSpendTelemetry, type PacketSpendTelemetry } from '@/lib/orchestrator/metered-spend';
import { withProviderStoreLock } from '@/lib/providers/store-lock';

const telemetryFile = (sessionDir: string) => path.join(sessionDir, 'gateway-spend.json');

/** Missing means no observation; unreadable existing evidence cannot grant more spend. */
export function readMeteredGatewayTelemetrySync(sessionDir: string): PacketSpendTelemetry | null {
  try {
    const raw = JSON.parse(readFileSync(telemetryFile(sessionDir), 'utf8'));
    const normalized = normalizePacketSpendTelemetry(raw);
    if (normalized) return normalized;
    // A durable stop stands independently of incomplete numeric telemetry.
    if (raw?.capHit === true) return {
      costUsd: null, inputTokens: 0, outputTokens: 0,
      costSource: 'unknown', capHit: true, updatedAt: new Date(0).toISOString(),
    };
    throw new Error('Invalid metered telemetry.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Persisted metered gateway telemetry is unavailable; recovery is held.');
  }
}

export function mergeMeteredGatewayTelemetry(previous: PacketSpendTelemetry | null, next: PacketSpendTelemetry): PacketSpendTelemetry {
  if (!previous) return next;
  return {
    ...next, capHit: previous.capHit || next.capHit,
    costUsd: previous.costUsd === null ? next.costUsd : next.costUsd === null ? previous.costUsd : Math.max(previous.costUsd, next.costUsd),
    costSource: previous.costUsd !== null && next.costUsd === null ? previous.costSource : next.costSource,
    inputTokens: Math.max(previous.inputTokens, next.inputTokens),
    outputTokens: Math.max(previous.outputTokens, next.outputTokens),
  };
}

/** The shared OS lock makes the read/latch/write indivisible across launchers. */
export function persistMeteredGatewayTelemetry(sessionDir: string, next: PacketSpendTelemetry): PacketSpendTelemetry {
  return withProviderStoreLock(() => {
    const merged = mergeMeteredGatewayTelemetry(readMeteredGatewayTelemetrySync(sessionDir), next);
    const file = telemetryFile(sessionDir);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(merged, null, 2), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
    return merged;
  });
}
