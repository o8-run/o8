'use client';

import { useState, type CSSProperties, type FormEvent } from 'react';

import type { PacketReceipt } from '@/lib/receipts/types';

type TruthQueryKind = 'merged-since' | 'packet' | 'approvals';

interface TruthAnswer {
  summary: string;
  receipt: PacketReceipt;
  receiptRaw: string;
  artifactId: string;
}

interface TruthResponse {
  query: { kind: TruthQueryKind };
  answers: TruthAnswer[];
  asOf: string;
  nextCursor: string | null;
}

interface TruthErrorResponse {
  error?: { message?: string };
}

interface TruthPanelProps {
  token: string;
}

const mono = "'SF Mono', Menlo, Consolas, monospace";

const formStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minWidth: 0,
  paddingTop: 16,
  paddingRight: 16,
  paddingBottom: 16,
  paddingLeft: 16,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-divider-subtle)',
  borderRadius: 14,
  background: 'var(--t-bg-card)',
};

const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  color: 'var(--t-text-faint)',
  fontSize: 10,
  fontWeight: 300,
  letterSpacing: '0.04em',
  lineHeight: '14px',
  textTransform: 'uppercase',
};

const inputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  minHeight: 44,
  paddingTop: 10,
  paddingRight: 12,
  paddingBottom: 10,
  paddingLeft: 12,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-divider-strong)',
  borderRadius: 10,
  background: 'var(--t-input-bg)',
  color: 'var(--t-text)',
  fontFamily: 'var(--font-sans-system)',
  fontSize: 13.5,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  lineHeight: 1.25,
};

const buttonStyle: CSSProperties = {
  minHeight: 44,
  paddingTop: 10,
  paddingRight: 14,
  paddingBottom: 10,
  paddingLeft: 14,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-accent-border)',
  borderRadius: 10,
  background: 'var(--t-accent-soft-strong)',
  color: 'var(--t-accent)',
  cursor: 'pointer',
  fontFamily: 'var(--font-sans-system)',
  fontSize: 12,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  lineHeight: 1.25,
};

const quietButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: 'var(--t-input-bg)',
  color: 'var(--t-text-secondary)',
};

function queryButtonLabel(kind: TruthQueryKind, busyKind: TruthQueryKind | null): string {
  if (busyKind === kind) return 'Querying…';
  if (kind === 'merged-since') return 'Find merges';
  if (kind === 'packet') return 'Find packet';
  return 'Find approvals';
}

function dispositionWhen(receipt: PacketReceipt): string {
  return receipt.disposition.kind === 'merged'
    ? receipt.disposition.releasedAt
    : receipt.disposition.closedAt;
}

function answerState(receipt: PacketReceipt): string {
  return receipt.approvals.at(-1)?.decision
    ?? receipt.reviews.at(-1)?.outcome
    ?? 'recorded';
}

function approvers(receipt: PacketReceipt): string {
  const names = [...new Set(receipt.approvals.map((approval) => approval.principal))];
  return names.length > 0 ? names.join(', ') : 'none recorded';
}

