'use client';
import { ProviderCacheStats } from '../SessionCacheIndicator';

import { useState, type ReactNode } from 'react';

import type { RuntimeCapacityControlSnapshot } from '@/lib/runtime/capacity-service';
import { fetchCorrelatedActionReceipt } from '@/lib/orchestrator/action-receipt';
import type { RuntimeCapacityBucket, RuntimeCapacitySnapshot } from '@/lib/runtimes/types';
import { requestPrompt } from '@/components/shared/ConfirmToastHost';
import { ClaudeIcon, CodexIcon } from '../repo-registry/shared';
import { RefreshCw } from '../lucide-shims';
import { pickRepoFolder } from '../repo-registry/pickRepoFolder';

const FONT = 'var(--font-sans-system)';
const MONO = '"SF Mono", ui-monospace, "Cascadia Code", Menlo, monospace';
const TEXT = 'var(--t-text, #0f172a)';
const MUTED = 'var(--t-text-muted, #64748b)';
const SUBTLE_BG = 'var(--t-bg-card, rgba(15, 23, 42, 0.04))';

function runtimeName(runtime: string): string {
  if (runtime === 'codex') return 'Codex';
  if (runtime === 'claude-code') return 'Claude';
  return runtime;
}

function runtimeIcon(runtime: string): ReactNode {
  if (runtime === 'codex') return <CodexIcon size={13} />;
  if (runtime === 'claude-code') return <ClaudeIcon size={13} />;
  return null;
}

