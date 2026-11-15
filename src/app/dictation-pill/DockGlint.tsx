import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanProgressGlint } from '@/components/desktop/dictation/planPresentation';

/** A glint with its fade start and end (epoch ms), so the native panel can fade it too. */
export type TimedGlint = PlanProgressGlint & { fadeAt: number; until: number };
const GLINT_FADE_AT_MS = 4200;
const GLINT_GONE_MS = 4800;

/** Memory glint (dossier #4): a quiet one-line chip under the dock that fades
 * in, holds ~4s, fades out. Driven by `kind: glint` agent events. */
export function useDockGlint() {
  const [glint, setGlint] = useState<TimedGlint | null>(null);
  const [fading, setFading] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const showGlint = useCallback((
    text: string,
    options: { key?: string; tone?: PlanProgressGlint['tone'] } = {},
  ) => {
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
    const now = Date.now();
    setGlint({
      key: options.key ?? 'ambient',
      text,
      tone: options.tone ?? 'progress',
      fadeAt: now + GLINT_FADE_AT_MS,
      until: now + GLINT_GONE_MS,
    });
    setFading(false);
    timersRef.current.push(setTimeout(() => setFading(true), GLINT_FADE_AT_MS));
    timersRef.current.push(setTimeout(() => { setGlint(null); setFading(false); }, GLINT_GONE_MS));
  }, []);
  useEffect(() => {
    return () => { for (const t of timersRef.current) clearTimeout(t); };
  }, []);
  return { glint, fading, showGlint };
}

interface DockGlintProps {
  glint: PlanProgressGlint;
  fading: boolean;
  /** Set only by the native dock wiring when the native panel hands a glint it
   * was drawing back to the web: it is already shown, so no fade-in. */
  handedBack?: boolean;
}

/** Quiet, pointer-transparent lifecycle chip below the dock. */
export function DockGlint({ glint, fading, handedBack = false }: DockGlintProps) {
  return (
    <div
      style={{
        marginTop: 6,
        paddingTop: 3,
        paddingBottom: 3,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 9,
        background: 'linear-gradient(#14182299, #0e121c8a)',
        border: glint.tone === 'error'
          ? '1px solid #ff78785c'
          : glint.tone === 'warning'
            ? '1px solid #f4c97752'
            : glint.tone === 'success'
              ? '1px solid #69e0ad47'
              : '1px solid #ffffff24',
        fontSize: 9.5,
        fontWeight: 260,
        letterSpacing: '0.5px',
        textTransform: 'uppercase',
        color: glint.tone === 'error'
          ? '#ffc4c4eb'
          : glint.tone === 'warning'
            ? '#fadea8e6'
            : glint.tone === 'success'
              ? '#b7f4d8e6'
              : '#ffffffd1',
        textShadow: '0 1px 4px #00000059',
        whiteSpace: 'nowrap',
        opacity: fading ? 0 : 1,
        transition: 'opacity 0.5s ease',
        animation: handedBack ? 'none' : 'o8GlintIn 0.3s cubic-bezier(0.22, 1, 0.36, 1)',
        pointerEvents: 'none',
      }}
    >
      {glint.text}
      <style>{'@keyframes o8GlintIn { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }'}</style>
    </div>
  );
}
