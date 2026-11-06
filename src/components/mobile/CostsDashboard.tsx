'use client';

import { memo, useMemo, type ReactNode } from 'react';
import { useTheme } from './ThemeContext';
import type { CostsDashboardProps } from './types';
import { PullToRefresh } from './PullToRefresh';
import { anthropicPricingForModel } from '@/lib/llm/pricing';

type ThemeColors = ReturnType<typeof useTheme>['colors'];

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function fmtCost(tokens: number, model: string): string {
  const rate = anthropicPricingForModel(model);
  if (!rate) return '';
  const cost = tokens * ((rate.input * 0.6 + rate.output * 0.4) / 1_000_000);
  return cost < 0.01 ? '<$0.01' : `~$${cost.toFixed(2)}`;
}

const MODEL_COLORS: Record<string, string> = {
  'claude-opus-4-6': '#ff453a',
  'claude-sonnet-4-20250514': '#ff9f0a',
  'claude-sonnet-4-5-20250929': '#ff9f0a',
  'claude-haiku-4-5-20251001': '#30d158',
  'gpt-5.3-codex': '#64d2ff',
  'gpt-5.4': '#64d2ff',
  'gpt-5.5': '#64d2ff',
  'gpt-5.6-sol': '#64d2ff',
  'gpt-5.6-terra': '#64d2ff',
  'gpt-5.6-luna': '#64d2ff',
  'grok-4.5': '#bf5af2',
};

function shortModel(model: string): string {
  return model
    .replace('claude-', '')
    .replace('openai-codex/', '')
    .replace(/-20\d{6,8}$/, '')
    .replace('opus-4-6', 'Opus 4.6')
    .replace('sonnet-4-5', 'Sonnet 4.5')
    .replace('sonnet-4', 'Sonnet 4')
    .replace('haiku-4-5', 'Haiku 4.5');
}

function sectionHeaderStyle(colors: ThemeColors) {
  return {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: colors.textSecondary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: 8,
    padding: '0 4px',
  };
}

function UsageRing({
  segments,
  size = 120,
  trackColor,
}: {
  segments: { percent: number; color: string; label: string }[];
  size?: number;
  trackColor: string;
}) {
  const r = (size - 16) / 2;
  const circ = 2 * Math.PI * r;
  const segmentElements = segments.reduce<Array<ReactNode>>((elements, seg, index) => {
    const previousLength = segments
      .slice(0, index)
      .reduce((sum, prior) => sum + (prior.percent / 100) * circ, 0);
    const len = (seg.percent / 100) * circ;
    elements.push(
      <circle
        key={seg.label}
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={seg.color}
        strokeWidth={10}
        strokeDasharray={`${len} ${circ - len}`}
        strokeDashoffset={-previousLength}
        strokeLinecap="round"
      />
    );
    return elements;
  }, []);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ transform: 'rotate(-90deg)' }}
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={trackColor} strokeWidth={10} />
      {segmentElements}
    </svg>
  );
}

