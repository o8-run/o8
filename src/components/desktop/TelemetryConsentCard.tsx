'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { OnboardingFeedback } from './onboarding/OnboardingFeedback';

import { PRODUCT_EVENT_DISCLOSURES } from '@/lib/analytics/events';
import { PRODUCT_TELEMETRY_READY_EVENT } from '@/lib/analytics/startup';
import { SCRUBBED_CRASH_SAMPLE } from '@/lib/telemetry/consent-sample';
import { fetchOperatorDefaults } from './settings/operator-defaults-client';

type ConsentChoice = boolean | null;
type LoadState = 'loading' | 'hidden' | 'visible';

interface ConsentResponse {
  values?: {
    telemetryConsentAnswered?: unknown;
    crashReportsEnabled?: unknown;
    productTelemetryEnabled?: unknown;
  };
  error?: unknown;
}

function ShieldGlyph() {
  return (
    <svg
      aria-hidden
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block' }}
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-5" />
    </svg>
  );
}

function ChoiceButton({
  label,
  inverseColor,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  inverseColor: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onPress}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        minHeight: 44,
        width: '100%',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 14,
        paddingRight: 14,
        borderRadius: 10,
        border: selected
          ? '1px solid var(--t-text)'
          : '1px solid var(--t-divider-strong)',
        background: selected
          ? 'var(--t-text)'
          : hovered
            ? 'var(--t-hover)'
            : 'var(--t-chat-surface-bg)',
        color: selected ? inverseColor : 'var(--t-text)',
        fontFamily: 'var(--font-sans-system)',
        fontSize: 12.5,
        fontWeight: 400,
        letterSpacing: -0.1,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1), border-color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      {selected ? (
        <svg aria-hidden width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="m3 8 3 3 7-7" />
        </svg>
      ) : null}
      {label}
    </button>
  );
}

function DecisionButtons({
  value,
  shareLabel,
  declineLabel,
  inverseColor,
  disabled,
  onChange,
}: {
  value: ConsentChoice;
  shareLabel: string;
  declineLabel: string;
  inverseColor: string;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div
      role="group"
      aria-label={`${shareLabel} or ${declineLabel}`}
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 8,
        marginTop: 16,
      }}
    >
      <ChoiceButton
        label={shareLabel}
        inverseColor={inverseColor}
        selected={value === true}
        disabled={disabled}
        onPress={() => onChange(true)}
      />
      <ChoiceButton
        label={declineLabel}
        inverseColor={inverseColor}
        selected={value === false}
        disabled={disabled}
        onPress={() => onChange(false)}
      />
    </div>
  );
}

function DisclosureCard({ children }: { children: React.ReactNode }) {
  return (
    <section style={{
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      paddingTop: 20,
      paddingBottom: 20,
      paddingLeft: 20,
      paddingRight: 20,
      borderRadius: 14,
      border: '1px solid var(--t-chat-surface-border)',
      background: 'var(--t-chat-surface-card-bg)',
    }}>
      {children}
    </section>
  );
}

