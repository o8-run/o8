'use client';

/**
 * Native caret-local dictation feedback (or the saved legacy HUD placement).
 * One surface owns capture, measured levels, processing, delivered text and
 * dismissal. Agent dictation can yield to an in-canvas composer claim.
 * This transparent, nonactivating window never changes the paste target.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { isTauri } from '@/lib/tauri/bridge';
import { SystemDictationSession } from '@/lib/dictation/system-dictation-session';
import { SymonMark, SymonPolishMark, SymonWaveform } from '@/components/desktop/dictation/SymonVisuals';
import { useNativeDictationPill } from '@/app/dictation-pill/useNativeDictationPill';
import {
  hudDisplay, hudTitle, nativeHudFrame, readPlacement, webHudPaints,
  type HudPlacement, type HudState, type PartialsSurface, type Phase,
} from './nativeHudFrame';

export const dynamic = 'force-dynamic';

// System font stack (hurttlocker: never webfont-locked). SF Pro renders the
// light weights as true thins on macOS, where this HUD lives.
const FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, system-ui, sans-serif';

// Recognizer complete/ready precede delivery and must not dismiss processing.
const TERMINAL = new Set(['system-idle', 'error', 'system-pasted']);

// Keep the last text visible for a beat before the exit fade, so the final /
// polished command reads "briefly" (the agent flow emits system-idle right after
// polished, so without this hold the final text would never be seen).
const DISMISS_DELAY_MS = 900;
// Defensive auto-clear if a terminal event is somehow missed — never strand a
// black bar on screen.
const SAFETY_MS = 60_000;
/** Delay before the FIRST paint of a session — gives an in-canvas surface claim
 *  time to land so the HUD never flashes over a composer that owns the partials. */
const PAINT_GRACE_MS = 300;
const DICTATION_PAINT_GRACE_MS = 32;

// Symon surfaces honor the app's Glass vs Solid appearance (the
// reduce-transparency axis). This floating HUD lives at the SAME origin as the
// main window (http://127.0.0.1:<port>), so it reads the very localStorage the
// ThemeProvider writes — no second appearance system. Palette-independent by
// design: a dark chip reads over any app in both light and dark (matching the
// dock), so only the glass↔solid MATERIAL flips, never the geometry. Mirrors
// ThemeProvider.resolveSurface: reduce-transparency 'on' → solid, 'off'/'system'
// → glass; a truly fresh install (no theme pref at all) defaults to solid.
type AppSurface = 'glass' | 'solid';
function readAppSurface(): AppSurface {
  if (typeof window === 'undefined') return 'glass';
  try {
    const pref = localStorage.getItem('cortex-reduce-transparency');
    if (pref === 'on') return 'solid';
    if (pref === 'off' || pref === 'system') return 'glass';
    const hasThemePref =
      localStorage.getItem('cortex-theme-palette') !== null ||
      localStorage.getItem('cortex-theme') !== null;
    return hasThemePref ? 'glass' : 'solid';
  } catch {
    return 'glass';
  }
}

interface SttPayload {
  type?: string;
  origin?: string;
  lane?: string;
  sessionId?: number;
  startId?: string;
  level?: number;
  text?: string;
  clipboardOnly?: boolean;
  // Plain Fn dictation carries no lane. The Rust side tags visible partials with
  // `hud: true` and names the selected surface; new installs default to the
  // cursor-local surface while the legacy screen bar remains selectable.
  hud?: boolean;
  surface?: 'caret' | 'hud' | 'off';
  mode?: 'dictation' | 'smart-compose';
}

/** The HUD has no click-to-finish; the native panel is click-through. */
const noop = () => undefined;

