import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { getRuntimeCapacityControlSnapshot } from '@/lib/runtime/capacity-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const rowKeys = new Map<string, string>();
function rowKey(runtime: string, identityId: string | null): string {
  const key = JSON.stringify([runtime, identityId]);
  let id = rowKeys.get(key);
  if (!id) { id = randomUUID(); rowKeys.set(key, id); }
  return id;
}

// Structural compatibility with optional provider facts. Project every leaf explicitly.
type Amount = { amount: number; currency: string | null };
type Account = { organization?: string; resetsLeft?: number; credits?: Amount; extraUsage?: { used: Amount; limit?: Amount } };
function amount(value: Amount): Amount { return { amount: value.amount, currency: value.currency }; }
function account(value: Account) {
  return {
    ...(value.organization === undefined ? {} : { organization: value.organization }),
    ...(value.resetsLeft === undefined ? {} : { resetsLeft: value.resetsLeft }),
    ...(value.credits ? { credits: amount(value.credits) } : {}),
    ...(value.extraUsage ? { extraUsage: { used: amount(value.extraUsage.used), ...(value.extraUsage.limit ? { limit: amount(value.extraUsage.limit) } : {}) } } : {}),
  };
}
export async function GET(_request: NextRequest) {
  try {
    const snapshot = await getRuntimeCapacityControlSnapshot();
    const accounts = snapshot.capacities.slice().sort((a, b) => a.runtime.localeCompare(b.runtime) || (a.identityId ?? '').localeCompare(b.identityId ?? '')).map(capacity => {
      const facts = (capacity as typeof capacity & { account?: Account }).account;
      return { id: rowKey(capacity.runtime, capacity.identityId), runtime: capacity.runtime,
        windows: capacity.buckets.map(bucket => ({ label: bucket.label, percentUsed: bucket.usedRatio === null ? null : bucket.usedRatio * 100, resetsAt: bucket.resetsAt })),
        ...(facts ? { account: account(facts) } : {}) };
    });
    return NextResponse.json({ accounts, updatedAt: new Date(snapshot.generatedAt).toISOString() }, { headers: { 'Cache-Control': 'private, max-age=15' } });
  } catch {
    return NextResponse.json({ error: 'Usage unavailable.' }, { status: 503 });
  }
}
