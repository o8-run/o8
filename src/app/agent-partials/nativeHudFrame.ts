import { IDLE_SNAPSHOT, type NativeDockSnapshot, type NativeHudDetail } from '@/app/dictation-pill/useNativeDictationPill';

export type Phase = 'starting' | 'listening' | 'transcribing' | 'polishing' | 'final' | 'error';
export type PartialsSurface = 'caret' | 'hud';

export interface HudState {
  phase: Phase;
  level: number;
  agent: boolean;
  text: string;
  clipboardOnly: boolean;
  surface: PartialsSurface;
  mode: 'dictation' | 'smart-compose';
}

/** The classic shell's anchor for this window, top-left desktop points. */
export type HudPlacement = NonNullable<NativeHudDetail['placement']> & { surface: PartialsSurface };

/** The header label, shared by the web and native HUD. */
export function hudTitle(state: HudState): string {
  return `Symon · ${state.phase === 'starting' ? 'Starting'
    : state.phase === 'listening' ? 'Listening'
    : state.phase === 'transcribing' ? 'Transcribing'
      : state.phase === 'polishing' ? (state.mode === 'smart-compose' ? 'Composing' : 'Polishing')
        : state.phase === 'error' ? 'Dictation stopped' : state.agent ? 'Sent to agent' : state.clipboardOnly ? 'Copied' : 'Pasted'}`;
}

/** The transcript line, or its placeholder while no words have arrived. */
export function hudDisplay(state: HudState): string {
  return state.text || (state.phase === 'starting' ? 'Starting microphone…'
    : state.phase === 'listening' ? 'Listening' : 'Finishing dictation…');
}

const STATES: Record<Phase, NativeDockSnapshot['state']> = {
  starting: 'requesting-mic', listening: 'recording', transcribing: 'transcribing', polishing: 'polishing', final: 'success', error: 'error',
};
/** The native panel shows only the newest words, as the web pins its scroll to the bottom. */
const TAIL = 600;

/** Whether the HUD has something to show: a session that no composer claims, past its paint grace. */
export function hudShown(state: HudState | null, claimed: boolean, graceElapsed: boolean): state is HudState {
  return state !== null && !claimed && graceElapsed;
}

/** Exactly one surface draws: the web paints only while the native panel does not own the HUD. */
export function webHudPaints(state: HudState | null, claimed: boolean, graceElapsed: boolean, native: boolean): boolean {
  return hudShown(state, claimed, graceElapsed) && !native;
}

/** The frame the native HUD draws. A claimed, graced or finished session is idle, which releases the panel. */
export function nativeHudFrame(input: {
  state: HudState | null; claimed: boolean; graceElapsed: boolean; elapsedSeconds: number;
  solid: boolean; reducedMotion: boolean; placement: HudPlacement | null;
}): NativeDockSnapshot {
  const { state } = input;
  if (!hudShown(state, input.claimed, input.graceElapsed)) return IDLE_SNAPSHOT;
  const display = hudDisplay(state);
  const chars = Array.from(display);
  const placement = input.placement?.surface === state.surface ? input.placement : null;
  return {
    ...IDLE_SNAPSHOT,
    state: STATES[state.phase],
    audioLevel: state.phase === 'listening' ? state.level : 0,
    durationMs: Math.max(0, input.elapsedSeconds) * 1000,
    hud: {
      surface: state.surface,
      title: hudTitle(state),
      text: chars.length > TAIL ? chars.slice(-TAIL).join('') : display,
      dim: !state.text,
      solid: input.solid,
      reducedMotion: input.reducedMotion,
      ...(placement ? { placement: { x: placement.x, y: placement.y, width: placement.width, height: placement.height } } : {}),
    },
  };
}

/** Accept only a finite, positive placement from the classic shell. */
export function readPlacement(payload: unknown): HudPlacement | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  const surface = value.surface === 'hud' ? 'hud' : value.surface === 'caret' ? 'caret' : null;
  const numbers = [value.x, value.y, value.width, value.height];
  if (!surface || !numbers.every(n => typeof n === 'number' && Number.isFinite(n))) return null;
  const [x, y, width, height] = numbers as number[];
  if (width <= 0 || height <= 0) return null;
  return { surface, x, y, width, height };
}
