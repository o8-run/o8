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

  it('keeps the agent waveform at the old dock sensitivity', () => {
    // The old curve took RMS / 0.12 levels: sqrt((rms - 0.003) * 34).
    const old = (dbfs: number) => Math.min(1, Math.sqrt(Math.max(0, 10 ** (dbfs / 20) - 0.003) * 34));
    for (const dbfs of [-45, -40, -35, -30]) {
      expect(Math.abs(liveAmplitude(meter(dbfs)) - old(dbfs))).toBeLessThan(0.06);
    }
    expect(liveAmplitude(meter(-55))).toBe(0);
    expect(liveAmplitude(meter(-20))).toBe(1);
  });
});
