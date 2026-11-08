'use client';

/**
 * DictationPill — the on-screen voice HUD.
 *
 * This React/inline-style implementation originated in the aqua/Symon
 * application, which o8's operator acquired and owns outright. It adapts the
 * original dictation overlay to o8: the glass pill, the colorful EQ wave-bar,
 * the live partial transcript tail (lead/fresh word split + blinking cursor),
 * the audio level meter, and the squiggle "polishing" loader. Its visual design
 * (colors, gradients, geometry, and motion) comes from these owned Svelte
 * components:
 *   - Pill.svelte            (container shape + per-state glow + layers)
 *   - SymonPillWaveform.svelte (centered-bulge gaussian EQ canvas)
 *   - SquiggleLoader.svelte   (dash-animated wave path)
 *
 * NOTE (operator directive): the literal color values below mirror Symon's
 * palette exactly and are a documented TEMPORARY exception to the
 * "theme tokens, never raw rgba" rule. We reconcile to var(--t-*) later.
 * Keeping the literals here is how we preserve Symon's exact LOOK while
 * obeying the inline-styles-only rule (no CSS classes).
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from '../lucide-shims';
import type { DictationSnapshot, DictationState } from './types';
import { SYMON_GRADIENT_STOPS, SYMON_POLISH_PATH, SYMON_WAVEFORM } from './SymonVisuals';

const UI_FONT = 'var(--font-sans-system)';
const MONO_STACK = "'iA Writer Mono', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace";
const subscribeToMountedState = () => () => {};
const getMountedSnapshot = () => true;
const getServerMountedSnapshot = () => false;

// ── Symon brand gradient (cyan → periwinkle → pink → gold) ──
// Verbatim from SymonPillWaveform.svelte / SquiggleLoader.svelte.
const GRADIENT_STOPS = SYMON_GRADIENT_STOPS;

// ── EQ canvas geometry — Symon's SymonPillWaveform.svelte values ──
const { barCount: BAR_COUNT, barWidth: BAR_WIDTH, barGap: BAR_GAP, width: INNER_W, height: INNER_H, weights: WEIGHTS } = SYMON_WAVEFORM;

// EQ ink emphasis — the speaking/listening "hot" state vs the resting "cool"
// one, applied as canvas alpha inside the draw loop.
const EQ_EMPHASIS_HOT = 1;
const EQ_EMPHASIS_COOL = 0.86;

// ── Symon notch idle sliver (from the owned NotchSurface.svelte `.ndock--idle`) ──
// The compact always-on idle capsule the screen dock paints at the top of the
// screen when nothing is happening: a 128×16 brand-gradient sliver. Literal
// Symon colors (documented temporary exception, see file header).
const SYMON_IDLE_GRADIENT = 'linear-gradient(100deg, #aecdff 0%, #d7c2f1 46%, #f7d9bf 100%)';

function formatTimer(durationMs: number): string {
  const total = Math.max(0, Math.floor(durationMs / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function stateLabel(state: DictationState, error: string | null): string | null {
  if (state === 'transcribing') return 'Transcribing';
  if (state === 'polishing') return 'Polishing';
  if (state === 'success') return 'Pasted';
  if (state === 'error') return error ?? 'Mic error';
  return null;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

interface DictationPillProps {
  snapshot: DictationSnapshot;
  onCancel: () => void;
  /** Element to anchor the pill above. */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Override anchor: explicit (left, bottom) px from viewport bottom-left. */
  position?: { left: number; bottom: number };
}

interface DictationPillViewProps {
  snapshot: DictationSnapshot;
  onCancel: () => void;
  /** Hide the cancel (X) button — the screen dock pill is not interactive. */
  hideCancel?: boolean;
  /**
   * Always-on dock mode: when the state is idle, render a compact Symon idle
   * CAPSULE (the 128×16 top-of-screen sliver) instead of rendering nothing.
   * The screen dock window (`/dictation-pill`) is ALWAYS-ON and must paint
   * something at all times, morphing idle → recording → polishing → success →
   * idle. The IN-WINDOW pill does NOT pass this — its idle-hides behavior is
   * unchanged.
   */
  persistentIdle?: boolean;
}

