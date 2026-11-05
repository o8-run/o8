'use client';

/**
 * Mission card (#5468) in the classic transcript. The same card the native
 * transcript draws: typed actions decided inline, `hold` actions need a held
 * press, and a decided or expired card dissolves into a one-line receipt
 * rebuilt from server state. The decision goes to the card decision route;
 * a thread card rides the operator's own turn exactly like any task artifact.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { mintBridgeToken } from '@/lib/task-artifacts/bridge-protocol';
import {
  MISSION_CARD_HOLD_MS,
  type MissionCardAction,
  type MissionCardView,
  type TaskArtifactTarget,
} from '@/lib/task-artifacts/types';
import type { TaskArtifactDeliverInput } from './TaskArtifactCard';

const UI_FONT = 'var(--font-sans-system)';

export interface MissionCardProps {
  card: MissionCardView;
  target: TaskArtifactTarget;
  threadBusy: boolean;
  onDeliverToThread: (input: TaskArtifactDeliverInput) => boolean;
  /** Reload the card from the server after a decision lands. */
  onDecided: () => void;
}

interface DecisionReply {
  ok?: boolean;
  error?: { message?: string };
  result?: {
    accepted: boolean;
    reason?: string;
    deliverVia?: 'packet' | 'thread' | 'queue';
    wireMessage?: string;
    displayMessage?: string;
    action?: { id: string } | null;
    card?: MissionCardView | null;
  };
}

function actionColors(style: MissionCardAction['style']): { border: string; background: string; color: string } {
  if (style === 'primary') return { border: 'var(--t-accent-border)', background: 'var(--t-accent-soft)', color: 'var(--t-text)' };
  if (style === 'danger') return { border: 'var(--t-danger-border, var(--t-border))', background: 'transparent', color: 'var(--t-danger, var(--t-text))' };
  return { border: 'var(--t-border)', background: 'transparent', color: 'var(--t-text)' };
}

export function MissionCard({ card: initial, target, threadBusy, onDeliverToThread, onDecided }: MissionCardProps) {
  const [card, setCard] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [holding, setHolding] = useState<string | null>(null);
  const holdTimer = useRef<number | null>(null);

  useEffect(() => { setCard(initial); }, [initial]);
  useEffect(() => () => { if (holdTimer.current !== null) window.clearTimeout(holdTimer.current); }, []);

  const decide = useCallback(async (action: MissionCardAction) => {
    if (sending || card.state !== 'open') return;
    if (target.kind === 'thread' && threadBusy) {
      setError('The thread is busy. Decide when the current turn finishes.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/api/task-artifacts/${encodeURIComponent(card.id)}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actionId: action.id, entityIds: card.entityIds, nonce: mintBridgeToken().slice(0, 32) }),
      });
      const body = await response.json().catch(() => null) as DecisionReply | null;
      const result = body?.result;
      if (result?.card) setCard(result.card);
      if (!result?.accepted) {
        setError(result?.reason ?? body?.error?.message ?? `Decision failed (${response.status}).`);
        return;
      }
      if (result.deliverVia === 'thread' && result.action && result.wireMessage && result.displayMessage) {
        const sent = onDeliverToThread({ artifactId: card.id, actionId: result.action.id, wireMessage: result.wireMessage, displayMessage: result.displayMessage });
        if (!sent) setError('Decision recorded, but the thread could not take the turn yet.');
      }
      onDecided();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }, [card, onDecided, onDeliverToThread, sending, target.kind, threadBusy]);

  const cancelHold = useCallback(() => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    setHolding(null);
  }, []);

  const startHold = useCallback((action: MissionCardAction) => {
    cancelHold();
    setHolding(action.id);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      setHolding(null);
      void decide(action);
    }, MISSION_CARD_HOLD_MS);
  }, [cancelHold, decide]);

  if (card.state !== 'open') {
    return (
      <div
        data-testid="mission-card-receipt"
        data-card-id={card.id}
        data-card-state={card.state}
        style={{ fontFamily: UI_FONT, fontSize: 12, color: 'var(--t-text-muted)', padding: '4px 2px', margin: '6px 0' }}
      >
        {card.summary ?? card.title}
      </div>
    );
  }

  return (
    <section
      data-testid="mission-card"
      data-card-id={card.id}
      data-card-kind={card.kind}
      style={{
        fontFamily: UI_FONT, margin: '8px 0', padding: '10px 12px', borderRadius: 10,
        border: '1px solid var(--t-chat-surface-border, var(--t-border))',
        background: 'var(--t-chat-surface-card-bg, var(--t-bg-card))', color: 'var(--t-text)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 500 }}>{card.title}</div>
      {card.body ? <div style={{ fontSize: 12.5, color: 'var(--t-text-muted)', marginTop: 4, whiteSpace: 'pre-wrap' }}>{card.body}</div> : null}
      {card.entityIds.length ? (
        <div style={{ fontSize: 11.5, color: 'var(--t-text-muted)', marginTop: 6 }}>{card.entityIds.join(' · ')}</div>
      ) : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        {card.actions.map((action) => {
          const colors = actionColors(action.style);
          const hold = action.confirm === 'hold';
          return (
            <button
              key={action.id}
              type="button"
              data-testid={`mission-card-action-${action.id}`}
              disabled={sending}
              aria-label={hold ? `${action.label} (hold to confirm)` : action.label}
              onClick={hold ? undefined : () => void decide(action)}
              onPointerDown={hold ? () => startHold(action) : undefined}
              onPointerUp={hold ? cancelHold : undefined}
              onPointerLeave={hold ? cancelHold : undefined}
              onKeyDown={hold ? (event) => { if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) startHold(action); } : undefined}
              onKeyUp={hold ? cancelHold : undefined}
              style={{
                height: 26, padding: '0 10px', borderRadius: 6, fontFamily: UI_FONT, fontSize: 12,
                border: `1px solid ${colors.border}`, background: holding === action.id ? 'var(--t-accent-soft)' : colors.background,
                color: colors.color, cursor: sending ? 'default' : 'pointer',
              }}
            >
              {holding === action.id ? `Hold to ${action.label.toLowerCase()}…` : hold ? `Hold to ${action.label.toLowerCase()}` : action.label}
            </button>
          );
        })}
      </div>
      {error ? <div role="alert" style={{ fontSize: 11.5, color: 'var(--t-warning-contrast, var(--t-text-muted))', marginTop: 6 }}>{error}</div> : null}
    </section>
  );
}
