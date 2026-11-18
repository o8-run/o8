import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
import { startRustParity } from './fixtures/ws-parity-rust';

let reference: Awaited<ReturnType<typeof startParityReference>>;
const directory = mkdtempSync(join(tmpdir(), 'o8-parity-recordings-'));
const recordingPath = 'tests/fixtures/ws-parity/control.json';
const binary = process.env.O8D_TEST_BINARY ?? join(process.cwd(), 'crates/o8d/target/debug',
  process.platform === 'win32' ? 'o8d.exe' : 'o8d');

async function runHarness(recording = recordingPath, url = reference.url) {
  return new Promise<{ code: number; output: string }>((resolve) => {
    execFile(process.execPath, ['--import=tsx', 'scripts/ws-parity.ts',
      `--url=${url}`, `--recording=${recording}`, `--fixture-url=${reference.apiUrl}`], {
      env: { ...process.env, O8_WS_PARITY_TOKEN: reference.token },
    }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) || 1 : 0, output: stdout + stderr }));
  });
}

beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) {
    await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path',
      'crates/o8d/Cargo.toml', '--features', 'experimental-ws']);
  }
  reference = await startParityReference();
}, 120_000);
afterAll(async () => {
  await reference?.stop();
  rmSync(directory, { recursive: true, force: true });
});

describe('recorded WS sessions through the real server and parity CLI', () => {
  it('matches every control envelope, upgrade rejection, and close', async () => {
    const result = await runHarness();
    expect(result.output).toContain('parity passed');
    expect(result.code).toBe(0);
  });

  it.each(['field', 'extra-envelope', 'missing-envelope', 'close-code', 'reorder', 'capture-object'])(
    'fails closed on a %s mismatch', async (fault) => {
      const recording = JSON.parse(readFileSync(recordingPath, 'utf8'));
      const received = recording.actions.find((action: { op: string }) => action.op === 'receive');
      if (fault === 'field') received.entries[0].frame.data.unexpected = true;
      if (fault === 'capture-object') received.entries[0].frame = { $capture: 'ignored', type: 'object' };
      if (fault === 'extra-envelope') received.entries.splice(1, 1);
      if (fault === 'missing-envelope') received.entries.push({ kind: 'message', frame: { missing: true } });
      if (fault === 'reorder') received.entries.reverse();
      if (fault === 'close-code') {
        const close = recording.actions.find((action: { entries?: Array<{ kind: string }> }) =>
          action.entries?.some((entry) => entry.kind === 'close'));
        close.entries[0].code = 1001;
      }
      const path = join(directory, `${fault}.json`);
      writeFileSync(path, JSON.stringify(recording));
      const result = await runHarness(path);
      expect(result.code).toBe(1);
      expect(result.output).toContain('parity failed');
    },
  );

  it('matches reconnect, epoch-bound replay, and unsubscribe silence', async () => {
    const result = await runHarness('tests/fixtures/ws-parity/replay.json');
    expect(result.output).toContain('parity passed');
    expect(result.code).toBe(0);
  });

  it.each(['gap', 'incompatible'])('matches the %s recording against TypeScript', async (name) => {
    const result = await runHarness(`tests/fixtures/ws-parity/${name}.json`);
    expect(result.output).toContain('parity passed');
    expect(result.code).toBe(0);
  });

  it('matches Rust control delivery using the identical recording and TS-owned initial state', async () => {
    const recording = JSON.parse(readFileSync(recordingPath, 'utf8'));
    const frames = recording.actions[1].entries.slice(1).map((entry: { frame: unknown }) => entry.frame);
    const path = join(directory, 'initial-state.json');
    writeFileSync(path, JSON.stringify(frames));
    const rust = await startRustParity(binary, reference.token, path);
    try {
      const result = await runHarness(recordingPath, rust.url);
      expect(result.output).toContain('parity passed');
      expect(result.code).toBe(0);
    } finally {
      await rust.stop();
    }
  });
});
