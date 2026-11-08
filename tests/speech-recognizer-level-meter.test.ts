import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// The dictation waveform's level (#2534). The helper maps RMS onto a dBFS
// meter and sends it on a wall-clock gate; this compiles exactly the helper's
// marked level-meter block with a small harness and checks its numbers.
const source = readFileSync(resolve(__dirname, '../src-tauri/helpers/speech_recognizer.swift'), 'utf8');
const begin = source.indexOf('// MARK: level meter (begin)');
const end = source.indexOf('// MARK: level meter (end)');
const darwin = process.platform === 'darwin';
const dir = darwin ? mkdtempSync(join(tmpdir(), 'o8-level-meter-')) : '';

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const harness = `
func at(_ dbfs: Float) -> Float { meterLevel(rms: pow(10, dbfs / 20)) }
print([at(-60), at(-50), at(-30), at(-10), at(0), meterLevel(rms: 0), meterLevel(rms: .nan)]
  .map { String(format: "%.4f", $0) }.joined(separator: " "))
for step in [0.005, 0.0213, 0.064] {
  var gate = LevelGate()
  var opened: [Double] = []
  for i in 0..<Int((1.0 / step).rounded()) {
    let now = 100 + Double(i) * step
    if gate.open(at: now) { opened.append(now) }
  }
  let closest = zip(opened, opened.dropFirst()).map { $1 - $0 }.min() ?? 1
  print(step, opened.count, String(format: "%.4f", closest))
}
`;

describe('speech recognizer level meter', () => {
  it('keeps the meter in one marked block that both call sites use', () => {
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    expect(source).not.toContain('rms / 0.12');
    expect(source.match(/emitLevel\(meterLevel\(rms: rms\), sessionId: currentSessionId\)/g)).toHaveLength(2);
    expect(source.match(/levelGate\.open\(at: ProcessInfo\.processInfo\.systemUptime\)/g)).toHaveLength(2);
    // The silence gate's peak keeps its old buffer-count sampling.
    expect(source.match(/if peakDue && peak > sessionPeakSample \{/g)).toHaveLength(2);
    expect(source).toContain('let peakDue = frameCount % 6 == 0');
    expect(source).toContain('let peakDue = chunkCounter % 3 == 0');
  });

  it.skipIf(!darwin)('maps -50..-10 dBFS onto 0..1 and gates on wall time', () => {
    const file = join(dir, 'meter.swift');
    const bin = join(dir, 'meter');
    writeFileSync(file, `import Foundation\n${source.slice(begin, end)}\n${harness}`);
    execFileSync('xcrun', ['swiftc', '-O', '-o', bin, file], { stdio: 'ignore' });
    const [levels, ...gates] = execFileSync(bin, { encoding: 'utf8' }).trim().split('\n');

    // -60, -50, -30, -10, 0 dBFS, then silence and a non-finite RMS.
    expect(levels).toBe('0.0000 0.0000 0.5000 1.0000 1.0000 0.0000 0.0000');
    const rows = gates.map((row) => row.split(' ').map(Number));
    for (const [step, count, closest] of rows) {
      // Never faster than one level per 33ms, whatever the buffer size.
      expect(closest).toBeGreaterThanOrEqual(0.033 - 1e-9);
      expect(count).toBeLessThanOrEqual(31);
      // A buffer slower than the gate is sent every time.
      if (step > 0.033) expect(count).toBe(Math.round(1 / step));
    }
    expect(rows[0][1]).toBeGreaterThanOrEqual(25);
  }, 240_000);
});
