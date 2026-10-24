'use client';

import React, { memo } from 'react';
import { PrCheckRepair } from '../pr-panel/PrCheckRepair';
import { checkBucket } from '@/components/desktop/pr-panel/check-status';
import { openExternalUrl } from '@/lib/desktop/open-external';
import {
  Check,
  ExternalLink,
  MessageSquare,
} from '../lucide-shims';
import {
  formatCiCheckInjection,
  formatCiCheckBatchInjection,
  type AgentPanelChatInjectionPayload,
} from '@/lib/chat/injection';
import type { PRDetail } from './types';
import { DesktopGlassActionChip } from './shared';

interface PRChecksSectionProps {
  readOnly?: boolean;
  pr: PRDetail;
  activeItemIndex: number;
  addedContextKeys: Record<string, true>;
  checkContextKey: (name?: string | null) => string;
  injectPayload: (key: string, payload: AgentPanelChatInjectionPayload) => void;
  onInjectChatContext?: (payload: AgentPanelChatInjectionPayload) => void;
  repo?: string;
}

function PRChecksSectionBase({
  pr,
  readOnly = false,
  activeItemIndex,
  addedContextKeys,
  checkContextKey,
  injectPayload,
  onInjectChatContext,
  repo,
}: PRChecksSectionProps) {
  const ciChecks = pr.statusCheckRollup ?? [];
  const failedChecks = ciChecks.filter((check) => checkBucket(check) === 'failing');

  if (ciChecks.length === 0) {
    return (
      <div>
        <div style={{ padding: 20, fontSize: 13, color: 'var(--t-text-muted)' }}>No checks configured</div>
      </div>
    );
  }

  return (
    <div>
      {!readOnly && repo ? <PrCheckRepair key={`${repo}:${pr.number}`} repo={repo} number={pr.number} failed={failedChecks.length > 0} /> : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {failedChecks.length > 0 && onInjectChatContext ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <DesktopGlassActionChip
              icon={<MessageSquare size={12} strokeWidth={2} />}
              label={addedContextKeys[`checks-all:${pr.number}`] ? 'Added to chat' : 'Add all failed checks'}
              onClick={() => injectPayload(
                `checks-all:${pr.number}`,
                formatCiCheckBatchInjection(
                  pr.number,
                  repo,
                  failedChecks.map((check) => ({
                    prNumber: pr.number,
                    repo,
                    name: check.name,
                    status: check.status,
                    conclusion: check.conclusion,
                    detailsUrl: check.detailsUrl,
                    startedAt: check.startedAt,
                    completedAt: check.completedAt,
                  })),
                ),
              )}
              disabled={Boolean(addedContextKeys[`checks-all:${pr.number}`])}
            />
          </div>
        ) : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {ciChecks.map((check, i) => {
            const bucket = checkBucket(check);
            const passed = bucket === 'passed';
            const pending = bucket === 'running';
            const failed = bucket === 'failing';
            const statusLabel = passed ? 'passed' : pending ? 'pending' : failed ? 'failed' : bucket;
            const rowBackground = activeItemIndex === i ? 'rgba(37,99,235,0.08)' : 'transparent';
            let duration = '';
            if (check.startedAt && check.completedAt) {
              const ms = new Date(check.completedAt).getTime() - new Date(check.startedAt).getTime();
              if (ms < 60_000) duration = `${Math.round(ms / 1000)}s`;
              else duration = `${Math.round(ms / 60_000)}m`;
            }
            return (
              <div key={i} data-pr-section="checks" data-pr-index={i} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 12px',
                borderRadius: 8,
                transition: 'background 120ms cubic-bezier(0.22, 1, 0.36, 1)',
                cursor: check.detailsUrl ? 'pointer' : 'default',
                background: rowBackground,
                border: activeItemIndex === i ? '1px solid rgba(37,99,235,0.16)' : '1px solid transparent',
              }}
              onClick={() => check.detailsUrl && openExternalUrl(check.detailsUrl)}
              onMouseEnter={(e) => {
                if (activeItemIndex !== i) {
                  (e.currentTarget as HTMLDivElement).style.background = 'rgba(0,0,0,0.02)';
                }
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = rowBackground;
              }}
              >
                {/* Status icon */}
                <span role="img" aria-label={`Check ${statusLabel}`} style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 20, height: 20,
                  borderRadius: '50%',
                  background: passed ? 'rgba(34,197,94,0.08)' : pending ? 'rgba(245,158,11,0.08)' : failed ? 'rgba(239,68,68,0.08)' : 'var(--t-hover)',
                  color: passed ? '#22c55e' : pending ? '#f59e0b' : failed ? '#ef4444' : 'var(--t-text-muted)',
                  fontSize: 12, fontWeight: 700,
                  flexShrink: 0,
                  }}>
                    {passed ? '\u2713' : pending ? '\u25CB' : failed ? '\u2717' : '\u2014'}
                  </span>
                {/* Check name */}
                <span style={{
                  flex: 1,
                  fontSize: 13,
                  fontWeight: 500,
                  color: 'var(--t-text-strong)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {check.name}
                </span>
                {/* Duration */}
                {duration ? (
                  <span style={{
                    fontSize: 11,
                    color: 'var(--t-text-muted)',
                    fontFamily: '"SF Mono", ui-monospace, monospace',
                    flexShrink: 0,
                  }}>
                    {duration}
                  </span>
                ) : null}
                {/* External link */}
                {check.detailsUrl ? (
                  <ExternalLink size={12} strokeWidth={1.5} color="var(--t-text-faint)" style={{ flexShrink: 0 }} />
                ) : null}
                {!passed && onInjectChatContext ? (
                  <DesktopGlassActionChip
                    icon={addedContextKeys[checkContextKey(check.name)] ? <Check size={12} strokeWidth={2.4} /> : <MessageSquare size={12} strokeWidth={2} />}
                    label={addedContextKeys[checkContextKey(check.name)] ? 'Added' : 'Add to chat'}
                    onClick={() => injectPayload(
                      checkContextKey(check.name),
                      formatCiCheckInjection({
                        prNumber: pr.number,
                        repo,
                        name: check.name,
                        status: check.status,
                        conclusion: check.conclusion,
                        detailsUrl: check.detailsUrl,
                        startedAt: check.startedAt,
                        completedAt: check.completedAt,
                      }),
                    )}
                    disabled={Boolean(addedContextKeys[checkContextKey(check.name)])}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export const PRChecksSection = memo(PRChecksSectionBase);
