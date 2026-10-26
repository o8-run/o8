import type { OperatorDefaults } from './defaults';

/**
 * Declared lifecycle posture of a settings-backed feature flag.
 *
 * - `promotion-candidate` — landed default-off with no promotion decision on
 *   record. These are the only entries that can age into an overdue warning.
 * - `deliberate-default-off` — designed to ship off (unsupported surface,
 *   alpha-only, optional cost, or explicit consent). Stays audited and visible,
 *   never warns, and must carry a rationale.
 * - `promoted` — already shipped on in the code default.
 */
export type ShippedDarkLifecycle =
  | 'promotion-candidate'
  | 'deliberate-default-off'
  | 'promoted';

export const SHIPPED_DARK_LIFECYCLES: readonly ShippedDarkLifecycle[] = Object.freeze([
  'promotion-candidate',
  'deliberate-default-off',
  'promoted',
]);

/**
 * A flag with no manifest entry is treated as an unreviewed candidate, so a
 * newly added flag warns instead of silently hiding behind a missing record.
 */
export const DEFAULT_SHIPPED_DARK_LIFECYCLE: ShippedDarkLifecycle = 'promotion-candidate';

export interface ShippedDarkFlagManifestEntry {
  /** Release the flag's code default first shipped in. */
  landedRelease: string;
  lifecycle: ShippedDarkLifecycle;
  /** Why the flag ships off. Required for `deliberate-default-off`. */
  rationale: string | null;
}

/**
 * Release + lifecycle metadata bundled with the app so the installed runtime
 * can audit feature age and disposition without a source checkout or Git.
 */
export const SHIPPED_DARK_FLAG_MANIFEST: Readonly<
  Partial<Record<keyof OperatorDefaults, ShippedDarkFlagManifestEntry>>
> = Object.freeze({
  experimentalOpencode: {
    landedRelease: '0.1.681',
    lifecycle: 'deliberate-default-off',
    rationale: 'Operator-controlled visibility gate for a secondary runtime; enable it explicitly when selecting that runtime.',
  },
  experimentalGemini: {
    landedRelease: '0.1.681',
    lifecycle: 'deliberate-default-off',
    rationale: 'Operator-controlled visibility gate for a secondary runtime; enable it explicitly when selecting that runtime.',
  },
  experimentalChat: {
    landedRelease: '0.1.681',
    lifecycle: 'deliberate-default-off',
    rationale: 'Alpha-only casual chat tab; the orchestrator stays the single conversational surface until it leaves alpha.',
  },
  experimentalCanvas: {
    landedRelease: '0.1.681',
    lifecycle: 'deliberate-default-off',
    rationale: 'Alpha-only fleet-canvas tab; the New-tab row stays hidden while the surface is in alpha.',
  },
  nativeBrowserView: {
    landedRelease: '0.1.681',
    lifecycle: 'promoted',
    rationale: null,
  },
  broadcastCommentary: {
    landedRelease: '0.1.696',
    lifecycle: 'deliberate-default-off',
    rationale: 'Opt-in ambient commentary; a quiet control plane is the default operator posture.',
  },
  broadcastVoice: {
    landedRelease: '0.1.698',
    lifecycle: 'deliberate-default-off',
    rationale: 'Opt-in spoken commentary; speech never starts without the operator asking for it.',
  },
  apfsDependencyImages: {
    landedRelease: '0.1.691',
    lifecycle: 'deliberate-default-off',
    rationale: 'Platform-gated: APFS dependency images exist only on macOS, so the default follows platform capability.',
  },
  mergeTestReplayEnabled: {
    landedRelease: '0.1.681',
    lifecycle: 'deliberate-default-off',
    rationale: 'Optional merge-gate test replay; kept off because repository test commands can be slow.',
  },
  packetExplainerEnabled: {
    landedRelease: '0.1.560',
    lifecycle: 'deliberate-default-off',
    rationale: 'Optional AI report and quiz consume a separate model turn; generation requires operator opt-in.',
  },
  quizGateEnabled: {
    landedRelease: '0.1.681',
    lifecycle: 'deliberate-default-off',
    rationale: 'Optional human quiz speed bump before the merge button; opt-in per operator.',
  },
  buyinDocEnabled: {
    landedRelease: '0.1.681',
    lifecycle: 'deliberate-default-off',
    rationale: 'Opt-in buy-in document generated after merge; off unless the operator wants the external artifact.',
  },
  productTelemetryEnabled: {
    landedRelease: '0.1.681',
    lifecycle: 'promoted',
    rationale: 'Usage analytics default on after first-run disclosure; explicit opt-outs remain off.',
  },
  telemetryOptIn: {
    landedRelease: '0.1.681',
    lifecycle: 'deliberate-default-off',
    rationale: 'Privacy consent: crash logs stay local until the operator opts into upload.',
  },
  crashReportsEnabled: {
    landedRelease: '0.1.681',
    lifecycle: 'deliberate-default-off',
    rationale: 'Privacy consent: scrubbed crash sharing only transmits after an explicit opt-in.',
  },
});

export function isShippedDarkLifecycle(value: unknown): value is ShippedDarkLifecycle {
  return typeof value === 'string'
    && (SHIPPED_DARK_LIFECYCLES as readonly string[]).includes(value);
}

export function shippedDarkManifestEntry(
  key: keyof OperatorDefaults,
): ShippedDarkFlagManifestEntry | null {
  return SHIPPED_DARK_FLAG_MANIFEST[key] ?? null;
}

/** Only unreviewed promotion candidates can age into an overdue warning. */
export function isShippedDarkPromotionCandidate(lifecycle: ShippedDarkLifecycle): boolean {
  return lifecycle === 'promotion-candidate';
}