function downloadReceipt(answer: TruthAnswer): void {
  const blob = new Blob([answer.receiptRaw], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${encodeURIComponent(answer.receipt.receiptId)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function TruthPanel({ token }: TruthPanelProps) {
  const [mergedRepo, setMergedRepo] = useState('');
  const [mergedSince, setMergedSince] = useState('');
  const [packetTarget, setPacketTarget] = useState('');
  const [approvalPacket, setApprovalPacket] = useState('');
  const [busyKind, setBusyKind] = useState<TruthQueryKind | null>(null);
  const [result, setResult] = useState<TruthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openReceiptId, setOpenReceiptId] = useState<string | null>(null);

  const query = async (kind: TruthQueryKind, params: URLSearchParams) => {
    if (!token) {
      setResult(null);
      setError('Open this page with a spectator token before running a truth query.');
      return;
    }
    setBusyKind(kind);
    setError(null);
    setResult(null);
    setOpenReceiptId(null);
    params.set('kind', kind);
    try {
      const response = await fetch(`/api/orchestrator/truth?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => null) as TruthResponse | TruthErrorResponse | null;
      if (!response.ok) {
        const message = payload && 'error' in payload ? payload.error?.message : null;
        setError(message || `Truth query failed with ${response.status}.`);
        return;
      }
      if (!payload || !('answers' in payload)) {
        setError('The truth route returned an invalid response.');
        return;
      }
      setResult(payload);
    } catch {
      setError('The truth query could not reach o8.');
    } finally {
      setBusyKind(null);
    }
  };

  const submitMerged = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const sinceTimestamp = Date.parse(mergedSince);
    if (!mergedRepo.trim() || !Number.isFinite(sinceTimestamp)) {
      setResult(null);
      setError('Repository and a valid since time are required.');
      return;
    }
    void query('merged-since', new URLSearchParams({
      repo: mergedRepo.trim(),
      since: new Date(sinceTimestamp).toISOString(),
    }));
  };

  const submitPacket = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = packetTarget.trim();
    if (!target) {
      setResult(null);
      setError('Packet ID or #issue is required.');
      return;
    }
    const issue = target.match(/^#([1-9]\d*)$/);
    void query('packet', new URLSearchParams(issue
      ? { issueNumber: issue[1]! }
      : { packetId: target }));
  };

  const submitApprovals = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const packetId = approvalPacket.trim();
    if (!packetId) {
      setResult(null);
      setError('Packet ID is required for an approval query.');
      return;
    }
    void query('approvals', new URLSearchParams({ packetId }));
  };

  return (
    <section
      aria-label="Truth queries"
      style={{
        marginTop: 24,
        paddingTop: 20,
        paddingRight: 20,
        paddingBottom: 20,
        paddingLeft: 20,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'var(--t-divider-subtle)',
        borderRadius: 14,
        background: 'var(--t-panel)',
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            color: 'var(--t-text-faint)',
            fontSize: 10,
            fontWeight: 300,
            letterSpacing: '0.04em',
            lineHeight: '14px',
            textTransform: 'uppercase',
          }}
        >
          Truth
        </div>
        <h2
          style={{
            marginTop: 4,
            marginRight: 0,
            marginBottom: 0,
            marginLeft: 0,
            color: 'var(--t-text-strong)',
            fontSize: 18,
            fontWeight: 400,
            letterSpacing: '-0.2px',
            lineHeight: 1.25,
          }}
        >
          Ask the signed record
        </h2>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: 12,
        }}
      >
        <form aria-label="Merged since truth query" onSubmit={submitMerged} style={formStyle}>
          <label style={labelStyle}>
            Repository
            <input
              aria-label="Merged repository"
              value={mergedRepo}
              onChange={(event) => setMergedRepo(event.target.value)}
              placeholder="repo name or remote"
              style={inputStyle}
            />
          </label>
          <label style={labelStyle}>
            Since
            <input
              aria-label="Merged since"
              type="datetime-local"
              value={mergedSince}
              onChange={(event) => setMergedSince(event.target.value)}
              style={inputStyle}
            />
          </label>
          <button disabled={busyKind !== null} style={buttonStyle} type="submit">
            {queryButtonLabel('merged-since', busyKind)}
          </button>
        </form>

        <form aria-label="Packet truth query" onSubmit={submitPacket} style={formStyle}>
          <label style={labelStyle}>
            Packet or issue
            <input
              aria-label="Packet or issue"
              value={packetTarget}
              onChange={(event) => setPacketTarget(event.target.value)}
              placeholder="packet-id or #1998"
              style={inputStyle}
            />
          </label>
          <button disabled={busyKind !== null} style={buttonStyle} type="submit">
            {queryButtonLabel('packet', busyKind)}
          </button>
        </form>

        <form aria-label="Approvals truth query" onSubmit={submitApprovals} style={formStyle}>
          <label style={labelStyle}>
            Packet
            <input
              aria-label="Approval packet"
              value={approvalPacket}
              onChange={(event) => setApprovalPacket(event.target.value)}
              placeholder="packet-id"
              style={inputStyle}
            />
          </label>
          <button disabled={busyKind !== null} style={buttonStyle} type="submit">
            {queryButtonLabel('approvals', busyKind)}
          </button>
        </form>
      </div>

      {error ? (
        <div
          role="alert"
          style={{
            marginTop: 16,
            paddingTop: 12,
            paddingRight: 14,
            paddingBottom: 12,
            paddingLeft: 14,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--t-danger-border)',
            borderRadius: 10,
            background: 'var(--t-danger-soft)',
            color: 'var(--t-danger)',
            fontSize: 13,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            lineHeight: 1.45,
          }}
        >
          {error}
        </div>
      ) : null}

      {result ? (
        <div aria-live="polite" style={{ marginTop: 16 }}>
          {result.answers.length === 0 ? (
            <div style={{ color: 'var(--t-text-muted)', fontSize: 13, fontWeight: 300 }}>
              No signed receipts matched this query.
            </div>
          ) : result.answers.map((answer) => {
            const receipt = answer.receipt;
            const verifyOpen = openReceiptId === receipt.receiptId;
            const verifyCommand = `o8 verify ${encodeURIComponent(receipt.receiptId)}.json`;
            return (
              <article
                key={answer.artifactId}
                data-truth-answer={answer.artifactId}
                style={{
                  paddingTop: 14,
                  paddingRight: 14,
                  paddingBottom: 14,
                  paddingLeft: 14,
                  borderTop: '1px solid var(--t-divider-subtle)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    color: 'var(--t-text-faint)',
                    fontSize: 9.5,
                    fontWeight: 260,
                    letterSpacing: '-0.4px',
                    lineHeight: 1.25,
                  }}
                >
                  <span>{answerState(receipt)}</span>
                  <span>·</span>
                  <span>{receipt.repo.name}</span>
                  <span>·</span>
                  <span>{receipt.disposition.kind}</span>
                  <span>·</span>
                  <time dateTime={dispositionWhen(receipt)}>{dispositionWhen(receipt)}</time>
                  <span>·</span>
                  <span>{approvers(receipt)}</span>
                </div>
                <div
                  style={{
                    marginTop: 4,
                    color: 'var(--t-text)',
                    fontSize: 13.5,
                    fontWeight: 300,
                    letterSpacing: '-0.1px',
                    lineHeight: 1.45,
                  }}
                >
                  {answer.summary}
                </div>
                <button
                  aria-expanded={verifyOpen}
                  onClick={() => setOpenReceiptId(verifyOpen ? null : receipt.receiptId)}
                  style={{ ...quietButtonStyle, marginTop: 8 }}
                  type="button"
                >
                  Verify
                </button>
                {verifyOpen ? (
                  <div
                    style={{
                      marginTop: 8,
                      paddingTop: 12,
                      paddingRight: 12,
                      paddingBottom: 12,
                      paddingLeft: 12,
                      borderRadius: 10,
                      background: 'var(--t-input-bg)',
                    }}
                  >
                    <div style={{ color: 'var(--t-text-muted)', fontSize: 11, fontWeight: 300 }}>
                      Receipt {receipt.receiptId}
                    </div>
                    <code
                      style={{
                        display: 'block',
                        marginTop: 4,
                        overflowWrap: 'anywhere',
                        color: 'var(--t-text)',
                        fontFamily: mono,
                        fontSize: 11,
                        lineHeight: 1.45,
                      }}
                    >
                      {verifyCommand}
                    </code>
                    <button
                      onClick={() => downloadReceipt(answer)}
                      style={{ ...quietButtonStyle, marginTop: 8 }}
                      type="button"
                    >
                      Save receipt
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