interface AnchorPos { left: number; bottom: number }

/**
 * SymonWaveCanvas — the centered-bulge gaussian EQ, adapted from the owned
 * SymonPillWaveform.svelte. Drives off the live audio level + an ambient
 * shimmer so it's never dead-flat while listening.
 */
function SymonWaveCanvas({
  visible,
  speaking,
  listening,
  levelRef,
  reducedRef,
}: {
  visible: boolean;
  speaking: boolean;
  listening: boolean;
  levelRef: React.RefObject<number>;
  reducedRef: React.RefObject<number>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentLevelsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  const targetLevelsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));
  // Hot/cool emphasis, eased inside the draw loop — it used to be a CSS
  // `filter: saturate()/brightness()` transition, which is paint (motion
  // audit 009). Canvas ink carries it now, so the toggle costs nothing.
  const emphasisRef = useRef(EQ_EMPHASIS_COOL);
  const rafRef = useRef<number | null>(null);
  const speakingRef = useRef(speaking);
  const listeningRef = useRef(listening);
  useEffect(() => { speakingRef.current = speaking; }, [speaking]);
  useEffect(() => { listeningRef.current = listening; }, [listening]);

  useEffect(() => {
    if (!visible) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      currentLevelsRef.current = new Array(BAR_COUNT).fill(0);
      targetLevelsRef.current = new Array(BAR_COUNT).fill(0);
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = (now: number) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== INNER_W * dpr || canvas.height !== INNER_H * dpr) {
        canvas.width = INNER_W * dpr;
        canvas.height = INNER_H * dpr;
        canvas.style.width = `${INNER_W}px`;
        canvas.style.height = `${INNER_H}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, INNER_W, INNER_H);

      const t = now / 1000;
      const isSpeaking = speakingRef.current;
      const isListening = listeningRef.current;
      const lvl = (levelRef.current ?? 0) * (reducedRef.current ?? 1);
      const ambientBase = isSpeaking ? 0.22 : isListening ? 0.18 : 0.12;

      const target = targetLevelsRef.current;
      const current = currentLevelsRef.current;

      for (let i = 0; i < BAR_COUNT; i++) {
        const phase = i * 0.42;
        const ambient = ambientBase + 0.08 * Math.sin(t * (isSpeaking ? 6 : 2.2) + phase);
        const level = Math.max(0, Math.min(1, lvl));
        const driven = (isSpeaking || isListening) ? level : 0;
        const amp = Math.max(ambient, driven * WEIGHTS[i]) + driven * 0.08 * Math.sin(t * 12 + phase);
        target[i] = Math.max(0.04, Math.min(1, amp));
      }

      const smoothing = isSpeaking ? 0.36 : 0.22;
      const g = ctx.createLinearGradient(0, 0, INNER_W, 0);
      for (const [stop, color] of GRADIENT_STOPS) g.addColorStop(stop, color);
      ctx.fillStyle = g;
      emphasisRef.current = lerp(
        emphasisRef.current,
        (isSpeaking || isListening) ? EQ_EMPHASIS_HOT : EQ_EMPHASIS_COOL,
        0.12,
      );
      ctx.globalAlpha = emphasisRef.current;

      for (let i = 0; i < BAR_COUNT; i++) {
        current[i] = lerp(current[i], target[i], smoothing);
        const barH = Math.max(2, current[i] * INNER_H);
        const x = i * (BAR_WIDTH + BAR_GAP);
        const y = (INNER_H - barH) / 2;
        const r = Math.min(BAR_WIDTH / 2, barH / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + BAR_WIDTH - r, y);
        ctx.quadraticCurveTo(x + BAR_WIDTH, y, x + BAR_WIDTH, y + r);
        ctx.lineTo(x + BAR_WIDTH, y + barH - r);
        ctx.quadraticCurveTo(x + BAR_WIDTH, y + barH, x + BAR_WIDTH - r, y + barH);
        ctx.lineTo(x + r, y + barH);
        ctx.quadraticCurveTo(x, y + barH, x, y + barH - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [visible, levelRef, reducedRef]);

  return (
    <canvas
      ref={canvasRef}
      width={INNER_W}
      height={INNER_H}
      style={{
        width: INNER_W,
        height: INNER_H,
        display: 'block',
        flexShrink: 0,
        opacity: visible ? 1 : 0.9,
        transition: 'opacity 180ms ease',
      }}
      aria-hidden="true"
    />
  );
}

/**
 * SquiggleLoader — adapted from the owned SquiggleLoader.svelte. Dash-animated
 * wave path stroked with the Symon brand gradient. Used for transcribing/polishing.
 */
const SQUIGGLE_PATH = SYMON_POLISH_PATH;

function SquiggleLoader({ label }: { label: string }) {
  return (
    <div
      aria-label={label}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 176, height: 32, overflow: 'hidden' }}
    >
      <svg
        viewBox="0 0 416 52"
        preserveAspectRatio="xMidYMid meet"
        style={{ display: 'block', width: 176, height: 32 }}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="o8-dict-squiggle" x1="0%" y1="50%" x2="100%" y2="50%">
            <stop offset="0%" stopColor="#88D1F1" />
            <stop offset="34%" stopColor="#B1B4E5" />
            <stop offset="72%" stopColor="#F5B8C4" />
            <stop offset="100%" stopColor="#F4C977" />
          </linearGradient>
        </defs>
        <path
          d={SQUIGGLE_PATH}
          pathLength={100}
          fill="none"
          stroke="rgba(255, 255, 255, 0.09)"
          strokeWidth={12}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d={SQUIGGLE_PATH}
          pathLength={100}
          fill="none"
          stroke="url(#o8-dict-squiggle)"
          strokeWidth={12}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            strokeDasharray: '36 64',
            strokeDashoffset: 0,
            filter: 'drop-shadow(0 0 10px rgba(177, 180, 229, 0.24))',
            animation: 'o8DictSquiggle 2.1s ease-in-out infinite alternate',
          }}
        />
      </svg>
    </div>
  );
}

/**
 * The recorder sends levels on a dBFS meter (-50..-10 dBFS onto 0..1), so
 * 0.25 is about -40 dBFS: quiet speech counts, a quiet room doesn't.
 */
export const SPEAKING_LEVEL = 0.25;

export function speakingAt(level: number): boolean {
  return level > SPEAKING_LEVEL;
}

/**
 * DictationPillView — the presentational pill (glass shell + EQ canvas +
 * squiggle loader + state body). Position-agnostic: it renders the morphing
 * pill at its natural size with NO outer positioning. Both surfaces share it:
 *   - the in-window `DictationPill` wraps it in a `position: fixed` portal,
 *     bottom-anchored above the active composer.
 *   - the screen dock route (`/dictation-pill`) centers it inside its own
 *     always-on-top transparent window — the WINDOW provides the position.
 *
 * Self-driving: it computes its own per-state width, glow, glass, and body
 * and animates the morph with framer-motion. Idle → renders nothing UNLESS
 * `persistentIdle` is set (always-on dock), in which case idle renders the
 * compact Symon idle capsule and the morph runs idle ↔ recording ↔ … ↔ idle.
 */
export function DictationPillView({ snapshot, onCancel, hideCancel, persistentIdle }: DictationPillViewProps) {
  const { state, audioLevel, durationMs, error, partialTranscript } = snapshot;
  const visible = state !== 'idle';

  // Live refs for the canvas RAF loop (avoid re-running the effect per frame).
  const levelRef = useRef<number>(audioLevel);
  const reducedRef = useRef<number>(1);
  useEffect(() => { levelRef.current = audioLevel; }, [audioLevel]);
  useEffect(() => {
    reducedRef.current = (state === 'transcribing' || state === 'polishing') ? 0.4 : 1;
  }, [state]);

  const trimmedPartial = partialTranscript.trim();
  const isRecording = state === 'recording' || state === 'requesting-mic';
  const isBusy = state === 'transcribing' || state === 'polishing';
  const isError = state === 'error';
  const isSuccess = state === 'success';
  const speaking = speakingAt(audioLevel);

  // Symon's container width per state. Recording with a transcript tail
  // widens (matching Pill.svelte's listening footprint that grows for words),
  // everything else holds the compact 280 footprint Symon uses for
  // idle/listening/polishing.
  const pillWidth = useMemo(() => {
    if (isError) return 460;
    if (isRecording && trimmedPartial.length > 0) {
      const estimated = 200 + Math.min(360, trimmedPartial.length * 7);
      return Math.max(360, Math.min(620, Math.round(estimated / 8) * 8));
    }
    return 280;
  }, [isError, isRecording, trimmedPartial]);

  const label = useMemo(() => stateLabel(state, error), [state, error]);

  // ── Per-state glow / border tint (from the owned Pill.svelte) ──
  const glow = isError
    ? { border: '#ef4444', shadow: '0 0 0 1px rgba(239, 68, 68, 0.18), 0 16px 40px rgba(239, 68, 68, 0.22)' }
    : isSuccess
      ? { border: 'rgba(52, 211, 153, 0.34)', shadow: '0 0 0 1px rgba(52, 211, 153, 0.12), 0 10px 28px rgba(5, 150, 105, 0.14)' }
      : isBusy
        ? { border: 'rgba(196, 181, 253, 0.34)', shadow: '0 0 0 1px rgba(196, 181, 253, 0.08), 0 14px 30px rgba(177, 180, 229, 0.12)' }
        : isRecording
          ? { border: 'rgba(125, 211, 252, 0.40)', shadow: '0 0 0 1px rgba(125, 211, 252, 0.08), 0 16px 34px rgba(125, 211, 252, 0.10)' }
          : { border: 'rgba(255, 255, 255, 0.34)', shadow: '0 16px 34px rgba(15, 23, 42, 0.18)' };

  // Symon's glass — translucent white film + inset top highlight. Literal
  // values preserved (documented temporary exception, see file header).
  const glassBackground = isError
    ? 'rgba(239, 68, 68, 0.08)'
    : 'linear-gradient(180deg, rgba(255,255,255,0.22), rgba(255,255,255,0.08)), var(--t-panel-solid, rgba(255,255,255,0.10))';

  const cancelButton = hideCancel ? null : (
    <button
      type="button"
      onClick={onCancel}
      aria-label="Cancel dictation"
      style={{
        width: 22,
        height: 22,
        borderRadius: 9999,
        borderWidth: 0,
        background: 'transparent',
        color: 'var(--t-text-muted)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        flexShrink: 0,
        padding: 0,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.14)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <X size={12} />
    </button>
  );

  // ── Body per state ──
  let body: React.ReactNode;
  if (isRecording) {
    // Recording: EQ wave canvas on the left, then either the live transcript
    // tail (lead faded + fresh bright + blinking cursor — Symon's exact word
    // split) or a "Listening…" placeholder, then the timer + cancel.
    const tokens = trimmedPartial.split(/\s+/).filter(Boolean);
    const recentCount = tokens.length > 6 ? 4 : Math.min(2, tokens.length);
    const leadText = tokens.slice(0, Math.max(0, tokens.length - recentCount)).join(' ');
    const freshText = tokens.slice(Math.max(0, tokens.length - recentCount)).join(' ');
    body = (
      <>
        <SymonWaveCanvas
          visible={visible}
          speaking={speaking}
          listening
          levelRef={levelRef}
          reducedRef={reducedRef}
        />
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
          }}
          title={trimmedPartial}
        >
          {trimmedPartial ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'baseline',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                fontSize: 12.5,
                lineHeight: 1.3,
                letterSpacing: '0.01em',
                fontWeight: 500,
                color: 'var(--t-text)',
                direction: 'rtl', // keep the freshest words pinned in view
              }}
            >
              <span style={{ direction: 'ltr', display: 'inline-flex', alignItems: 'baseline' }}>
                {leadText && (
                  <span style={{ opacity: 0.5, marginRight: 4 }}>{leadText}</span>
                )}
                <span style={{ opacity: 0.95 }}>{freshText}</span>
                <span
                  aria-hidden
                  style={{
                    display: 'inline-block',
                    width: 1,
                    height: 11,
                    marginLeft: 3,
                    alignSelf: 'center',
                    background: 'var(--t-text)',
                    animation: 'o8DictBlink 1s steps(2, start) infinite',
                  }}
                />
              </span>
            </span>
          ) : (
            <span style={{ fontSize: 12.5, color: 'var(--t-text-muted)', opacity: 0.7, letterSpacing: '0.01em' }}>
              Listening…
            </span>
          )}
        </div>
        <span
          style={{
            fontFamily: MONO_STACK,
            fontSize: 11,
            color: 'var(--t-text-muted)',
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}
        >
          {formatTimer(durationMs)}
        </span>
        {cancelButton}
      </>
    );
  } else if (isBusy) {
    // Transcribing / polishing: the squiggle loader + a soft label.
    body = (
      <>
        <SquiggleLoader label={label ?? 'Polishing'} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: 'left',
            fontSize: 12.5,
            fontWeight: 500,
            color: 'var(--t-text-muted)',
            letterSpacing: '0.02em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {label ?? ''}
        </span>
        {cancelButton}
      </>
    );
  } else {
    // Success / error: centered label.
    body = (
      <>
        <span
          aria-hidden
          style={{
            width: 10,
            height: 10,
            borderRadius: 9999,
            background: isError ? '#ef4444' : 'rgba(52, 211, 153, 0.95)',
            flexShrink: 0,
          }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: 'center',
            fontSize: isError ? 12 : 12.5,
            fontWeight: isError ? 500 : 500,
            color: isError ? '#ef4444' : 'var(--t-text)',
            letterSpacing: '-0.005em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            paddingRight: 12,
          }}
          title={label ?? ''}
        >
          {label ?? ''}
        </span>
        {cancelButton}
      </>
    );
  }

  // Always-on dock idle capsule: the compact Symon notch sliver. Painted only
  // when idle AND persistentIdle (the screen dock). It morphs out as the full
  // pill morphs in (shared AnimatePresence) when a recording starts.
  const idleCapsule = persistentIdle && !visible ? (
    <motion.div
      key="dock-idle"
      role="status"
      aria-label="Voice idle"
      initial={{ opacity: 0, y: -6, scale: 0.92 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.92 }}
      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
      style={{
        width: 128,
        height: 16,
        borderRadius: '0 0 14px 14px',
        background: SYMON_IDLE_GRADIENT,
        borderWidth: 1,
        borderStyle: 'solid',
        borderColor: 'rgba(255, 255, 255, 0.45)',
        borderTopWidth: 0,
        boxShadow: '0 6px 20px rgba(0, 0, 0, 0.28), inset 0 -2px 6px rgba(120, 110, 160, 0.22)',
        backdropFilter: 'blur(10px) saturate(160%)',
        WebkitBackdropFilter: 'blur(10px) saturate(160%)',
        userSelect: 'none',
        pointerEvents: 'none',
      } as React.CSSProperties}
    />
  ) : null;

  // Natural-size pill: no outer positioning. The caller decides where it lives
  // (fixed portal for the in-window path, centered window for the screen dock).
  return (
    <AnimatePresence>
      {idleCapsule}
      {visible && (
        <motion.div
          key="dock-active"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: 10, scale: 0.96 }}
          animate={{ opacity: 1, y: isRecording || isBusy ? -2 : 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          style={{
            width: pillWidth,
            height: 58,
            borderRadius: 29,
            background: glassBackground,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: glow.border,
            boxShadow: `inset 0 1px 0 rgba(255,255,255,0.28), ${glow.shadow}`,
            paddingTop: 6,
            paddingRight: 8,
            paddingBottom: 6,
            paddingLeft: 16,
            backdropFilter: 'blur(18px) saturate(1.4)',
            WebkitBackdropFilter: 'blur(18px) saturate(1.4)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontFamily: UI_FONT,
            userSelect: 'none',
            overflow: 'hidden',
            // Width is NOT transitioned (motion audit 005): `pillWidth` is
            // recomputed on every partial-transcript token, so a width tween
            // restarts mid-flight per token and relayouts the HUD each frame.
            // The width already snaps in 8px steps, which reads as growth.
            transition: 'border-color 120ms ease, box-shadow 120ms ease',
          } as React.CSSProperties}
        >
          {body}
          <style>{
            '@keyframes o8DictBlink { 50% { opacity: 0; } }'
            + ' @keyframes o8DictSquiggle { 0% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: -64; } }'
          }</style>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * DictationPill — the in-window HUD. Anchors `DictationPillView` above the
 * active composer (or bottom-center fallback) via a `position: fixed` portal.
 * Unchanged behavior from before the view extraction.
 */
export function DictationPill({ snapshot, onCancel, anchorRef, position }: DictationPillProps) {
  const { state, partialTranscript } = snapshot;
  const visible = state !== 'idle';

  const trimmedPartial = partialTranscript.trim();
  const isRecording = state === 'recording' || state === 'requesting-mic';
  const isError = state === 'error';

  // Match the view's per-state width so the anchor math centers correctly.
  const pillWidth = useMemo(() => {
    if (isError) return 460;
    if (isRecording && trimmedPartial.length > 0) {
      const estimated = 200 + Math.min(360, trimmedPartial.length * 7);
      return Math.max(360, Math.min(620, Math.round(estimated / 8) * 8));
    }
    return 280;
  }, [isError, isRecording, trimmedPartial]);

  const [anchor, setAnchor] = useState<AnchorPos | null>(null);

  // SSR-safe portal gate. `typeof document` alone is the anti-pattern React
  // warns about — it's false on the server but TRUE on the client's first
  // (hydration) render, so the portal node appears where the server rendered
  // nothing → hydration mismatch. A mounted flag is false on the server AND
  // the first client render, then flips post-mount. The pill is idle/invisible
  // until a mic click (long after mount), so the one-tick defer is invisible.
  const mounted = useSyncExternalStore(
    subscribeToMountedState,
    getMountedSnapshot,
    getServerMountedSnapshot,
  );

  // Anchor: above the active composer, else bottom-center (Symon docks the
  // pill at bottom-center of its own window).
  useEffect(() => {
    if (!visible) {
      setAnchor(null);
      return;
    }
    if (position) {
      setAnchor(position);
      return;
    }
    const compute = () => {
      const el = anchorRef?.current;
      if (!el) {
        setAnchor({
          left: Math.max(8, Math.floor((window.innerWidth - pillWidth) / 2)),
          bottom: 24,
        });
        return;
      }
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const left = Math.min(
        Math.max(8, Math.floor(centerX - pillWidth / 2)),
        Math.max(8, window.innerWidth - pillWidth - 8),
      );
      const bottom = Math.max(8, window.innerHeight - rect.top + 8);
      setAnchor({ left, bottom });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [visible, anchorRef, position, pillWidth]);

  if (!mounted) return null;

  const pillNode = (
    <div
      style={{
        position: 'fixed',
        left: anchor?.left ?? 0,
        bottom: anchor?.bottom ?? 0,
        zIndex: 2147483600,
        pointerEvents: anchor ? 'auto' : 'none',
        opacity: anchor ? 1 : 0,
      }}
    >
      <DictationPillView snapshot={snapshot} onCancel={onCancel} />
    </div>
  );

  return createPortal(pillNode, document.body);
}
