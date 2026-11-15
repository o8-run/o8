import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

// No Messages database or send implementation is imported by these lifecycle tests.
vi.mock('@/lib/symon/managed-messages-inbound', () => ({ handleManagedMessage: vi.fn() }));
vi.mock('@/lib/symon/messages-receiver/receiver', () => ({ MessagesReceiver: class { tick = vi.fn(); }, sendWithMessages: vi.fn() }));
import { startMessagesReceiver } from '@/lib/symon/messages-receiver/loop';

const runtime = globalThis as typeof globalThis & {
  __o8MessagesOwner?: Database.Database;
  __o8MessagesReceiverLoop?: boolean;
  __o8MessagesReceiver?: unknown;
};
let directory: string | undefined;
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  runtime.__o8MessagesOwner?.close();
  delete runtime.__o8MessagesOwner;
  delete runtime.__o8MessagesReceiverLoop;
  delete runtime.__o8MessagesReceiver;
  if (directory) rmSync(directory, { recursive: true, force: true });
});
it('refuses a second loop in this process and a second owner process, then releases on close', () => {
  directory = mkdtempSync(join(tmpdir(), 'o8-receiver-owner-'));
  vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'darwin' }));
  vi.useFakeTimers();
  expect(startMessagesReceiver()).toBe(true);
  expect(startMessagesReceiver()).toBe(false);
  expect(vi.getTimerCount()).toBe(1);
  const claim = () => execFileSync(process.execPath, ['--require=tsx/cjs', '-e',
    "console.log(require('./src/lib/symon/messages-receiver/owner.ts').claimMessagesReceiver());"],
  { env: { ...process.env, CORTEX_IDE_DATA_DIR: directory }, encoding: 'utf8' }).trim();
  expect(claim()).toBe('false');
  runtime.__o8MessagesOwner!.close();
  delete runtime.__o8MessagesOwner;
  expect(claim()).toBe('true');
});
it('does not claim ownership, create state or schedule a timer on non-macOS', () => {
  vi.stubGlobal('process', Object.defineProperty(Object.create(process), 'platform', { value: 'linux' }));
  vi.useFakeTimers();
  expect(startMessagesReceiver()).toBe(false);
  expect(runtime.__o8MessagesOwner).toBeUndefined();
  expect(runtime.__o8MessagesReceiver).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it('releases the receiver claim when its holder is killed', async () => {
  directory = mkdtempSync(join(tmpdir(), 'o8-receiver-killed-'));
  const child = spawn(process.execPath, ['--require=tsx/cjs', '-e',
    "process.send(require('./src/lib/symon/messages-receiver/owner.ts').claimMessagesReceiver()); setInterval(() => {}, 1000);"],
  { env: { ...process.env, CORTEX_IDE_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    expect((await once(child, 'message'))[0]).toBe(true);
    const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
    expect(execFileSync(process.execPath, ['--require=tsx/cjs', '-e',
      "console.log(require('./src/lib/symon/messages-receiver/owner.ts').claimMessagesReceiver());"],
    { env: { ...process.env, CORTEX_IDE_DATA_DIR: directory }, encoding: 'utf8' }).trim()).toBe('true');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
  }
});