function formatTime(value: string | null): string {
  if (!value) return 'Not observed';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Invalid time';
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function bucketValue(bucket: RuntimeCapacityBucket): string {
  if (typeof bucket.usedRatio === 'number') return `${Math.round(bucket.usedRatio * 100)}% used`;
  if (typeof bucket.remaining === 'number') return `${bucket.remaining} remaining`;
  if (typeof bucket.used === 'number' && bucket.unit) {
    const value = bucket.used >= 1_000_000
      ? `${(bucket.used / 1_000_000).toFixed(1)}M`
      : bucket.used >= 1_000
        ? `${(bucket.used / 1_000).toFixed(1)}k`
        : String(bucket.used);
    return `${value} ${bucket.unit} used`;
  }
  return 'No quota total';
}

function resetValue(bucket: RuntimeCapacityBucket): string {
  const value = bucket.resetsAt ?? bucket.expiresAt;
  if (!value) return 'No reset reported';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Invalid reset';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function statusCopy(capacity: RuntimeCapacitySnapshot): string {
  if (capacity.status === 'stale') return 'Stale observation';
  if (capacity.status === 'malformed') return 'Provider data malformed';
  if (capacity.status === 'unavailable') return 'Capacity unavailable';
  if (capacity.confidence === 'exact') return 'Exact provider limits';
  if (capacity.confidence === 'estimated') return 'Estimated local activity';
  return 'Exhaustion signal only';
}

function statusColor(capacity: RuntimeCapacitySnapshot): string {
  if (capacity.status === 'available') return TEXT;
  if (capacity.status === 'stale') return 'var(--t-brand-orange, #f97316)';
  return MUTED;
}

function MiniBar({ ratio }: { ratio: number | null }) {
  return (
    <div
      aria-hidden="true"
      style={{
        height: 2,
        borderRadius: 999,
        overflow: 'hidden',
        background: 'color-mix(in srgb, var(--t-panel-border, rgba(15,23,42,0.1)) 70%, transparent)',
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${ratio === null ? 100 : Math.max(0, Math.min(1, ratio)) * 100}%`,
          opacity: ratio === null ? 0.18 : 0.9,
          borderRadius: 999,
          background: 'var(--t-accent, #2563eb)',
        }}
      />
    </div>
  );
}

function RuntimeCapacityCard({
  capacity,
  snapshot,
  onSelected,
  showIdentityControls,
}: {
  capacity: RuntimeCapacitySnapshot;
  snapshot: RuntimeCapacityControlSnapshot;
  onSelected: () => void;
  showIdentityControls: boolean;
}) {
  const [selecting, setSelecting] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const identities = snapshot.identities.filter((identity) => identity.runtime === capacity.runtime);
  const capability = snapshot.runtimes.find((runtime) => runtime.runtime === capacity.runtime);
  const observedIdentity = identities.find((identity) => identity.id === capacity.identityId);
  const selected = identities.find((identity) => identity.selected);

  const selectIdentity = async (identityId: string) => {
    if (selecting || identityId === selected?.id) return;
    setSelecting(identityId);
    setMutationError(null);
    try {
      const receipt = await fetchCorrelatedActionReceipt<{ ok: boolean; result?: { inProgress?: boolean } }>('/api/runtime/capacity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'select',
          runtime: capacity.runtime,
          identityId,
          clientMutationId: crypto.randomUUID(),
        }),
      });
      if (receipt.response.ok && receipt.payload?.ok) onSelected();
      else setMutationError('The identity selection was not accepted.');
    } catch {
      setMutationError('Identity selection is still unsettled. Refresh before trying again.');
    } finally {
      setSelecting(null);
    }
  };

  const registerIdentity = async () => {
    if (registering) return;
    setRegistering(true);
    setMutationError(null);
    try {
      const configHomeRef = await pickRepoFolder(
        `Select ${runtimeName(capacity.runtime)} identity folder`,
        'Enter the local config-home folder that contains this runtime sign-in.',
      );
      if (!configHomeRef) return;
      const fallbackLabel = configHomeRef.split(/[\\/]/).filter(Boolean).at(-1) ?? runtimeName(capacity.runtime);
      const label = await requestPrompt({
        title: 'Name this identity',
        message: 'o8 stores the local label and folder reference, never the credential contents.',
        defaultValue: fallbackLabel,
        confirmLabel: 'Register',
      });
      if (!label?.trim()) return;
      const receipt = await fetchCorrelatedActionReceipt<{ ok: boolean; result?: { inProgress?: boolean } }>('/api/runtime/capacity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'register',
          runtime: capacity.runtime,
          label: label.trim(),
          configHomeRef,
          clientMutationId: crypto.randomUUID(),
        }),
      });
      if (receipt.response.ok && receipt.payload?.ok) onSelected();
      else setMutationError('That folder was not accepted as a runtime identity home.');
    } catch {
      setMutationError('Identity registration is still unsettled. Refresh before trying again.');
    } finally {
      setRegistering(false);
    }
  };

  return (
    <section style={{ display: 'grid', gap: 5, paddingTop: 2, paddingRight: 4, paddingBottom: 4, paddingLeft: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 13, height: 13, display: 'inline-flex' }}>{runtimeIcon(capacity.runtime)}</span>
        <span style={{ color: TEXT, fontSize: 12, fontWeight: 400 }}>{runtimeName(capacity.runtime)}</span>
        <span style={{ flex: 1, color: statusColor(capacity), fontSize: 9.5, textAlign: 'right' }}>
          {statusCopy(capacity)}
        </span>
      </div>

      {observedIdentity ? (
        <div style={{ color: MUTED, fontSize: 10.5 }}>
          {observedIdentity.label}{observedIdentity.selected ? ' · selected for new turns' : ''}
        </div>
      ) : (
        <div style={{ color: MUTED, fontSize: 10.5 }}>Current local sign-in</div>
      )}

      <ProviderCacheStats runtime={capacity.runtime} />
      {capacity.buckets.map((bucket) => (
        <div key={bucket.id} style={{ display: 'grid', gap: 2 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
            <span style={{ flex: 1, color: TEXT, fontSize: 10.5 }}>{bucket.label}</span>
            <span style={{ color: MUTED, fontFamily: MONO, fontSize: 9 }}>{bucketValue(bucket)}</span>
            <span style={{ color: MUTED, fontFamily: MONO, fontSize: 9 }}>{resetValue(bucket)}</span>
          </div>
          <MiniBar ratio={bucket.usedRatio} />
        </div>
      ))}

      {capacity.buckets.length === 0 ? (
        <div style={{ color: MUTED, fontSize: 10.5 }}>{capacity.reason?.replaceAll('_', ' ') ?? 'No observation'}</div>
      ) : null}

      <div style={{ color: MUTED, fontSize: 9.5 }}>
        {capacity.confidence ?? 'No confidence'} · {capacity.source ?? 'No source'} · {formatTime(capacity.observedAt)}
      </div>

      {showIdentityControls && capability?.identitySelection ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {identities.map((identity) => (
            <button
              key={identity.id}
              type="button"
              disabled={Boolean(selecting) || identity.id === selected?.id}
              onClick={() => { void selectIdentity(identity.id); }}
              style={{
                minHeight: 22,
                border: '1px solid var(--t-panel-border, rgba(15,23,42,0.1))',
                borderRadius: 7,
                paddingTop: 2,
                paddingRight: 7,
                paddingBottom: 2,
                paddingLeft: 7,
                background: identity.id === selected?.id ? SUBTLE_BG : 'transparent',
                color: identity.id === selected?.id ? TEXT : MUTED,
                fontFamily: FONT,
                fontSize: 9.5,
                cursor: identity.id === selected?.id ? 'default' : 'pointer',
              }}
            >
              {selecting === identity.id ? 'Selecting…' : identity.label}
            </button>
          ))}
          <button
            type="button"
            disabled={registering || Boolean(selecting)}
            onClick={() => { void registerIdentity(); }}
            style={{
              minHeight: 22,
              border: '1px solid var(--t-panel-border, rgba(15,23,42,0.1))',
              borderRadius: 7,
              paddingTop: 2,
              paddingRight: 7,
              paddingBottom: 2,
              paddingLeft: 7,
              background: 'transparent',
              color: MUTED,
              fontFamily: FONT,
              fontSize: 9.5,
              cursor: registering ? 'default' : 'pointer',
            }}
          >
            {registering ? 'Registering…' : 'Add identity'}
          </button>
        </div>
      ) : capability?.identitySelectionReason ? (
        <div style={{ color: MUTED, fontSize: 9.5, lineHeight: 1.3 }}>{capability.identitySelectionReason}</div>
      ) : null}
      {mutationError ? <div style={{ color: MUTED, fontSize: 9.5, lineHeight: 1.3 }}>{mutationError}</div> : null}
    </section>
  );
}

export function CapacityRows({
  snapshot,
  loading,
  error,
  onRefresh,
}: {
  snapshot: RuntimeCapacityControlSnapshot | null;
  loading: boolean;
  error: string | null;
  onRefresh: (fresh?: boolean) => void;
}) {
  return (
    <div style={{ display: 'grid', gap: 4, paddingTop: 0, paddingRight: 4, paddingBottom: 3, paddingLeft: 28 }}>
      {snapshot?.capacities.map((capacity, index, capacities) => (
        <RuntimeCapacityCard
          key={`${capacity.runtime}:${capacity.identityId ?? 'default'}`}
          capacity={capacity}
          snapshot={snapshot}
          onSelected={() => onRefresh(true)}
          showIdentityControls={capacities.findIndex((candidate) => candidate.runtime === capacity.runtime) === index}
        />
      ))}
      {!snapshot && !loading ? <div style={{ color: MUTED, fontSize: 10.5 }}>Capacity unavailable</div> : null}
      <button
        type="button"
        disabled={loading}
        onClick={() => onRefresh(true)}
        style={{
          height: 24,
          border: 0,
          borderRadius: 8,
          background: SUBTLE_BG,
          color: TEXT,
          fontFamily: FONT,
          fontSize: 11,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          cursor: loading ? 'default' : 'pointer',
        }}
      >
        <RefreshCw size={10} />
        {loading ? 'Refreshing…' : 'Refresh capacity'}
      </button>
      {error ? <div style={{ color: MUTED, fontSize: 10.5, lineHeight: 1.3 }}>{error}</div> : null}
    </div>
  );
}

export function capacitySummary(snapshot: RuntimeCapacityControlSnapshot | null): string {
  if (!snapshot) return 'Local runtimes';
  const stale = snapshot.capacities.some((capacity) => capacity.status === 'stale');
  const unavailable = snapshot.capacities.every((capacity) => capacity.status !== 'available');
  if (stale) return 'Stale';
  if (unavailable) return 'Unavailable';
  return new Date(snapshot.generatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
