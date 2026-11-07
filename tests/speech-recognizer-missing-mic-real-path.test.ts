import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// A saved microphone that has moved USB ports is no longer found by its UID.
// The helper falls back to the default input, so it must report that as a
// status: a session-less error makes the host cancel the Fn dictation that is
// starting, which then never pastes or reaches dictation history.
const source = resolve(__dirname, '../src-tauri/helpers/speech_recognizer.swift');
const darwin = process.platform === 'darwin';
const dir = darwin ? mkdtempSync(join(tmpdir(), 'o8-speech-helper-')) : '';

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function events(helper: string): Promise<Array<{ type: string; text: string }>> {
  return new Promise((done, fail) => {
    const child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const finish = () => {
      child.kill('SIGKILL');
      done(out.split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    };
    child.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('"input_device:')) finish();
    });
    child.stdin.write('input_device:o8-test-missing-uid\n');
    setTimeout(finish, 20_000);
  });
}

describe.skipIf(!darwin)('speech recognizer helper, saved microphone missing', () => {
  it('reports the default-input fallback as a status, not an error', async () => {
    const helper = join(dir, 'speech-recognizer');
    execFileSync('xcrun', ['swiftc', '-O', '-o', helper, source], { stdio: 'ignore' });

    const seen = await events(helper);

    expect(seen.filter((event) => event.type === 'error')).toEqual([]);
    expect(seen).toContainEqual({ type: 'status', text: 'input_device_fallback:default' });
  }, 240_000);
});