export function TelemetryConsentCard({
  blocked = false,
  request = fetchOperatorDefaults,
  embedded = false,
  onContinue,
  onBusyChange,
}: {
  blocked?: boolean;
  embedded?: boolean;
  onContinue?: () => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  request?: typeof fetchOperatorDefaults;
}) {
  const [revision, setRevision] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [crashReports, setCrashReports] = useState<ConsentChoice>(null);
  const [productUsage, setProductUsage] = useState<ConsentChoice>(null);
  const [saving, setSaving] = useState(false);
  const [savedChoices, setSavedChoices] = useState<string | null>(null);
  const choicesSaved = savedChoices === JSON.stringify([crashReports, productUsage]);
  useEffect(() => { onBusyChange?.(saving); return () => onBusyChange?.(false); }, [onBusyChange, saving]);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const crashSample = useMemo(() => JSON.stringify(SCRUBBED_CRASH_SAMPLE, null, 2), []);

  useEffect(() => {
    if (blocked) return;
    let alive = true;
    void (async () => {
      try {
        const response = await request({}, { fresh: true, includeRuntime: false });
        const payload = await response.json().catch(() => ({})) as ConsentResponse;
        if (!response.ok) throw new Error('Could not load your privacy choices.');
        if (alive) {
          const answered = payload.values?.telemetryConsentAnswered === true;
          // Preserve either earlier choice even if the combined card was never
          // answered. Missing product choice uses the default without inventing
          // an explicit opt-in; crash sharing still needs its own decision.
          setCrashReports(answered && typeof payload.values?.crashReportsEnabled === 'boolean' ? payload.values.crashReportsEnabled : null);
          setProductUsage(typeof payload.values?.productTelemetryEnabled === 'boolean' ? payload.values.productTelemetryEnabled : null);
          setError(null);
          setLoadState(answered && !embedded ? 'hidden' : 'visible');
        }
      } catch {
        if (alive && embedded) setError('Could not load your privacy choices. Retry to continue.');
      }
    })();
    return () => { alive = false; };
  }, [blocked, embedded, request, revision]);

  useEffect(() => {
    if (loadState === 'visible' && !blocked && !embedded) dialogRef.current?.focus();
  }, [blocked, embedded, loadState]);

  if (blocked || loadState === 'hidden') return null;
  if (loadState === 'loading') return embedded ? <div style={{ color: 'var(--t-text-secondary)', fontSize: 13 }}>
    <p role={error ? 'alert' : 'status'}>{error ?? 'Loading your privacy choices…'}</p>
    {error ? <button type="button" onClick={() => { setError(null); setRevision((value) => value + 1); }}>Retry privacy choices</button> : null}
  </div> : null;

  const inverseColor = embedded ? 'var(--t-onboarding-bg)' : 'var(--t-chat-surface-bg)';
  const canSave = crashReports !== null && !saving;
  const keepFocusInDialog = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), summary'),
    );
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const saveChoices = async () => {
    if (crashReports === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (embedded && choicesSaved) { await onContinue?.(); return; }
      const response = await request({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          crashReportsEnabled: crashReports,
          productTelemetryEnabled: productUsage,
          telemetryConsentAnswered: true,
        }),
      });
      const payload = await response.json().catch(() => ({})) as ConsentResponse;
      if (!response.ok || payload.values?.telemetryConsentAnswered !== true) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Your choices could not be saved.');
      }
      setSavedChoices(JSON.stringify([crashReports, productUsage]));
      window.dispatchEvent(new Event(PRODUCT_TELEMETRY_READY_EVENT));
      if (embedded) await onContinue?.();
      else setLoadState('hidden');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Your choices could not be saved.');
    } finally {
      setSaving(false);
    }
  };
  const changeProductUsage = async (next: boolean) => {
    if (saving) return;
    // A lost response may follow a successful write. Retain the user's choice
    // so the final save cannot restore default-on after a requested opt-out.
    setProductUsage(next);
    setSaving(true);
    setError(null);
    try {
      const response = await request({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productTelemetryEnabled: next }),
      });
      const payload = await response.json().catch(() => ({})) as ConsentResponse;
      if (!response.ok || payload.values?.productTelemetryEnabled !== next) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'Your usage choice could not be saved.');
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Your usage choice could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      role="presentation"
      style={{
        position: embedded ? 'relative' : 'fixed',
        inset: 0,
        zIndex: 99997,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: embedded ? '100%' : undefined,
        padding: embedded ? 0 : 32,
        background: embedded ? 'transparent' : 'var(--t-bg)',
        backdropFilter: embedded ? undefined : 'blur(20px)',
        WebkitBackdropFilter: embedded ? undefined : 'blur(20px)',
      } as React.CSSProperties}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal={embedded ? undefined : true}
        aria-labelledby="telemetry-consent-title"
        tabIndex={-1}
        onKeyDown={embedded ? undefined : keepFocusInDialog}
        style={{
          width: 'min(960px, 100%)',
          boxSizing: 'border-box',
          maxHeight: embedded ? undefined : '100%',
          overflowY: embedded ? 'visible' : 'auto',
          padding: embedded ? 0 : 28,
          borderRadius: 16,
          border: embedded ? 'none' : '1px solid var(--t-chat-surface-border)',
          background: embedded ? 'transparent' : 'var(--t-chat-surface-bg)',
          color: 'var(--t-chat-surface-text)',
          boxShadow: embedded ? 'none' : 'var(--t-glass-shadow)',
          fontFamily: 'var(--font-sans-system)',
        }}
      >
        <header style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 24 }}>
          <div style={{
            width: 44,
            height: 44,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 12,
            border: '1px solid var(--t-divider-subtle)',
            background: 'var(--t-code-bg)',
            color: 'var(--t-text)',
          }}>
            <ShieldGlyph />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{
              marginBottom: 8,
              fontSize: 10,
              fontWeight: 300,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--t-text-muted)',
            }}>
              Privacy <span style={{ marginLeft: 10, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', letterSpacing: '0.04em' }}>(first run)</span>
            </div>
            <h1 id="telemetry-consent-title" style={{
              marginTop: 0,
              marginBottom: 8,
              fontSize: 28,
              fontWeight: 400,
              letterSpacing: -0.4,
              lineHeight: 1.2,
              color: 'var(--t-text)',
            }}>
              You choose what o8 sends.
            </h1>
            <p style={{
              maxWidth: 720,
              marginTop: 0,
              marginBottom: 0,
              fontSize: 13.5,
              fontWeight: 300,
              letterSpacing: -0.1,
              lineHeight: 1.55,
              color: 'var(--t-text-secondary)',
            }}>
              Usage analytics are on by default for installs without an earlier choice. Default-on sharing starts after you finish this screen. Turn them off with one click. Crash reports are a separate opt-in. You can change either choice in Settings → General → Privacy.
            </p>
          </div>
        </header>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 390px), 1fr))',
          gap: 16,
        }}>
          <DisclosureCard>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
              <h2 style={{ marginTop: 0, marginBottom: 0, fontSize: 16, fontWeight: 400, letterSpacing: -0.1, color: 'var(--t-text)' }}>
                Usage analytics
              </h2>
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 10, color: 'var(--t-text-faint)' }}>
                ({PRODUCT_EVENT_DISCLOSURES.length} events)
              </span>
            </div>
            <p style={{ marginTop: 0, marginBottom: 12, fontSize: 12.5, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>
              Helps us understand which features get used. These are the complete event names and fields. No identity is collected beyond sign-in; the event payload contains no identity fields.
            </p>
            <p role="status" style={{ marginTop: 16, marginBottom: 8, fontSize: 12.5, color: 'var(--t-text-secondary)' }}>
              {error ? 'Check the save status above before continuing.' : productUsage === false ? 'Usage analytics are off.' : 'Usage analytics are on.'}
            </p>
            <ChoiceButton label={productUsage === false ? 'Turn on' : 'Turn off'} inverseColor={inverseColor} selected={false} disabled={saving}
              onPress={() => { void changeProductUsage(productUsage === false); }} />
            <div style={{ display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--t-divider-subtle)' }}>
              {PRODUCT_EVENT_DISCLOSURES.map(({ event, fields }) => (
                <div key={event} style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(132px, 0.8fr) minmax(0, 1.4fr)',
                  gap: 12,
                  paddingTop: 10,
                  paddingBottom: 10,
                  borderBottom: '1px solid var(--t-divider-subtle)',
                }}>
                  <code style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 10.5, color: 'var(--t-text)' }}>
                    {event}
                  </code>
                  <span style={{ fontSize: 10.5, fontWeight: 300, lineHeight: 1.4, color: 'var(--t-text-muted)' }}>
                    {fields}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12, marginBottom: 6, fontSize: 11, color: 'var(--t-text-secondary)' }}>Example payload when a project is added</div>
            <pre style={{
              marginTop: 0, marginBottom: 0, paddingTop: 12, paddingBottom: 12, paddingLeft: 12, paddingRight: 12,
              borderRadius: 10, background: 'var(--t-code-bg)', color: 'var(--t-text-secondary)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: 10.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
            }}>{JSON.stringify({ event: 'repo.added', props: { hasRemote: true, isGitRepo: true } }, null, 2)}</pre>
            <div style={{
              marginTop: 12,
              paddingTop: 12,
              paddingBottom: 12,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 10,
              border: '1px solid var(--t-divider-subtle)',
              background: 'var(--t-code-bg)',
            }}>
              <div style={{ marginBottom: 5, fontSize: 10, fontWeight: 400, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t-text)' }}>
                Never sent in product usage
              </div>
              <div style={{ fontSize: 11, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>
                Code, prompts, repo names, file paths, diffs, transcripts, file contents, credentials, user identity, or machine identity.
              </div>
            </div>
          </DisclosureCard>

          <DisclosureCard>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
              <h2 style={{ marginTop: 0, marginBottom: 0, fontSize: 16, fontWeight: 400, letterSpacing: -0.1, color: 'var(--t-text)' }}>
                Crash reports
              </h2>
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 10, color: 'var(--t-text-faint)' }}>
                (errors + stacks)
              </span>
            </div>
            <p style={{ marginTop: 0, marginBottom: 12, fontSize: 12.5, fontWeight: 300, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>
              Helps diagnose failures with scrubbed errors and stack traces. Native crash reports may include thread-stack memory and loaded-module paths, beginning on the next launch.
            </p>
            <details style={{ fontSize: 12, color: 'var(--t-text-secondary)' }}>
              <summary style={{ cursor: 'pointer', marginBottom: 8 }}>See a sample crash report</summary>
            <div style={{ marginBottom: 6, fontSize: 10, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--t-text-muted)' }}>
              Scrubbed sample payload
            </div>
            <pre style={{
              flex: 1,
              minHeight: 176,
              maxHeight: 230,
              overflow: 'auto',
              marginTop: 0,
              marginBottom: 0,
              paddingTop: 12,
              paddingBottom: 12,
              paddingLeft: 12,
              paddingRight: 12,
              borderRadius: 10,
              border: '1px solid var(--t-divider-subtle)',
              background: 'var(--t-code-bg)',
              color: 'var(--t-text-secondary)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: 10.5,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}>
              {crashSample}
            </pre>
            <p style={{ marginTop: 10, marginBottom: 0, fontSize: 10.5, fontWeight: 300, lineHeight: 1.45, color: 'var(--t-text-muted)' }}>
              This sample uses placeholders and the same scrubber as browser and server reports.
            </p>
            </details>
            <DecisionButtons
              value={crashReports}
              inverseColor={inverseColor}
              shareLabel="Share crash reports"
              declineLabel="Keep crash reports off"
              disabled={saving}
              onChange={setCrashReports}
            />
          </DisclosureCard>
        </div>
        {embedded && choicesSaved ? <div style={{ marginTop: 16 }}><OnboardingFeedback title="Privacy choices saved">You can change either choice later in Settings.</OnboardingFeedback></div> : null}
        <footer style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          position: embedded ? 'sticky' : undefined,
          bottom: embedded ? 0 : undefined,
          zIndex: 1,
          background: embedded ? 'var(--t-onboarding-dock-bg, var(--t-onboarding-bg))' : undefined,
          flexWrap: 'wrap',
          marginTop: 20,
          paddingTop: 8,
          paddingBottom: 12,
          borderBottom: '1px solid var(--t-divider-subtle)',
        }}>
          <div style={{ minHeight: 20, fontSize: 11.5, fontWeight: 300, lineHeight: 1.45, color: error ? 'var(--t-danger)' : 'var(--t-text-muted)' }} role={error ? 'alert' : undefined}>
            {error ?? (embedded && choicesSaved ? 'Continue when you’re ready.' : canSave ? 'Your privacy choices are ready to save.' : 'Choose whether to share crash reports to continue.')}
          </div>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => { void saveChoices(); }}
            style={{
              minHeight: 44,
              flexShrink: 0,
              paddingTop: 10,
              paddingBottom: 10,
              paddingLeft: 20,
              paddingRight: 20,
              border: '1px solid var(--t-text)',
              borderRadius: 10,
              background: canSave ? 'var(--t-text)' : 'var(--t-chat-surface-bg)',
              color: canSave ? inverseColor : 'var(--t-text-faint)',
              fontFamily: 'var(--font-sans-system)',
              fontSize: 12.5,
              fontWeight: 400,
              cursor: canSave ? 'pointer' : 'default',
              opacity: canSave ? 1 : 0.7,
              transition: 'background 150ms cubic-bezier(0.22, 1, 0.36, 1), color 150ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            {saving ? choicesSaved && embedded ? 'Opening workspace…' : 'Saving choices…' : embedded && choicesSaved ? 'Continue' : 'Save privacy choices'}
          </button>
        </footer>

      </div>
    </div>
  );
}
