'use client';
import { MONO_FONT_STACK, SettingsSegmented } from './shared';
import { SettingsGroup, SettingsRow, ValuePill } from './grouped';
import { ENV_LOCKED_REASON, type OperatorDefaults, type OperatorDefaultSources, type WorkspaceManifestPolicy } from './dispatch-shared';
interface FoundersSectionProps {
  values: OperatorDefaults;
  sources: OperatorDefaultSources;
  busyField: keyof OperatorDefaults | null;
  updateField: <K extends keyof OperatorDefaults>(field: K, value: OperatorDefaults[K]) => void;
  showExperimental: boolean;
}

type UiLoopBudgetField =
  | 'uiLoopMaxIterations'
  | 'uiLoopMaxMinutes'
  | 'uiLoopMaxDiffBytes'
  | 'uiLoopMaxDiffFiles'
  | 'uiLoopPreviewTimeoutMs';

function UiLoopBudgetInput({
  field,
  value,
  busyField,
  updateField,
}: {
  field: UiLoopBudgetField;
  value: number;
  busyField: keyof OperatorDefaults | null;
  updateField: FoundersSectionProps['updateField'];
}) {
  return (
    <input
      key={value}
      type="number"
      min="1"
      step="1"
      defaultValue={value}
      disabled={busyField === field}
      onBlur={(event) => { updateField(field, Number(event.currentTarget.value)); }}
      style={{ width: 86, minHeight: 30, borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--t-input-border)', borderRadius: 8, background: 'var(--t-input-bg)', color: 'var(--t-text)', paddingLeft: 9, paddingRight: 9, fontFamily: MONO_FONT_STACK, fontSize: 11 }}
    />
  );
}

function GaugeIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 15l3.5-3.5" />
      <path d="M20.3 18a10 10 0 1 0-16.6 0" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

function CanvasIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 15l5-5 4 4 3-3 6 6" />
    </svg>
  );
}

function BrowserIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <line x1="2" y1="9" x2="22" y2="9" />
    </svg>
  );
}
export function DispatchTaskSettings({ values, sources, busyField, updateField, showExperimental }: FoundersSectionProps) {
 const envLocked = (_sources: OperatorDefaultSources, field: keyof OperatorDefaults) => _sources[field] === 'env';
 const lockedSub = (field: keyof OperatorDefaults, normal: string) => envLocked(sources, field) ? ENV_LOCKED_REASON : normal;
 return (<>
 <SettingsGroup header="Task limits & setup" footnote="Limits apply to Design Mode follow-up tasks. Workspace setup controls whether repository setup commands may run.">
          <SettingsRow
            icon={<GaugeIcon />}
            label="UI loop iterations"
            subtitle="Follow-up steers allowed per Design Mode packet"
            accessory={<UiLoopBudgetInput field="uiLoopMaxIterations" value={values.uiLoopMaxIterations} busyField={busyField} updateField={updateField} />}
            divider
          />
          <SettingsRow
            icon={<GaugeIcon />}
            label="UI loop minutes"
            subtitle="Wall-time budget from the first Design Mode turn"
            accessory={<UiLoopBudgetInput field="uiLoopMaxMinutes" value={values.uiLoopMaxMinutes} busyField={busyField} updateField={updateField} />}
            divider
          />
          <SettingsRow
            icon={<GaugeIcon />}
            label="UI loop diff bytes"
            subtitle="Maximum current packet diff size"
            accessory={<UiLoopBudgetInput field="uiLoopMaxDiffBytes" value={values.uiLoopMaxDiffBytes} busyField={busyField} updateField={updateField} />}
            divider
          />
          <SettingsRow
            icon={<GaugeIcon />}
            label="UI loop diff files"
            subtitle="Maximum files in the current packet diff"
            accessory={<UiLoopBudgetInput field="uiLoopMaxDiffFiles" value={values.uiLoopMaxDiffFiles} busyField={busyField} updateField={updateField} />}
            divider
          />
          <SettingsRow
            icon={<GaugeIcon />}
            label="UI loop preview timeout"
            subtitle="Milliseconds to wait for a preview to become ready"
            accessory={<UiLoopBudgetInput field="uiLoopPreviewTimeoutMs" value={values.uiLoopPreviewTimeoutMs} busyField={busyField} updateField={updateField} />}
            divider
          />
          <SettingsRow
            icon={<TargetIcon />}
            label="Workspace manifest execution"
            subtitle={lockedSub('workspaceManifestPolicy', 'Gate checked-in setup commands before packet launch')}
            accessory={
              <SettingsSegmented
                value={values.workspaceManifestPolicy}
                onChange={(next) => { updateField('workspaceManifestPolicy', next as WorkspaceManifestPolicy); }}
                options={[
                  { value: 'disabled', label: 'Disabled' },
                  { value: 'one-approval', label: 'Approve once' },
                  { value: 'auto', label: 'Auto' },
                ]}
              />
            }
            divider
          />
 </SettingsGroup>
      {showExperimental ? <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Experimental"
          footnote={<>Adapters and surfaces that ship wired but hidden until they&apos;ve earned defaults. Turning a runtime off snaps any picker using it back to Codex.</>}
        >


          <SettingsRow
            label="o8 next"
            checked={values.experimentalNext ?? false}
            disabled={busyField === 'experimentalNext'}
            onToggle={(next) => { updateField('experimentalNext', next); }}
            divider
          />
          {/* Casual-chat tab toggle intentionally NOT surfaced for the beta
              (operator, 2026-07-06) — the flag still exists (experimentalChat /
              env) but the orchestrator is the only conversational surface. */}
          <SettingsRow
            icon={<CanvasIcon />}
            label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>Canvas mode <ValuePill>Experimental</ValuePill></span>}
            subtitle={lockedSub('experimentalCanvas', 'The glass canvas — voice-first fleet surface. Sole gate.')}
            checked={values.experimentalCanvas}
            disabled={envLocked(sources, 'experimentalCanvas') || busyField === 'experimentalCanvas'}
            onToggle={(next) => { updateField('experimentalCanvas', next); }}
            divider
          />
          {/* Glass tuning lives INSIDE the canvas (its own Appearance panel) —
              the inline settings copy was redundant (operator, 2026-07-06). */}
          <SettingsRow
            icon={<BrowserIcon />}
            label="Native browser-view"
            subtitle={lockedSub('nativeBrowserView', 'Host-owned native window for the Browser pane (macOS)')}
            checked={values.nativeBrowserView}
            disabled={envLocked(sources, 'nativeBrowserView') || busyField === 'nativeBrowserView'}
            onToggle={(next) => { updateField('nativeBrowserView', next); }}
          />
        </SettingsGroup>
      </section> : null}

 </>);
}
