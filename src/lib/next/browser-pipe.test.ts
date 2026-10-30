import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from '@/lib/providers/child-process';
import { browserAgentSource } from '../../../scripts/next/browser-agent-source';
import { bindNextBrowserPipe, requestNextBrowser } from './browser-pipe';

function child() {
  return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null });
}
afterEach(() => vi.useRealTimers());
describe('Next Browser parent pipe', () => {
  it('bakes the same classic native page agent without drift', () => {
    expect(readFileSync(new URL('../../../native/o8-next/src/browser_panel/agent.js', import.meta.url), 'utf8')).toBe(browserAgentSource());
  });
  it('matches concurrent receipts by id and ignores unrelated stdout', async () => {
    const process = child();
    bindNextBrowserPipe(process as unknown as ChildProcess);
    const frames: string[] = [];
    process.stdin.on('data', chunk => frames.push(String(chunk)));
    const one = requestNextBrowser('read', {})!;
    const two = requestNextBrowser('click', { selector: '#link' })!;
    const [a, b] = frames.map(frame => JSON.parse(frame) as { id: string });
    process.stdout.write('o8-next-ready\n');
    process.stdout.write('o8-next-browser-result:' + JSON.stringify({ id: b.id, result: { ok: true, clicked: '#link' } }) + '\n');
    process.stdout.write('o8-next-browser-result:' + JSON.stringify({ id: a.id, result: { ok: true, title: 'Fixture' } }) + '\n');
    expect(await one).toEqual({ ok: true, title: 'Fixture' });
    expect(await two).toEqual({ ok: true, clicked: '#link' });
    process.emit('exit');
  });
  it('never replays an unconfirmed mutation or falls back after child death', async () => {
    const process = child();
    bindNextBrowserPipe(process as unknown as ChildProcess);
    let writes = 0;
    process.stdin.on('data', () => writes++);
    const result = requestNextBrowser('type', { selector: '#input', text: 'once' })!;
    process.emit('exit');
    expect(await result).toMatchObject({ ok: false, actionDispatched: null, automaticReplay: false });
    expect(writes).toBe(1);
    expect(requestNextBrowser('read', {})).toBeNull();
  });
  it('bounds request lifetime without automatically replaying a click', async () => {
    vi.useFakeTimers();
    const process = child();
    bindNextBrowserPipe(process as unknown as ChildProcess);
    const result = requestNextBrowser('click', { selector: '#link' })!;
    await vi.advanceTimersByTimeAsync(8000);
    expect(await result).toMatchObject({ ok: false, timedOut: true, automaticReplay: false });
    process.emit('exit');
  });
  it('keeps unsupported verbs outside the pipe', () => {
    const process = child();
    bindNextBrowserPipe(process as unknown as ChildProcess);
    expect(requestNextBrowser('eval', { js: 'anything' })).toBeNull();
    process.emit('exit');
  });
});
