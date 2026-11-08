'use client';

import { useId } from 'react';
import { useReducedMotion } from 'framer-motion';

// Owned voice identity, shared with the live HUD. This existing brand palette
// is the documented exception to themeable surface colors; chrome uses tokens.
export const SYMON_ORB_BACKGROUND = 'radial-gradient(circle at 64% 28%, color-mix(in srgb, var(--t-text, #ffffff) 90%, transparent), transparent 30%), conic-gradient(from 210deg at 50% 50%, #88d1f1, #b1b4e5 32%, #f5b8c4 62%, #f4c977 82%, #88d1f1)';
export const SYMON_GRADIENT_STOPS: Array<[number, string]> = [
  [0, 'rgba(136, 209, 241, 0.92)'],
  [0.42, 'rgba(177, 180, 229, 0.95)'],
  [0.72, 'rgba(245, 184, 196, 0.92)'],
  [1, 'rgba(244, 201, 119, 0.92)'],
];
const BAR_COUNT = 30;
export const SYMON_WAVEFORM = {
  barCount: BAR_COUNT, barWidth: 2, barGap: 2.5, width: 132.5, height: 24,
  weights: Array.from({ length: BAR_COUNT }, (_, i) => {
    const center = (BAR_COUNT - 1) / 2;
    return Math.exp(-1.8 * (Math.abs(i - center) / center) ** 2);
  }),
};
export const SYMON_POLISH_PATH = 'M8 28C32 22 48 14 72 14C96 14 108 34 132 34C156 34 170 12 198 12C230 12 238 38 272 38C304 38 316 18 344 18C372 18 388 28 408 28';

export function SymonMark({ size = 17, active = false }: { size?: number; active?: boolean }) {
  return <span aria-hidden="true" data-symon-mark="" style={{ display: 'inline-block', flexShrink: 0, width: size, height: size, borderRadius: '50%', background: SYMON_ORB_BACKGROUND, boxShadow: active ? '0 0 0 2px var(--t-accent, #88d1f1), 0 0 9px rgba(136, 209, 241, 0.45)' : '0 0 9px rgba(136, 209, 241, 0.45)' }} />;
}

/**
 * Bar height for a measured level. Native levels are on a dBFS meter
 * (-50..-10 dBFS onto 0..1). A gain of 1.4 puts ordinary speech mid-height
 * and reaches full height only near -21 dBFS, so loud syllables stand out
 * without opening another microphone or inventing ambient bars.
 */
export const LIVE_GAIN = 1.4;

export function liveAmplitude(level: number): number {
  return Math.min(1, Math.max(0, level) * LIVE_GAIN);
}

/** Static preview, or measured input. No ambient activity or recording claim. */
export function SymonWaveform({ level = 0, width = SYMON_WAVEFORM.width, live = false }: { level?: number; width?: number; live?: boolean }) {
  const gradient = useId();
  const reducedMotion = useReducedMotion();
  const wave = SYMON_WAVEFORM;
  const measured = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
  const amplitude = live ? liveAmplitude(measured) : measured;
  return <svg aria-hidden="true" width={width} height={wave.height} viewBox={`0 0 ${wave.width} ${wave.height}`} style={{ display: 'block', flexShrink: 0 }}>
    <defs><linearGradient id={gradient}>{SYMON_GRADIENT_STOPS.map(([offset, color]) => <stop key={offset} offset={offset} stopColor={color} />)}</linearGradient></defs>
    {wave.weights.map((weight, i) => {
      const height = Math.max(2, amplitude * weight * wave.height);
      return <rect key={i} x={i * (wave.barWidth + wave.barGap)} y={live ? 0 : (wave.height - height) / 2} width={wave.barWidth} height={live ? wave.height : height} rx={1} fill={`url(#${gradient})`} style={live ? {
        transform: `scaleY(${height / wave.height})`,
        transformOrigin: 'center',
        transformBox: 'view-box',
        transition: reducedMotion ? undefined : 'transform 70ms cubic-bezier(0.16, 1, 0.3, 1)',
      } : undefined} />;
    })}
  </svg>;
}

/** The live HUD's polishing silhouette, at rest for a labeled feature preview. */
export function SymonPolishMark({ active = false, width = 42 }: { active?: boolean; width?: number }) {
  const gradient = useId();
  const reducedMotion = useReducedMotion();
  const moving = active && !reducedMotion;
  return <svg aria-hidden="true" width={width} height={18} viewBox="0 0 416 52" style={{ display: 'block', flexShrink: 0 }}>
    <defs><linearGradient id={gradient}>{SYMON_GRADIENT_STOPS.map(([offset, color]) => <stop key={offset} offset={offset} stopColor={color} />)}</linearGradient></defs>
    {moving ? <path d={SYMON_POLISH_PATH} fill="none" stroke="var(--t-border, color-mix(in srgb, #b1b4e5 16%, transparent))" strokeWidth={12} strokeLinecap="round" /> : null}
    <path d={SYMON_POLISH_PATH} pathLength={100} fill="none" stroke={`url(#${gradient})`} strokeWidth={12} strokeLinecap="round" strokeDasharray={moving ? '36 64' : undefined}>
      {moving ? <animate attributeName="stroke-dashoffset" values="36;-36;36" dur="2.1s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.5;1" keySplines="0.42 0 0.58 1;0.42 0 0.58 1" /> : null}
    </path>
  </svg>;
}
