'use client';

/**
 * TurnSummaryCard — rolled-up digest of a completed orchestrator turn.
 *
 * Renders as a SLIM TEXT LINE at the TOP of the turn (operator ruling
 * 2026-07-13, Cursor parity): "Worked for Ns ⌄" in muted text, no box —
 * anchored above the turn's first assistant message, right under the operator
 * prompt. The chevron expands an inline detail block: tools · files · tokens
 * stats plus the ChatActionCard ("Edited N files" with Review/Undo) when the
 * turn touched files.
 *
 * Fires on `busy → ready` transitions in the orchestrator stream.
 * Issue: #1096 (turn-summary cards). Pairs with #1095.
 */

import { useState } from 'react';
import { formatModelLabel } from '@/lib/format';
import type { MobileTranscriptEntry, MobileTurnReceipt } from '@/lib/mobile/types';
import { getRuntimeCapability, isOrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { THINKING_EFFORT_LABELS } from '@/lib/orchestrator/thinking-effort';
import { composerSelectorModeSpec } from '../composer-selector/state';
import { ChatActionCard } from './ChatActionCard';

export type TurnSummary = {
  /** Anchor — the LAST assistant message id of the turn (legacy anchor,
   *  still used as a fallback when the first-message anchor is missing). */
  assistantMessageId: string;
  /** Anchor — the FIRST assistant message id of the turn. The slim line
   *  renders directly above this message (Cursor position). */
  firstAssistantMessageId?: string | null;
  /** Elapsed turn time in ms. */
  elapsedMs: number;
  /** Total tool invocations in the turn. */
  toolCount: number;
  /** First 2–3 distinct tool names; the rest collapse into "+N". */
  toolNames: string[];
  /** Distinct tool name count for the +N tail. */
  toolNameTotal: number;
  /** Files attributed to successful edit-tool receipts during the turn. */
  filesEditedCount: number;
  /** File paths so the inner ChatActionCard can Undo + Review. */
  filePaths: string[];
  /** Token running-total delta during the turn. */
  tokensUsed: number;
  /** Prompt-cache truth from the completed harness turn, when reported. */
  freshInputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Billable parent + child work attributed to this turn. */
  costUsd?: number | null;
  /** Internal receipt pieces used while an attached mission is still settling. */
  orchestratorCostUsd?: number | null;
  childCostUsd?: number | null;
  childCostAtStartUsd?: number | null;
  missionId?: string | null;
  missionIdAtStart?: string | null;
  missionFunnel?: {
    totalDurationMs: number | null;
    terminalPacketCount: number;
    packetCount: number;
    attemptCount: number;
    retryCount: number;
    interventionCount: number;
    recoveryEventCount: number;
    strictAutonomousCloseCount: number;
    governedAutonomousCloseCount: number;
  } | null;
  /** Repo root for the inner ChatActionCard. */
  repoPath: string | null;
};

type Props = {
  summary?: TurnSummary;
  persistedEntry?: Pick<MobileTranscriptEntry, 'receipt'>;
};

function formatElapsed(ms: number): string {
  if (ms < 1000) return '<1s';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

function formatTokens(value: number): string {
  if (value <= 0) return '0';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatCost(value: number): string {
  if (value <= 0) return '$0.00';
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function TurnReceiptLine({ receipt }: { receipt: MobileTurnReceipt }) {
  const mode = composerSelectorModeSpec(receipt.mode).long;
  const pickedMode = receipt.pickedMode && receipt.pickedMode !== receipt.mode
    ? composerSelectorModeSpec(receipt.pickedMode).long
    : null;
  const workers = (receipt.workers ?? []).filter((worker) => isOrchestratorRuntime(worker.runtime));

  return (
    <div
      aria-label="Turn receipt"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        minWidth: 0,
        fontFamily: 'SF Mono, Menlo, Monaco, monospace',
        fontSize: 10.5,
        lineHeight: 1.45,
        color: 'var(--t-text-muted)',
      }}
    >
      <div>
        {formatModelLabel(receipt.leadModel)}
        {receipt.effortSource === 'runtime-default' ? ' · runtime default'
          : receipt.effortSource === 'service-tier' ? ` · ${THINKING_EFFORT_LABELS[receipt.effort].short} service tier`
          : receipt.leadModel === 'o8-free' ? null : ` · ${THINKING_EFFORT_LABELS[receipt.effort].short}`} · {pickedMode
          ? `ran as ${mode}, picked ${pickedMode}`
          : mode}
        {receipt.serviceTier ? ` · ${receipt.serviceTier} service tier` : null}
        {receipt.permissionMode === 'outside-workspace' ? ' · Outside workspace' : null}
      </div>
      {workers.map((worker) => (
        <div key={worker.packetId}>
          {getRuntimeCapability(worker.runtime).label} · {formatModelLabel(worker.model)}
        </div>
      ))}
    </div>
  );
}

export function buildTurnSummaryStats(summary: TurnSummary): { key: string; value: string }[] {
  const cacheDenominator = (summary.freshInputTokens ?? 0)
    + (summary.cacheReadTokens ?? 0)
    + (summary.cacheWriteTokens ?? 0);
  const cacheStat = summary.cacheReadTokens !== undefined && cacheDenominator > 0
    ? (summary.cacheReadTokens > 0
        ? `${((summary.cacheReadTokens / cacheDenominator) * 100).toFixed(1)}% prompt cached`
        : 'cold prompt')
    : null;
  return [
    { key: 'tools', value: summary.toolCount === 0 ? '0 tools' : `${summary.toolCount} ${summary.toolCount === 1 ? 'tool' : 'tools'}` },
    { key: 'files', value: summary.filesEditedCount === 0 ? '0 files' : `${summary.filesEditedCount} ${summary.filesEditedCount === 1 ? 'file' : 'files'}` },
    { key: 'tokens', value: `${formatTokens(summary.tokensUsed)} tokens` },
    ...(cacheStat ? [{ key: 'cache', value: cacheStat }] : []),
    ...(typeof summary.costUsd === 'number'
      ? [{ key: 'cost', value: `${formatCost(summary.costUsd)} cost` }]
      : []),
    ...(summary.missionFunnel ? [
      {
        key: 'mission',
        value: summary.missionFunnel.totalDurationMs == null
          ? 'mission in progress'
          : `${formatElapsed(summary.missionFunnel.totalDurationMs)} mission`,
      },
      { key: 'attempts', value: `${summary.missionFunnel.attemptCount} attempts · ${summary.missionFunnel.retryCount} ${summary.missionFunnel.retryCount === 1 ? 'retry' : 'retries'}` },
      { key: 'control', value: `${summary.missionFunnel.interventionCount} interventions · ${summary.missionFunnel.recoveryEventCount} recoveries` },
      { key: 'terminal', value: `${summary.missionFunnel.terminalPacketCount}/${summary.missionFunnel.packetCount} terminal` },
      { key: 'autonomy', value: `${summary.missionFunnel.strictAutonomousCloseCount} strict · ${summary.missionFunnel.governedAutonomousCloseCount} approval-only` },
    ] : []),
  ];
}

export function TurnSummaryCard({ summary, persistedEntry }: Props) {
  const [expanded, setExpanded] = useState(false);
  const receipt = persistedEntry?.receipt;
  if (!summary) return receipt ? <TurnReceiptLine receipt={receipt} /> : null;
  const elapsed = formatElapsed(summary.elapsedMs);
  const toolPreview = summary.toolNames.slice(0, 3).join(', ');
  const toolOverflow = Math.max(0, summary.toolNameTotal - summary.toolNames.slice(0, 3).length);
  const stats = buildTurnSummaryStats(summary);

  return (
    <div
      role="group"
      aria-label="Turn summary"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: expanded ? 6 : 0,
        minWidth: 0,
        maxWidth: '100%',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={expanded ? 'Hide turn details' : 'Show turn details'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          border: 'none',
          background: 'transparent',
          padding: 0,
          textAlign: 'left',
          cursor: 'pointer',
          color: 'var(--t-text-muted)',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span
          style={{
            flexShrink: 0,
            fontFamily: 'var(--font-sans-system)',
            fontSize: 12,
            fontWeight: 400,
            letterSpacing: '-0.005em',
            color: 'var(--t-text-muted)',
          }}
        >
          Worked for {elapsed}
          {typeof summary.costUsd === 'number' ? ` · ${formatCost(summary.costUsd)}` : ''}
        </span>
        <Chevron open={expanded} />
      </button>

      {expanded ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              fontFamily: 'SF Mono, Menlo, Monaco, monospace',
              fontSize: 10.5,
              color: 'var(--t-text-muted)',
              letterSpacing: '0.2px',
            }}
          >
            {stats.map((stat, idx) => (
              <span key={stat.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {idx > 0 ? <span aria-hidden="true" style={{ opacity: 0.4 }}>·</span> : null}
                <span>{stat.value}</span>
              </span>
            ))}
            {toolPreview ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span aria-hidden="true" style={{ opacity: 0.4 }}>·</span>
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: 'var(--t-text-faint)',
                  }}
                >
                  {toolPreview}
                  {toolOverflow > 0 ? ` +${toolOverflow}` : ''}
                </span>
              </span>
            ) : null}
          </div>

          {receipt ? <TurnReceiptLine receipt={receipt} /> : null}

          {summary.filesEditedCount > 0 ? (
            <div
              style={{
                borderRadius: 10,
                borderWidth: 1,
                borderStyle: 'solid',
                borderColor: 'var(--t-divider)',
                background: 'var(--t-input-bg)',
                overflow: 'hidden',
              }}
            >
              <ChatActionCard
                filesEditedCount={summary.filesEditedCount}
                repoPath={summary.repoPath}
                filePaths={summary.filePaths}
                firstFilePath={summary.filePaths[0] ?? null}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        display: 'block',
        flexShrink: 0,
        color: 'var(--t-text-faint)',
        transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 140ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