export const CostsDashboard = memo(function CostsDashboard({
  snapshot,
  onBack,
  onSessionSelect,
  compactLine,
  onRefresh,
  hideHeader = false,
}: CostsDashboardProps) {
  const { colors } = useTheme();
  const ocSessions = useMemo(
    () => snapshot.sessions.filter((session) => session.tokenUsage),
    [snapshot.sessions]
  );
  const codexSessions = useMemo(
    () => snapshot.sessions.filter((session) => session.runtime === 'codex'),
    [snapshot.sessions]
  );
  const ccSessions = useMemo(
    () => snapshot.sessions.filter((session) => session.runtime === 'claude-code'),
    [snapshot.sessions]
  );

  const totalSessionCount = useMemo(
    () => new Set([...ocSessions, ...codexSessions, ...ccSessions].map((session) => session.id)).size,
    [ccSessions, codexSessions, ocSessions]
  );

  const totalTokens = ocSessions.reduce((sum, session) => sum + (session.tokenUsage?.totalTokens ?? 0), 0);
  const totalRemaining = ocSessions.reduce(
    (sum, session) => sum + (session.tokenUsage?.remainingTokens ?? 0),
    0
  );
  const hasCapacity = ocSessions.some((session) => (session.tokenUsage?.remainingTokens ?? 0) > 0);
  const totalCapacity = hasCapacity ? totalTokens + totalRemaining : 0;
  const usedPct = totalCapacity > 0 ? Math.round((totalTokens / totalCapacity) * 100) : 0;

  const byModel = useMemo(() => {
    const map = new Map<string, { sessions: typeof ocSessions; tokens: number; capacity: number }>();
    for (const session of ocSessions) {
      const model = session.model ?? 'unknown';
      const entry = map.get(model) ?? { sessions: [], tokens: 0, capacity: 0 };
      entry.sessions.push(session);
      entry.tokens += session.tokenUsage?.totalTokens ?? 0;
      entry.capacity +=
        (session.tokenUsage?.totalTokens ?? 0) + (session.tokenUsage?.remainingTokens ?? 0);
      map.set(model, entry);
    }
    return map;
  }, [ocSessions]);

  const ringSegments = Array.from(byModel.entries()).map(([model, data]) => ({
    percent: totalCapacity > 0 ? (data.tokens / totalCapacity) * 100 : 0,
    color: MODEL_COLORS[model] ?? '#64d2ff',
    label: model,
  }));

  const totalEstimate = Array.from(byModel.entries()).reduce((sum, [model, data]) => {
    const cost = fmtCost(data.tokens, model);
    const numeric = parseFloat(cost.replace(/[^0-9.]/g, ''));
    return sum + (Number.isNaN(numeric) ? 0 : numeric);
  }, 0);

  const cardStyle = {
    borderRadius: 14,
    background: colors.cardBg,
    border: `1px solid ${colors.cardBorder}`,
  };

  const content = (
    <div
      style={{
        padding: '0 14px 40px',
        display: 'flex',
        flexDirection: 'column',
        background: colors.bg,
        minHeight: '100%',
      }}
    >
      {hideHeader ? (
        <p
          style={{
            margin: '8px 0 16px',
            fontSize: 13,
            color: colors.textSecondary,
            fontWeight: 500,
          }}
        >
          {totalSessionCount} active session{totalSessionCount !== 1 ? 's' : ''}
        </p>
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: 8,
            marginBottom: 16,
            gap: 12,
          }}
        >
          <div>
            <h2
              style={{
                margin: 0,
                fontSize: 28,
                fontWeight: 800,
                color: colors.text,
                letterSpacing: '-0.03em',
              }}
            >
              Costs
            </h2>
            <p
              style={{
                margin: '4px 0 0',
                fontSize: 13,
                color: colors.textSecondary,
                fontWeight: 500,
              }}
            >
              {totalSessionCount} active session{totalSessionCount !== 1 ? 's' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onBack}
            style={{
              minHeight: 44,
              padding: '0 16px',
              borderRadius: 12,
              border: 'none',
              background: colors.blueAccent,
              color: colors.text,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Done
          </button>
        </div>
      )}

      <div
        style={{
          ...cardStyle,
          padding: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          marginBottom: 16,
        }}
      >
        <div style={{ position: 'relative', width: 120, height: 120, flexShrink: 0 }}>
          <UsageRing segments={ringSegments} trackColor={colors.border} />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: colors.text,
                letterSpacing: '-0.02em',
              }}
            >
              {usedPct}%
            </span>
            <span style={{ fontSize: 10, fontWeight: 600, color: colors.textSecondary }}>used</span>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 26,
              fontWeight: 800,
              color: colors.text,
              letterSpacing: '-0.02em',
            }}
          >
            {fmtTokens(totalTokens)}
          </div>
          <div style={{ fontSize: 12, color: colors.textSecondary, fontWeight: 500, marginTop: 2 }}>
            tokens used
          </div>
          {totalCapacity > 0 ? (
            <div style={{ fontSize: 11, color: colors.textTertiary, marginTop: 4 }}>
              of {fmtTokens(totalCapacity)} capacity
            </div>
          ) : null}
          {totalEstimate > 0 ? (
            <div
              style={{
                marginTop: 10,
                padding: '6px 10px',
                borderRadius: 999,
                background: colors.blueGlass,
                border: `1px solid ${colors.blueGlassBorder}`,
                display: 'inline-block',
                fontSize: 13,
                fontWeight: 700,
                color: colors.blueAccent,
              }}
            >
              ~${totalEstimate.toFixed(2)} estimated
            </div>
          ) : null}
        </div>
      </div>

      <span style={sectionHeaderStyle(colors)}>By Model</span>

      {Array.from(byModel.entries()).map(([model, data]) => {
        const pct = data.capacity > 0 ? Math.round((data.tokens / data.capacity) * 100) : 0;
        const color = MODEL_COLORS[model] ?? '#64d2ff';
        const cost = fmtCost(data.tokens, model);

        return (
          <div key={model} style={{ ...cardStyle, padding: '14px 16px', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: color,
                  boxShadow: `0 0 0 4px ${color}20`,
                }}
              />
              <span style={{ flex: 1, fontSize: 15, fontWeight: 700, color: colors.text }}>
                {shortModel(model)}
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, color }}>{pct}%</span>
            </div>

            <div
              style={{
                height: 6,
                borderRadius: 999,
                background: colors.border,
                overflow: 'hidden',
                marginBottom: 8,
              }}
            >
              <div
                style={{
                  height: '100%',
                  borderRadius: 999,
                  background: `linear-gradient(90deg, ${color}, ${color}cc)`,
                  width: `${pct}%`,
                }}
              />
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 8,
                fontSize: 11,
                color: colors.textSecondary,
                fontWeight: 500,
              }}
            >
              <span>{fmtTokens(data.tokens)} tokens</span>
              <span>
                {data.sessions.length} session{data.sessions.length !== 1 ? 's' : ''}
                {cost ? ` · ${cost}` : ''}
              </span>
            </div>

            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.sessions.map((session) => {
                const sPct = session.context?.usedPercent ?? 0;
                const tone =
                  sPct >= 85 ? '#ff453a' : sPct >= 70 ? '#ff9f0a' : sPct >= 50 ? '#ffd60a' : '#30d158';

                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => onSessionSelect(session.id)}
                    style={{
                      width: '100%',
                      minHeight: 44,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 12px',
                      borderRadius: 12,
                      background: colors.blueSoft,
                      border: `1px solid ${colors.border}`,
                      cursor: 'pointer',
                      WebkitTapHighlightColor: 'transparent',
                      textAlign: 'left',
                    }}
                  >
                    <svg width="24" height="24" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
                      <circle cx="12" cy="12" r="9" fill="none" stroke={colors.border} strokeWidth="3" />
                      <circle
                        cx="12"
                        cy="12"
                        r="9"
                        fill="none"
                        stroke={tone}
                        strokeWidth="3"
                        strokeDasharray={`${(sPct / 100) * 56.55} ${56.55}`}
                        strokeLinecap="round"
                        style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
                      />
                    </svg>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: colors.text,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          display: 'block',
                        }}
                      >
                        {session.isCurrentSession ? 'This chat' : compactLine(session.name, 'Session', 28)}
                      </span>
                    </div>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: colors.textSecondary,
                        flexShrink: 0,
                        fontFamily: '"SF Mono", ui-monospace, monospace',
                      }}
                    >
                      {fmtTokens(session.tokenUsage?.totalTokens ?? 0)}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: tone,
                        flexShrink: 0,
                        minWidth: 32,
                        textAlign: 'right',
                      }}
                    >
                      {sPct}%
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {codexSessions.length > 0 ? (
        <div style={{ ...cardStyle, padding: '14px 16px', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: '#64d2ff',
                boxShadow: '0 0 0 4px rgba(100,210,255,0.12)',
              }}
            />
            <span style={{ fontSize: 15, fontWeight: 700, color: colors.text }}>Codex</span>
            <span style={{ fontSize: 13, color: colors.textSecondary, marginLeft: 'auto' }}>
              {codexSessions.length} session{codexSessions.length !== 1 ? 's' : ''}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 12, color: colors.textSecondary, lineHeight: 1.4 }}>
            Billed through ChatGPT Pro. Token-level usage is not available.
          </p>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {codexSessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => onSessionSelect(session.id)}
                style={{
                  width: '100%',
                  minHeight: 44,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 12px',
                  borderRadius: 12,
                  background: colors.blueSoft,
                  border: `1px solid ${colors.border}`,
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                  textAlign: 'left',
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: session.status === 'running' ? '#30d158' : colors.textTertiary,
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    fontSize: 13,
                    fontWeight: 600,
                    color: colors.text,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {compactLine(session.name, 'Session', 28)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {ccSessions.length > 0 ? (
        <div style={{ ...cardStyle, padding: '14px 16px', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: '#bf5af2',
                boxShadow: '0 0 0 4px rgba(191,90,242,0.12)',
              }}
            />
            <span style={{ fontSize: 15, fontWeight: 700, color: colors.text }}>Claude Code</span>
            <span style={{ fontSize: 13, color: colors.textSecondary, marginLeft: 'auto' }}>
              {ccSessions.length} session{ccSessions.length !== 1 ? 's' : ''}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 12, color: colors.textSecondary, lineHeight: 1.4 }}>
            Billed through Anthropic Max. Token-level usage is not available.
          </p>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {ccSessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => onSessionSelect(session.id)}
                style={{
                  width: '100%',
                  minHeight: 44,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 12px',
                  borderRadius: 12,
                  background: colors.blueSoft,
                  border: `1px solid ${colors.border}`,
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                  textAlign: 'left',
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: session.status === 'running' ? '#30d158' : colors.textTertiary,
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    fontSize: 13,
                    fontWeight: 600,
                    color: colors.text,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {compactLine(session.name, 'Session', 28)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {ocSessions.length === 0 && codexSessions.length === 0 && ccSessions.length === 0 ? (
        <div style={{ ...cardStyle, padding: '36px 20px', textAlign: 'center' }}>
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke={colors.blueAccent}
            strokeOpacity="0.45"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ margin: '0 auto 12px' }}
          >
            <line x1="12" y1="1" x2="12" y2="23" />
            <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
          </svg>
          <p style={{ fontSize: 15, fontWeight: 600, color: colors.text, margin: 0 }}>
            No usage data yet
          </p>
          <p style={{ fontSize: 12, color: colors.textSecondary, margin: '6px 0 0' }}>
            Token costs will appear here as agents work.
          </p>
        </div>
      ) : null}
    </div>
  );

  if (!onRefresh) return content;
  return <PullToRefresh onRefresh={onRefresh}>{content}</PullToRefresh>;
});
