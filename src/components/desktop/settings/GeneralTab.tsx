'use client';

/**
 * GeneralTab is the General settings page.
 *
 * Collects app-level settings that don't belong to Dispatch, Voice, or
 * Account: startup, conversation titles, and privacy choices.
 *
 * - Launch at login persists through the Tauri bridge (autostart_set), so the
 *   Startup group only renders in the desktop shell.
 * - The Privacy rows write to the same /api/panel/operator-defaults route as
 *   the rest of operator defaults, with the same env-locked handling.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  APP_FONT_STACK,
  SettingsSelect,
  TabHeading,
  SETTINGS_CONTENT_MAX_WIDTH,
  type SettingsTab,
} from './shared';
import { UpdateChannelSection } from './UpdateChannelSection';
import { SettingsGroup, SettingsRow } from './grouped';
import { fetchOperatorDefaults } from './operator-defaults-client';
import {
  autostartIsEnabled,
  autostartSet,
  desktopClosePreferenceGet,
  desktopClosePreferenceSet,
  getDesktopInfo,
  isTauri,
  type DesktopClosePreference,
} from '@/lib/tauri/bridge';
import { primeQuietMode, setQuietMode, syncReviewNotificationSetting } from '@/lib/presentation/quiet-mode-client';
import {
  ENV_LOCKED_REASON,
  type OperatorDefaults,
  type OperatorDefaultsResponse,
} from './dispatch-shared';

// ── Minimal raw-SVG glyphs for row icon tiles (React icon libs don't render
//    inside the Tauri webview — raw <svg> only, per repo rules). ──

function PowerIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </svg>
  );
}

function PresentIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M12 16v4" />
      <path d="M8 20h8" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l-2 2v-8.5A8.5 8.5 0 0 1 11.5 5H13" />
      <path d="M17 2v6M14 5h6" />
    </svg>
  );
}

function BellOffIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M18 8a6 6 0 0 0-9.3-5" />
      <path d="M6 9c0 7-3 7-3 9h13" />
      <path d="M10 21h4" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

export function GeneralTab({ onNavigateTab }: { onNavigateTab?: (tab: SettingsTab) => void }) {
  void onNavigateTab;
  const tauri = isTauri();

  // ── Launch at login (native autostart via the Tauri bridge) ──
  const [autostart, setAutostart] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [desktopPlatform, setDesktopPlatform] = useState<string | null>(null);
  const [closePreference, setClosePreference] = useState<DesktopClosePreference>('ask');
  const [closePreferenceBusy, setClosePreferenceBusy] = useState(false);

  useEffect(() => {
    if (!tauri) return;
    let alive = true;
    Promise.all([
      autostartIsEnabled(),
      getDesktopInfo(),
      desktopClosePreferenceGet(),
    ])
      .then(([enabled, desktop, preference]) => {
        if (!alive) return;
        setAutostart(enabled);
        setDesktopPlatform(desktop?.platform ?? null);
        setClosePreference(preference);
      })
      .catch(() => { /* leave default off */ });
    return () => { alive = false; };
  }, [tauri]);

  const handleAutostart = useCallback((next: boolean) => {
    setAutostart(next);
    setAutostartBusy(true);
    void autostartSet(next)
      .then(setAutostart)
      .finally(() => setAutostartBusy(false));
  }, []);

  const handleClosePreference = useCallback((next: string) => {
    if (next !== 'ask' && next !== 'background' && next !== 'quit') return;
    setClosePreference(next);
    setClosePreferenceBusy(true);
    void desktopClosePreferenceSet(next)
      .then(setClosePreference)
      .finally(() => setClosePreferenceBusy(false));
  }, []);

  const canConfigureClose = desktopPlatform === 'windows' || desktopPlatform === 'linux';

  // ── Operator defaults (crash-report privacy toggles) ──
  const [data, setData] = useState<OperatorDefaultsResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyField, setBusyField] = useState<keyof OperatorDefaults | null>(null);
  const [quietModeBusy, setQuietModeBusy] = useState(false);

  const loadDefaults = useCallback(async () => {
    try {
      const response = await fetchOperatorDefaults();
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Failed to load settings.');
      }
      const defaults = payload as OperatorDefaultsResponse;
      setData(defaults);
      // Quiet mode and the review-banner preference are enforced in the native
      // shell (overlay windows and the macOS banner live outside this document),
      // so every read pushes the current values down to it.
      primeQuietMode(defaults.values?.presentationQuietMode === true);
      void syncReviewNotificationSetting(defaults.values?.notificationsReviewReady !== 'off');
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to load settings.');
    }
  }, []);

  useEffect(() => { void loadDefaults(); }, [loadDefaults]);

  const updateField = useCallback(async <K extends keyof OperatorDefaults>(field: K, value: OperatorDefaults[K]) => {
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
      setData(payload as OperatorDefaultsResponse);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Failed to update setting.');
    } finally {
      setBusyField(null);
    }
  }, []);

  // Quiet mode is not a plain field write: the native shell has to take the
  // overlay windows down (and put them back) around the persist, so it goes
  // through the quiet-mode client rather than `updateField`.
  const toggleQuietMode = useCallback(async (next: boolean) => {
    setQuietModeBusy(true);
    setNotice(null);
    try {
      await setQuietMode(next);
      await loadDefaults();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Quiet mode could not be saved.');
    } finally {
      setQuietModeBusy(false);
    }
  }, [loadDefaults]);

  const values = data?.values;
  const sources = data?.sources;
  const shareUsage = Boolean(values) && values?.productTelemetryEnabled !== false;
  const envLocked = (field: keyof OperatorDefaults) => sources?.[field] === 'env';
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
      <TabHeading
        title="general"
        subtitle="Startup, conversation titles, and what o8 shares when something breaks."
      />

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

      {tauri ? (
        <section>
          <SettingsGroup
            header="Startup"
            footnote={canConfigureClose
              ? 'Closing o8 quits when no agent is working. With active work, o8 can ask, stay available from the system tray, or stop the workers and quit.'
              : 'Launch o8 automatically when you log in, so the fleet, dictation, and the menu-bar tray are ready the moment you sit down.'}
          >
            <SettingsRow
              icon={<PowerIcon />}
              label="Launch at login"
              subtitle="Start o8 automatically when you sign in to your computer"
              checked={autostart}
              disabled={autostartBusy}
              onToggle={handleAutostart}
              divider={canConfigureClose}
            />
            {canConfigureClose ? (
              <SettingsRow
                icon={<PowerIcon />}
                label="When closing with active agents"
                subtitle="No active work always quits fully"
                accessory={(
                  <SettingsSelect
                    value={closePreference}
                    onChange={handleClosePreference}
                    disabled={closePreferenceBusy}
                    width={170}
                    options={[
                      { value: 'ask', label: 'Ask every time' },
                      { value: 'background', label: 'Keep working' },
                      { value: 'quit', label: 'Stop and quit' },
                    ]}
                  />
                )}
              />
            ) : null}
          </SettingsGroup>
        </section>
      ) : null}

      {tauri ? <UpdateChannelSection /> : null}

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Conversations"
          footnote="On by default. When this is off, o8 still makes a short title from your first message."
        >
          <SettingsRow
            icon={<ChatIcon />}
            label="Model-generated titles"
            subtitle="Allow a background model call to give new conversations a more useful title"
            checked={values?.autoTitleInferenceEnabled !== false}
            disabled={!values || busyField === 'autoTitleInferenceEnabled'}
            onToggle={(next) => { void updateField('autoTitleInferenceEnabled', next); }}
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: tauri ? 28 : 0 }}>
        <SettingsGroup
          header="Presentation"
          footnote="Quiet mode is for a screen share, a demo, or a recording. It takes down the overlay windows o8 floats outside its own frame, stops onboarding cards, count pills and toasts, and silences review notifications. Approvals and errors still come through. Quiet mode hides noise, not the fact that o8 is blocked on you."
        >
          <SettingsRow
            icon={<PresentIcon />}
            label="Quiet mode"
            subtitle={quietModeBusy
              ? 'Applying…'
              : 'Suppress overlays, coach cards, non-critical pills and toasts, and review notifications'}
            checked={values?.presentationQuietMode === true}
            disabled={!values || quietModeBusy}
            onToggle={(next) => { void toggleQuietMode(next); }}
            divider
          />
          <SettingsRow
            icon={<BellOffIcon />}
            label="Review notifications"
            subtitle={values?.presentationQuietMode === true
              ? 'Held off while quiet mode is on'
              : 'Raise a desktop notification when a packet is ready for review. A parallel dispatch arrives as one notification, not one per packet.'}
            checked={values ? values.notificationsReviewReady === 'on' : true}
            disabled={!values || busyField === 'notificationsReviewReady' || values.presentationQuietMode === true}
            onToggle={(next) => {
              void updateField('notificationsReviewReady', next ? 'on' : 'off');
              void syncReviewNotificationSetting(next);
            }}
          />
        </SettingsGroup>
      </section>

      <section style={{ marginTop: 28 }}>
        <SettingsGroup
          header="Privacy"
          footnote="Usage analytics are on by default until you turn them off. Earlier choices are preserved. Crash reports and local crash-log uploads are separate opt-ins."
        >
          <SettingsRow
            icon={<ShieldIcon />}
            label="Share usage data"
            subtitle="Share six basic feature-use events. No code, prompts, file paths, repo names, or file contents. Changes take effect immediately."
            checked={shareUsage}
            disabled={!values || busyField === 'productTelemetryEnabled'}
            onToggle={(next) => { void updateField('productTelemetryEnabled', next); }}
            divider={Boolean(values && sources)}
          />
          {values && sources ? (
            <>
              <SettingsRow
                icon={<ShieldIcon />}
                label="Share crash reports"
                subtitle={lockedSub('crashReportsEnabled', 'Share scrubbed errors and stack traces, which may include project-relative paths and runtime context. Required to submit bug reports.')}
                checked={values.crashReportsEnabled}
                disabled={envLocked('crashReportsEnabled') || busyField === 'crashReportsEnabled'}
                onToggle={(next) => { void updateField('crashReportsEnabled', next); }}
                divider
              />
              <SettingsRow
                icon={<ShieldIcon />}
                label="Automatically upload local crash logs"
                subtitle={lockedSub('telemetryOptIn', 'Periodically upload saved crash logs, including error messages and stack traces, when an upload destination is configured. Local logging continues when this is off.')}
                checked={values.telemetryOptIn}
                disabled={envLocked('telemetryOptIn') || busyField === 'telemetryOptIn'}
                onToggle={(next) => { void updateField('telemetryOptIn', next); }}
              />
            </>
          ) : null}
        </SettingsGroup>
      </section>
    </div>
  );
}
