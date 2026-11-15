import 'server-only';

/**
 * Server-side resolver for the Sentry runtime config shared by every layer.
 *
 * DORMANT BY DEFAULT: a DSN is only ever surfaced in a PACKAGED build
 * (`O8_PACKAGED_APP === '1'`) that had one baked in (`O8_SENTRY_DSN`, set by
 * scripts/tauri-export.mjs / the Rust sidecar). Dev (`next dev`) and dev-bridge
 * runs never set `O8_PACKAGED_APP`, so this returns `dsn: ''` and every layer
 * no-ops — zero behavior change, zero network. See the telemetry ruling.
 *
 * The `enabled` toggle, `plan`, and `founder` boolean come from the same
 * `~/.o8/` files the rest of the app reads, so the webview config route and the
 * node init share one truth. `founder` is a BOOLEAN ONLY — never the operator
 * number or any identity. No user id, no email, no machine name.
 */

import { resolveCrashReportsEnabledSync } from '@/lib/operator/defaults';
import { getEntitlementSync } from '@/lib/entitlement/store';
import { readFounderRecord } from '@/lib/entitlement/founder';
import { resolveAppVersion } from './crash-store';

export interface SentryRuntimeConfig {
  /** '' when dormant (no DSN / not packaged). */
  dsn: string;
  /** Operator "Crash & error reports" toggle. */
  enabled: boolean;
  /** App version — the same string the updater ships. */
  release: string;
  /** 'production' for an installed build; 'development' for a local dev stack. */
  environment: string;
  /** Effective plan (free|pro|team|founder). */
  plan: string;
  /** Boolean only — NEVER the operator number. */
  founder: boolean;
  packaged: boolean;
}

export function isPackaged(): boolean {
  return process.env.O8_PACKAGED_APP === '1';
}

/** The baked DSN, or '' unless this is a packaged build. */
export function resolveSentryDsn(): string {
  if (!isPackaged()) return '';
  return process.env.O8_SENTRY_DSN?.trim() || '';
}

/**
 * Which environment Sentry should tag events with.
 *
 * A packaged shell can point at a local dev server via
 * `O8_DEV_FRONTEND_URL`. Keep those errors tagged as development even when
 * a packaged build supplies the reporting DSN (#1679).
 */
export function resolveSentryEnvironment(): string {
  if (process.env.O8_DEV_FRONTEND_URL?.trim()) return 'development';
  if (!isPackaged()) return 'development';
  const nodeEnv = process.env.NODE_ENV?.trim();
  if (nodeEnv && nodeEnv !== 'production') return 'development';
  return 'production';
}

export function resolveCrashReportsToggle(): boolean {
  try {
    return resolveCrashReportsEnabledSync();
  } catch {
    return false; // fail closed if local preferences cannot be read
  }
}

export function resolveSentryConfig(): SentryRuntimeConfig {
  let plan = 'free';
  try {
    plan = getEntitlementSync().plan;
  } catch {
    /* keep 'free' */
  }
  let founder = false;
  try {
    founder = readFounderRecord() !== null;
  } catch {
    /* keep false */
  }
  return {
    dsn: resolveSentryDsn(),
    enabled: resolveCrashReportsToggle(),
    release: resolveAppVersion(),
    environment: resolveSentryEnvironment(),
    plan,
    founder,
    packaged: isPackaged(),
  };
}
