import { useCallback, useEffect, useState } from 'react';
import { hasPermissionsResume } from '@/components/desktop/onboarding/permissions-check';
import { browserProgressStorage } from '@/components/desktop/onboarding/onboarding-progress';
import type { DetectionResult } from '@/components/desktop/setup-wizard/types';

export function useSetupWizard() {
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);
  const [setupCheckComplete, setSetupCheckComplete] = useState(false);
  const [setupDetection] = useState<DetectionResult | null>(null);
  const [setupCompleteError, setSetupCompleteError] = useState<string | null>(null);
  const [setupCheckError, setSetupCheckError] = useState<string | null>(null);

  useEffect(() => {
    if (hasPermissionsResume(browserProgressStorage())) {
      setSetupWizardOpen(true);
      setSetupCheckComplete(true);
      return;
    }
    let active = true;
    let settled = false;
    const controller = new AbortController();
    const recover = () => {
      setSetupCheckError('Could not check setup. You can continue setup here.');
      setSetupWizardOpen(true);
    };
    const timeout = window.setTimeout(() => {
      if (!active || settled) return;
      settled = true;
      controller.abort();
      recover();
      setSetupCheckComplete(true);
    }, 10_000);
    (async () => {
      try {
        const configRes = await fetch('/api/setup/config', { signal: controller.signal });
        if (!configRes.ok) throw new Error(`Setup check failed (${configRes.status})`);
        const config = await configRes.json();
        if (!active || settled) return;
        // A completed install must not run the full CLI/auth detector during
        // dashboard startup. That route probes several local binaries and can
        // hold the server event loop long enough to delay UI chunks. Detection
        // remains part of the onboarding and explicit settings paths.
        if ((config.setupComplete || config.completedAt) && !config.agentSetupPending) return;
        // The combined tools step owns discovery when the user reaches it.
        setSetupWizardOpen(true);
      } catch {
        if (active && !settled) recover();
      } finally {
        if (active && !settled) {
          settled = true;
          window.clearTimeout(timeout);
          setSetupCheckComplete(true);
        }
      }
    })();
    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  const handleSetupComplete = useCallback(async (repoPath?: string) => {
    setSetupCompleteError(null);
    try {
      const res = await fetch('/api/setup/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Write BOTH the canonical flag and the display timestamp.
        // Previously only `completedAt` was written, leaving `setupComplete`
        // stuck at its default `false` forever and making any code that
        // gated on the canonical flag think onboarding never finished.
        body: JSON.stringify({
          setupComplete: true,
          ...(repoPath ? { repoPath } : {}),
          completedAt: new Date().toISOString(),
        }),
      });
      if (!res.ok) throw new Error(`Setup completion save failed (${res.status})`);
      setSetupCheckError(null);
      setSetupWizardOpen(false);
      return true;
    } catch (error) {
      console.error('[setup]', error);
      setSetupCompleteError('Setup could not be saved. Try again to finish onboarding.');
      setSetupWizardOpen(true);
      return false;
    }
  }, []);

  // Dev: trigger onboarding from settings without resetting config
  useEffect(() => {
    const handler = () => setSetupWizardOpen(true);
    window.addEventListener('o8-trigger-onboarding', handler);
    return () => window.removeEventListener('o8-trigger-onboarding', handler);
  }, []);

  return {
    handleSetupComplete,
    setupCompleteError,
    setupCheckError,
    setupCheckComplete,
    setupDetection,
    setupWizardOpen,
    setSetupWizardOpen,
  };
}
