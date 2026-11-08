import { describe, expect, it } from 'vitest';
import { SPEAKING_LEVEL, speakingAt } from './DictationPill';
import { liveAmplitude } from './SymonVisuals';

// Recorder levels are on a dBFS meter: -50..-10 dBFS onto 0..1 (#2534).
const meter = (dbfs: number) => Math.max(0, Math.min(1, (dbfs + 50) / 40));

describe('dictation pill on the dBFS level meter', () => {
  it('treats speech as speaking and a quiet room as not', () => {
    expect(SPEAKING_LEVEL).toBe(0.25);
    expect(speakingAt(meter(-55))).toBe(false);
    expect(speakingAt(meter(-45))).toBe(false);
    expect(speakingAt(meter(-40))).toBe(false);
    expect(speakingAt(meter(-35))).toBe(true);
    expect(speakingAt(meter(-20))).toBe(true);
  });

  it('gives the agent waveform room between ordinary and loud speech', () => {
    expect(liveAmplitude(meter(-55))).toBe(0);
    // Ordinary speech sits mid-height, well short of the top.
    expect(liveAmplitude(meter(-40))).toBeCloseTo(0.35, 5);
    expect(liveAmplitude(meter(-30))).toBeCloseTo(0.7, 5);
    // Full height only near -21 dBFS: loud syllables, not normal talking.
    expect(liveAmplitude(meter(-25))).toBeLessThan(1);
    expect(liveAmplitude(meter(-21))).toBeCloseTo(1, 1);
    expect(liveAmplitude(meter(-15))).toBe(1);
  });
});