export default function AgentPartialsPage() {
  const prefersReducedMotion = useReducedMotion();
  const [state, setState] = useState<HudState | null>(null);
  // App appearance (glass/solid). Read once from the shared theme localStorage,
  // refreshed on the cross-window `storage` event and on each activation so a
  // mid-session appearance change is honored.
  const [appSurface, setAppSurface] = useState<AppSurface>(() => readAppSurface());
  // While the in-canvas composer owns the partials (Right-Option dictation with
  // o8 focused + the canvas visible), it claims the surface via
  // `o8:agent-partials-claim` and THIS HUD stops painting — single-surface rule,
  // no doubles. Tied to a session id; auto-expires on release or the 60s safety.
  const [suppressed, setSuppressed] = useState(false);
  const [graceElapsed, setGraceElapsed] = useState(false);
  // Session-elapsed seconds — the honest "still recording" signal on long
  // holds (operator ask 2026-07-13: a long dictation gave no cue the capture
  // was alive). Rendered in the header from 10s so quick dictations stay clean.
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const sessionStartedAtRef = useRef<number | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const claimSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentActiveRef = useRef(false);
  const sessionRef = useRef(new SystemDictationSession());
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Native drawing (experimental native_dictation_hud): the classic shell's
  // anchor for this window, and a session number per activation.
  const [placement, setPlacement] = useState<HudPlacement | null>(null);
  const [hudSession, setHudSession] = useState(0);

  // Keep the material in sync with the app's Glass/Solid preference. The main
  // window writes the theme keys; `storage` fires here (a different document),
  // so the HUD flips glass↔solid without its own theme system.
  useEffect(() => {
    const sync = () => setAppSurface(readAppSurface());
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  // The window is transparent at the OS level; the page html/body must NOT paint
  // a background or the window shows a solid rectangle instead of just the bar.
  useEffect(() => {
    const prevHtmlBg = document.documentElement.style.background;
    const prevBodyBg = document.body.style.background;
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return () => {
      document.documentElement.style.background = prevHtmlBg;
      document.body.style.background = prevBodyBg;
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const clearDismiss = () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
    };
    const clearSafety = () => {
      if (safetyTimerRef.current) {
        clearTimeout(safetyTimerRef.current);
        safetyTimerRef.current = null;
      }
    };
    const teardown = (delay = DISMISS_DELAY_MS) => {
      agentActiveRef.current = false;
      sessionRef.current.finish();
      clearSafety();
      clearDismiss();
      // Hold the last text a beat, then unmount → exit animation plays.
      dismissTimerRef.current = setTimeout(() => {
        dismissTimerRef.current = null;
        setState(null);
      }, delay);
    };
    const activate = (
      surface: PartialsSurface,
      mode: 'dictation' | 'smart-compose',
      agent: boolean,
    ) => {
      agentActiveRef.current = true;
      setAppSurface(readAppSurface());
      clearDismiss();
      clearSafety();
      safetyTimerRef.current = setTimeout(() => teardown(), SAFETY_MS);
      // PAINT GRACE (2026-07-08 live-hit): the canvas composer's surface CLAIM
      // races this system-start — both fan out from the same keypress, and the
      // claim can land a beat late (or get missed by the broadcast entirely; a
      // Rust relay now also forwards it directly). Hold the first paint ~300ms
      // so a claiming canvas means this HUD never flashes an empty bar over it.
      setGraceElapsed(false);
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
      graceTimerRef.current = setTimeout(() => {
        graceTimerRef.current = null;
        setGraceElapsed(true);
      }, agent ? PAINT_GRACE_MS : DICTATION_PAINT_GRACE_MS);
      sessionStartedAtRef.current = Date.now();
      setElapsedSeconds(0);
      // The shell anchors this session right after its start event.
      setPlacement(null);
      setHudSession(session => session + 1);
      setState({ phase: 'starting', level: 0, agent, text: '', clipboardOnly: false, surface, mode });
    };
    const showText = (phase: Phase, text: string, clipboardOnly = false) => {
      // A new frame of live text — keep the HUD alive (cancel any pending fade)
      // AND re-arm the stranded-bar safety. The safety exists for a missed
      // terminal event; a live frame is proof the session is NOT stranded.
      // Without this re-arm the HUD tore itself down at exactly SAFETY_MS into
      // a long dictation while the operator was still speaking (live-hit
      // 2026-07-13: "the partials just left and I'm still talking").
      clearDismiss();
      clearSafety();
      safetyTimerRef.current = setTimeout(() => teardown(), SAFETY_MS);
      setState((current) => current && (
        (phase === 'listening' && current.phase !== 'listening' && current.phase !== 'starting')
        || (phase === 'transcribing' && current.phase === 'polishing')
      ) ? current : ({
        phase,
        level: phase === 'listening' ? current?.level ?? 0 : 0,
        agent: current?.agent ?? false,
        text,
        clipboardOnly,
        surface: current?.surface ?? 'caret',
        mode: current?.mode ?? 'dictation',
      }));
    };

    const handle = (p: SttPayload) => {
      const type = p.type;
      // System-origin only (`system-pasted` is system by construction, even if
      // the origin field is absent on some emit paths).
      if (p.origin !== 'system' && type !== 'system-pasted') return;
      if (!sessionRef.current.accepts(p)) return;

      // Activate on an AGENT-lane system-start (Right-Option Symon agent) or a
      // plain Fn system-start tagged `hud: true`. The surface field chooses the
      // cursor-local default or the legacy screen bar.
      if (type === 'system-start') {
        if (p.surface === 'off') return;
        if (p.lane === 'agent' || p.hud === true) {
          activate(
            p.surface === 'hud' ? 'hud' : 'caret',
            p.mode === 'smart-compose' ? 'smart-compose' : 'dictation',
            p.lane === 'agent',
          );
        }
        return;
      }

      // Terminal events ALWAYS tear down, regardless of lane — a no-lane `error`
      // mid-session still clears the latch here.
      if (TERMINAL.has(type ?? '')) {
        if (agentActiveRef.current && type === 'system-pasted') {
          showText('final', p.text ?? '', p.clipboardOnly === true);
        } else if (agentActiveRef.current && type === 'error') {
          showText('error', p.text || 'Dictation failed.');
        } else {
          // A discarded brush or silence must not linger as "Listening".
          setState(null);
        }
        teardown(type === 'error' ? 2500 : DISMISS_DELAY_MS);
        return;
      }

      // Later frames use the start latch; plain Fn frames have no agent lane.
      if (!agentActiveRef.current && p.lane !== 'agent') return;

      const text = (p.text ?? '').trim();
      switch (type) {
        case 'status':
          if (text === 'listening') showText('listening', '');
          break;
        case 'partial':
          showText('listening', text);
          break;
        case 'final':
          showText('transcribing', text);
          break;
        case 'audio_file':
          setState(current => current?.phase === 'listening' || current?.phase === 'starting'
            ? { ...current, phase: 'transcribing', level: 0 } : current);
          break;
        case 'composing':
        case 'polishing':
          setState(current => current ? { ...current, phase: 'polishing', level: 0 } : current);
          break;
        case 'level':
          if (typeof p.level === 'number' && Number.isFinite(p.level)) {
            setState(current => current?.phase === 'listening' || current?.phase === 'starting'
              ? { ...current, phase: 'listening', level: Math.max(0, Math.min(1, p.level!)) } : current);
          }
          break;
        case 'polished':
          // Agent-mode polished command. Show it, then fade — the agent flow
          // emits `system-idle` immediately after, and the fade delay keeps the
          // command readable for a beat either way.
          if (text) showText('final', text);
          teardown();
          break;
        default:
          break;
      }
    };

    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const stt = await listen<SttPayload>('o8:stt-event', (e) => handle(e.payload ?? {}));
        const placed = await listen<unknown>('o8:agent-partials-placement', (e) => {
          const next = readPlacement(e.payload);
          if (next) setPlacement(next);
        });
        return () => { stt(); placed(); };
      })
      .then((un) => {
        if (disposed) {
          un();
          return;
        }
        unlisten = un;
      })
      .catch(() => {
        /* noop — a HUD that can't subscribe simply never paints */
      });

    return () => {
      disposed = true;
      clearDismiss();
      clearSafety();
      if (unlisten) {
        try {
          unlisten();
        } catch {
          /* noop */
        }
        unlisten = null;
      }
    };
  }, []);

  // HUD-yield protocol — listen for the in-canvas composer's surface claim. When
  // claimed, suppress our paint (the composer streams the partials in place); on
  // release, resume. Safety: a dead canvas that never sends `claimed: false`
  // still frees the HUD after SAFETY_MS, so we can never stay dark forever.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const clearClaimSafety = () => {
      if (claimSafetyRef.current) {
        clearTimeout(claimSafetyRef.current);
        claimSafetyRef.current = null;
      }
    };
    const handleClaim = (p: { claimed?: boolean }) => {
      if (p.claimed) {
        setSuppressed(true);
        clearClaimSafety();
        claimSafetyRef.current = setTimeout(() => {
          claimSafetyRef.current = null;
          setSuppressed(false);
        }, SAFETY_MS);
      } else {
        clearClaimSafety();
        setSuppressed(false);
      }
    };

    // Two channels, one handler: the canvas's own broadcast AND the Rust
    // relay's forward. The relay MUST use a DIFFERENT event name — its
    // listen_any hears every emit including its own emit_to, so relaying under
    // the original name recursed Rust-side until the thread's stack blew
    // (2026-07-09 crash, EXC_BAD_ACCESS stack_overflow on tokio-rt-worker).
    let unlistenFwd: (() => void) | null = null;
    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        const direct = await listen<{ claimed?: boolean; sessionId?: string }>(
          'o8:agent-partials-claim',
          (e) => handleClaim(e.payload ?? {}),
        );
        const fwd = await listen<{ claimed?: boolean; sessionId?: string }>(
          'o8:agent-partials-claim-fwd',
          (e) => handleClaim(e.payload ?? {}),
        );
        if (disposed) {
          direct();
          fwd();
          return;
        }
        unlisten = direct;
        unlistenFwd = fwd;
      })
      .catch(() => {
        /* noop — no claim bridge simply means the HUD never yields */
      });

    return () => {
      disposed = true;
      clearClaimSafety();
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
      if (unlisten) {
        try {
          unlisten();
        } catch {
          /* noop */
        }
      }
      if (unlistenFwd) {
        try {
          unlistenFwd();
        } catch {
          /* noop */
        }
      }
    };
  }, []);

  // Pin the transcript to the bottom so the NEWEST words are always visible; the
  // top fades out via the mask. Runs after each text change.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state?.text]);

  // Tick the elapsed counter once a second while listening.
  useEffect(() => {
    if (!state || state.phase !== 'listening') return undefined;
    const tick = () => {
      const startedAt = sessionStartedAtRef.current;
      if (startedAt) setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [state?.phase, state]);

  // With native_dictation_hud on, the native window draws this session and
  // this page paints nothing; a lost acknowledgement hands it straight back.
  const nativeFrame = useMemo(() => nativeHudFrame({
    state, claimed: suppressed, graceElapsed, elapsedSeconds,
    solid: appSurface === 'solid', reducedMotion: prefersReducedMotion === true, placement,
  }), [state, suppressed, graceElapsed, elapsedSeconds, appSurface, prefersReducedMotion, placement]);
  const { native } = useNativeDictationPill(nativeFrame, hudSession, noop, undefined, 'hud');
  const display = state ? hudDisplay(state) : '';
  const rise = prefersReducedMotion ? 0 : 4;
  const caretLocal = state?.surface === 'caret';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: caretLocal ? 'flex-start' : 'flex-end',
        justifyContent: caretLocal ? 'flex-start' : 'center',
        paddingLeft: caretLocal ? 6 : 24,
        paddingRight: caretLocal ? 6 : 24,
        paddingTop: caretLocal ? 6 : 0,
        paddingBottom: 6,
        boxSizing: 'border-box',
        background: 'transparent',
        pointerEvents: 'none',
      }}
    >
      <AnimatePresence>
        {state && webHudPaints(state, suppressed, graceElapsed, native) ? (
          <motion.div
            key={`agent-partials-bar-${state.surface}`}
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: rise }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: rise }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: caretLocal ? 5 : 8,
              width: caretLocal
                ? 'min(420px, calc(100vw - 12px))'
                : 'min(680px, calc(100vw - 56px))',
              maxWidth: '100%',
              boxSizing: 'border-box',
              paddingTop: caretLocal ? 10 : 16,
              paddingBottom: caretLocal ? 10 : 16,
              paddingLeft: caretLocal ? 14 : 26,
              paddingRight: caretLocal ? 14 : 26,
              borderRadius: caretLocal ? 14 : 22,
              // Glass = translucent tint + backdrop blur of the app behind it.
              // Solid (reduce-transparency) = genuinely opaque, NO blur — the
              // vestibular/accessibility path must not float a blurred chip.
              // Dark in both palettes (a dark chip reads over any app), matching
              // the dock. Geometry above is untouched by appearance.
              background: appSurface === 'solid' ? 'rgb(20, 22, 28)' : 'rgba(9, 10, 13, 0.82)',
              backdropFilter: appSurface === 'solid' ? undefined : 'blur(22px) saturate(140%)',
              WebkitBackdropFilter: appSurface === 'solid' ? undefined : 'blur(22px) saturate(140%)',
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'rgba(255, 255, 255, 0.12)',
              boxShadow: caretLocal
                ? '0 10px 30px rgba(0, 0, 0, 0.38), 0 1px 5px rgba(0, 0, 0, 0.32)'
                : '0 18px 60px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.4)',
              fontFamily: FONT,
              pointerEvents: 'none',
            } as React.CSSProperties}
          >
            {/* Compact header — a soft "Listening" tier label + a status dot.
                Kept thin + faint so the transcript is the star. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 }}>
              <SymonMark size={16} active={state.phase === 'listening'} />
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 300,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: 'rgba(255, 255, 255, 0.55)',
                  lineHeight: 1,
                }}
              >
                {hudTitle(state)}
              </span>
              {state.phase === 'listening' ? (
                <span aria-label="Microphone level" style={{ marginLeft: 'auto', display: 'flex' }}>
                  <SymonWaveform level={state.level} width={90} live />
                </span>
              ) : state.phase === 'polishing' || state.phase === 'transcribing' ? (
                <div
                  aria-label={state.phase === 'polishing' ? 'Polishing' : 'Transcribing'}
                  style={{ marginLeft: 'auto', display: 'flex' }}
                >
                  <SymonPolishMark active width={96} />
                </div>
              ) : null}
              {!caretLocal && state.phase === 'listening' && elapsedSeconds >= 10 ? (
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: 10,
                    fontWeight: 300,
                    letterSpacing: '0.04em',
                    color: 'rgba(255, 255, 255, 0.45)',
                    lineHeight: 1,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {`${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, '0')}`}
                </span>
              ) : null}
            </div>

            {/* The partials transcript — big + room-readable. Bottom-anchored so
                the newest words are always visible; older lines clip + fade at
                the top (max ~3 lines). Weight bumped to 400 for legibility on the
                dark HUD (hurttlocker eye-ergonomics lens: legibility over spec). */}
            <div
              ref={scrollRef}
              style={{
                maxHeight: caretLocal ? 48 : 84,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
                WebkitMaskImage: caretLocal
                  ? undefined
                  : 'linear-gradient(to bottom, transparent 0px, black 26px)',
                maskImage: caretLocal
                  ? undefined
                  : 'linear-gradient(to bottom, transparent 0px, black 26px)',
              } as React.CSSProperties}
            >
              <span
                style={{
                  fontSize: caretLocal ? 14 : 19,
                  fontWeight: 400,
                  letterSpacing: '-0.1px',
                  lineHeight: 1.4,
                  color: state.text
                    ? 'rgba(255, 255, 255, 0.97)'
                    : 'rgba(255, 255, 255, 0.62)',
                  textShadow: '0 1px 10px rgba(0, 0, 0, 0.55)',
                  overflowWrap: 'anywhere',
                }}
              >
                {display}
              </span>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
