'use client';

/** Task concurrency, supervision, reports, and advanced task behavior. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  APP_FONT_STACK,
  type SettingsTab,
  SettingsSegmented,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
} from './shared';
import { SettingsGroup, SettingsRow } from './grouped';
import { fetchOperatorDefaults } from './operator-defaults-client';
import { ApfsDependencyImagesRow } from './ApfsDependencyImagesRow';
import { DispatchTaskSettings } from './DispatchTaskSettings';
import { SettingsAdvanced } from './SettingsAdvanced';
import { SettingsTomlEditor } from './SettingsTomlEditor';
import {
  ENV_LOCKED_REASON,
  REQUIRE_APPROVAL_OPTIONS,
  MERGE_APPROVAL_DESCRIPTIONS,
  type UpdateAutoApply,
  type OperatorDefaults,
  type OperatorDefaultsResponse,
  type RequireApproval,
  type OverlapGateMode,
} from './dispatch-shared';

const PARALLEL_CAP_PRESETS: Array<{ key: string; label: string; value: number }> = [
  { key: 'conservative', label: '2', value: 2 },
  { key: 'balanced', label: '5', value: 5 },
  { key: 'power-user', label: '8', value: 8 },
];

// ── Minimal raw-SVG glyphs for row icon tiles ──

function LanesIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <line x1="4" y1="4" x2="4" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="20" y1="4" x2="20" y2="20" />
    </svg>
  );
}

function MergeIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </svg>
  );
}

function BuyinDocIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M3 11l18-5v12L3 14v-3z" />
      <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
    </svg>
  );
}

function UpdateIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M21 12a9 9 0 1 1-9-9" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}

function CpuIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" />
      <line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" />
      <line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" />
      <line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" />
      <line x1="1" y1="14" x2="4" y2="14" />
    </svg>
  );
}


export function OperatorDefaultsTab({ onNavigateTab }: { onNavigateTab?: (tab: SettingsTab) => void }) {
  const [data, setData] = useState<OperatorDefaultsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingToml, setEditingToml] = useState(false);
  const [busyField, setBusyField] = useState<keyof OperatorDefaults | null>(null);
  const loadSequenceRef = useRef(0);
  const mutationSequenceRef = useRef(0);

  const loadDefaults = useCallback(async () => {
    const sequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = sequence;
    try {
      const response = await fetchOperatorDefaults({}, { fresh: true });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to load operator defaults.');
      }
      if (loadSequenceRef.current !== sequence) return;
      const next = payload as OperatorDefaultsResponse;
      setData(next);
      setNotice(next.nextWindowError ?? next.settingsToml?.error ?? null);
    } catch (error) {
      if (loadSequenceRef.current !== sequence) return;
      setNotice(error instanceof Error ? error.message : 'Failed to load operator defaults.');
    } finally {
      if (loadSequenceRef.current === sequence) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDefaults();
  }, [loadDefaults]);

  useEffect(() => {
    if (editingToml) return;
    const refreshOnFocus = () => { void loadDefaults(); };
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [editingToml, loadDefaults]);

  const updateFieldAsync = useCallback(async <K extends keyof OperatorDefaults>(field: K, value: OperatorDefaults[K]) => {
    const sequence = mutationSequenceRef.current + 1;
    mutationSequenceRef.current = sequence;
    setBusyField(field);
    setNotice(null);
    try {
      const response = await fetchOperatorDefaults({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to update setting.');
      }
      if (mutationSequenceRef.current === sequence) setData(payload as OperatorDefaultsResponse);
    } catch (error) {
      if (mutationSequenceRef.current === sequence) {
        setNotice(error instanceof Error ? error.message : 'Failed to update setting.');
      }
    } finally {
      if (mutationSequenceRef.current === sequence) setBusyField(null);
    }
  }, []);

  const updateField = useCallback(<K extends keyof OperatorDefaults>(field: K, value: OperatorDefaults[K]) => {
    void updateFieldAsync(field, value);
  }, [updateFieldAsync]);

  const handleTomlSaved = useCallback((payload: OperatorDefaultsResponse) => {
    setData(payload);
    setNotice(payload.settingsToml?.error ?? null);
    setEditingToml(false);
  }, []);

  const openTomlEditor = useCallback(async () => {
    await loadDefaults();
    setEditingToml(true);
  }, [loadDefaults]);

  const values = data?.values;
  const sources = data?.sources;

  const activePresetKey = useMemo(() => {
    if (!values) return '';
    const match = PARALLEL_CAP_PRESETS.find((preset) => preset.value === values.parallelCap);
    return match?.key ?? '';
  }, [values]);

  if (loading && !data) {
    return (
      <div style={{
        paddingTop: 40,
        color: 'var(--t-text-muted)',
        fontSize: 13,
        fontFamily: APP_FONT_STACK,
      }}>
        Loading dispatch settings...
      </div>
    );
  }

  if (!values || !sources) {
    return (
      <div style={{
        paddingTop: 40,
        color: 'var(--t-brand-red, #b91c1c)',
        fontSize: 13,
        fontFamily: APP_FONT_STACK,
      }}>
        {notice ?? 'Unable to load operator defaults.'}
      </div>
    );
  }

  if (editingToml && data.settingsToml) {
    return (
      <SettingsTomlEditor
        initialText={data.settingsToml.text}
        initialRevision={data.settingsToml.revision}
        filePath={data.settingsToml.path}
        initialError={data.settingsToml.error}
        onCancel={() => setEditingToml(false)}
        onReload={loadDefaults}
        onSaved={handleTomlSaved}
      />
    );
  }

  const envLocked = (field: keyof OperatorDefaults) => sources[field] === 'env';
  const lockedSub = (field: keyof OperatorDefaults, normal: string) =>
    envLocked(field) ? ENV_LOCKED_REASON : normal;

  return (
    <div style={{
      paddingTop: 8,
      paddingLeft: 8,
      paddingRight: 8,
      paddingBottom: 40,
      maxWidth: SETTINGS_CONTENT_MAX_WIDTH,
      fontFamily: APP_FONT_STACK,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20 }}>
        <TabHeading
          title="dispatch & supervision"
          subtitle="Control how many tasks run, how failures are handled, and when changes need review."
        />
        <button
          type="button"
          onClick={() => { void openTomlEditor(); }}
          style={{
            flexShrink: 0,
            height: 32,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxSizing: 'border-box',
            lineHeight: 1,
            paddingTop: 0,
            paddingBottom: 0,
            marginTop: 2,
            paddingLeft: 13,
            paddingRight: 13,
            border: '1px solid var(--t-panel-border)',
            borderRadius: 7,
            background: 'var(--t-input-bg)',
            color: 'var(--t-text-muted)',
            fontFamily: APP_FONT_STACK,
            fontSize: 11,
            fontWeight: 300,
            letterSpacing: '-0.1px',
            cursor: 'pointer',
          }}
        >
          Edit in settings.toml
        </button>
      </div>

      {notice ? (
        <div style={{
          marginBottom: 28,
          paddingTop: 2,
          paddingBottom: 2,
          fontSize: 13,
          color: 'var(--t-text)',
          lineHeight: 1.55,
        }}>
          <span style={{
            fontFamily: APP_FONT_STACK,
            fontSize: 11,
            fontWeight: 400,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: '#ef4444',
            marginRight: 8,
          }}>
            [error]
          </span>
          {notice}
        </div>
      ) : null}

      <section>
        <SettingsGroup
          header="Fleet"
          footnote="Strict waits while another active task may edit the same files. Advisory allows both tasks to run and resolves conflicts later. New setups use 5 agents and Strict; saved choices are kept."
        >
          <SettingsRow
            icon={<LanesIcon />}
            label="Concurrent agents"
            subtitle={lockedSub('parallelCap', `Up to ${values.parallelCap} agent tasks run at once`)}
            accessory={
              <SettingsSegmented
                value={activePresetKey}
                onChange={(key) => {
                  const preset = PARALLEL_CAP_PRESETS.find((p) => p.key === key);
                  if (preset) updateField('parallelCap', preset.value);
                }}
                options={PARALLEL_CAP_PRESETS.map((p) => ({ value: p.key, label: p.label }))}
              />
            }
            disabled={envLocked('parallelCap') || busyField === 'parallelCap'}
            divider
          />
          <SettingsRow
            icon={<MergeIcon />}
            label="Overlapping work"
            subtitle={lockedSub('overlapGate', 'Choose whether tasks that may edit the same files can run together')}
            accessory={
              <SettingsSegmented
                value={values.overlapGate}
                onChange={(next) => { updateField('overlapGate', next as OverlapGateMode); }}
                options={[
                  { value: 'advisory', label: 'Advisory' },
                  { value: 'strict', label: 'Strict' },
                ]}
              />
            }
            disabled={envLocked('overlapGate') || busyField === 'overlapGate'}
            divider
          />
          <ApfsDependencyImagesRow
            icon={<WrenchIcon />}
            persistedValue={values.apfsDependencyImages}
            effectiveOverride={data.effectiveOverride.apfsDependencyImages}
            busy={busyField === 'apfsDependencyImages'}
            onToggle={(next) => { updateField('apfsDependencyImages', next); }}
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Supervision"
          footnote="Automatic fixes, chat investigations, and reviews use your connected AI runtime and may use its allowance. Merge approval controls when to ask before merging; required checks still apply."
        >
          <SettingsRow
            icon={<WrenchIcon />}
            label="Automatically fix failed checks"
            subtitle={lockedSub('healBotEnabled', 'Try one focused AI repair, limited to five minutes, before asking for help. Changes take effect after restarting o8.')}
            checked={values.healBotEnabled}
            disabled={envLocked('healBotEnabled') || busyField === 'healBotEnabled'}
            onToggle={(next) => { updateField('healBotEnabled', next); }}
            divider
          />
          <SettingsRow
            icon={<InboxIcon />}
            label="Investigate failures in chat"
            subtitle={lockedSub('supervisorAutoEscalate', 'Start an AI investigation in chat when a task needs help. When off, failures remain visible in task status and activity.')}
            checked={values.supervisorAutoEscalate}
            disabled={envLocked('supervisorAutoEscalate') || busyField === 'supervisorAutoEscalate'}
            onToggle={(next) => { updateField('supervisorAutoEscalate', next); }}
            divider
          />
          <SettingsRow
            icon={<InboxIcon />}
            label="Automatically review completed work"
            subtitle={lockedSub('reviewContinuation', 'Start an AI review when an assigned task is ready. It can request fixes or merge approved changes, subject to Merge approval below.')}
            checked={values.reviewContinuation}
            disabled={envLocked('reviewContinuation') || busyField === 'reviewContinuation'}
            onToggle={(next) => { updateField('reviewContinuation', next); }}
            divider
          />
          <SettingsRow
            icon={<MergeIcon />}
            label="Merge approval"
            subtitle={lockedSub('requireApproval', MERGE_APPROVAL_DESCRIPTIONS[values.requireApproval])}
            accessory={
              <SettingsSegmented
                value={values.requireApproval}
                onChange={(next) => { updateField('requireApproval', next as RequireApproval); }}
                options={REQUIRE_APPROVAL_OPTIONS}
              />
            }
            disabled={envLocked('requireApproval') || busyField === 'requireApproval'}
            divider
          />
          <SettingsRow
            icon={<UpdateIcon />}
            label="Install app updates automatically"
            subtitle={lockedSub('updateAutoApply', 'Install an available update and restart o8 when no agents, terminal sessions, or background jobs are active.')}
            accessory={
              <SettingsSegmented
                value={values.updateAutoApply}
                onChange={(next) => { updateField('updateAutoApply', next as UpdateAutoApply); }}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'idle', label: 'When idle' },
                ]}
              />
            }
            disabled={envLocked('updateAutoApply') || busyField === 'updateAutoApply'}
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Change reports"
          footnote="Optional reports explain completed work. Provider and model choices live in Models & providers."
        >



          <SettingsRow
            icon={<InboxIcon />}
            label="Explain completed changes"
            subtitle={lockedSub('packetExplainerEnabled', 'Create an extra AI report explaining what changed and why when a task is ready for review. Off by default; uses your review provider.')}
            checked={values.packetExplainerEnabled}
            disabled={envLocked('packetExplainerEnabled') || busyField === 'packetExplainerEnabled'}
            onToggle={(next) => { updateField('packetExplainerEnabled', next); }}
            divider
          />

          <SettingsRow
            icon={<BuyinDocIcon />}
            label="Create a summary after merge"
            subtitle={lockedSub('buyinDocEnabled', 'Create a shareable report of what changed, why, and how it was checked. Includes available demos; does not delay the merge.')}
            checked={values.buyinDocEnabled}
            disabled={envLocked('buyinDocEnabled') || busyField === 'buyinDocEnabled'}
            onToggle={(next) => { updateField('buyinDocEnabled', next); }}
          />

        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Task spending limits"
          footnote="Applies to new tasks using metered gateway inference. The worker stops when reported spending reaches the limit. If spending is unavailable, the input-token limit is used instead. This is not an account-wide billing cap."
        >
          <SettingsRow
            icon={<CpuIcon />}
            label="Spending limit per task"
            subtitle="Maximum reported gateway spending for one task, in USD"
            accessory={(
              <input
                aria-label="Spending limit per task in USD"
                key={values.meteredPacketCostCapUsd}
                type="number"
                min="0.01"
                step="0.01"
                defaultValue={values.meteredPacketCostCapUsd}
                disabled={busyField === 'meteredPacketCostCapUsd'}
                onBlur={(event) => { updateField('meteredPacketCostCapUsd', Number(event.currentTarget.value)); }}
                style={{ width: 92, minHeight: 30, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-input-border)', borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text)', paddingLeft: 9, paddingRight: 9, fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)', fontSize: 11 }}
              />
            )}
            divider
          />
          <SettingsRow
            icon={<CpuIcon />}
            label="Backup input-token limit"
            subtitle="Token ceiling used only when gateway cost is unknown"
            accessory={(
              <input
                aria-label="Backup input-token limit"
                key={values.meteredPacketInputTokenCap}
                type="number"
                min="1"
                step="1000"
                defaultValue={values.meteredPacketInputTokenCap}
                disabled={busyField === 'meteredPacketInputTokenCap'}
                onBlur={(event) => { updateField('meteredPacketInputTokenCap', Number(event.currentTarget.value)); }}
                style={{ width: 92, minHeight: 30, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-input-border)', borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text)', paddingLeft: 9, paddingRight: 9, fontFamily: 'var(--font-mono, "SF Mono", Menlo, monospace)', fontSize: 11 }}
              />
            )}
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
      <SettingsGroup header="Related settings">
        <SettingsRow icon={<CpuIcon />} label="Models & providers" subtitle="Choose providers for the orchestrator, code review, and workers." value="Open" chevron onPress={() => onNavigateTab?.('models')} divider />
        <SettingsRow icon={<CpuIcon />} label="Worktrees & storage" subtitle="See disk usage and manage workspace cleanup." value="Open" chevron onPress={() => onNavigateTab?.('worktrees')} />
      </SettingsGroup>
      </section>
      <SettingsAdvanced description="Design task limits, workspace setup, and preview features.">
        <DispatchTaskSettings values={values} sources={sources} busyField={busyField} updateField={updateField} showExperimental />
      </SettingsAdvanced>
    </div>
  );
}
