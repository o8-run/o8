import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

function nativeAddons() {
  return ['better-sqlite3', 'node-pty'].flatMap(name => {
    const root = resolve('node_modules', name);
    return readdirSync(root, { recursive: true }).filter((file): file is string =>
      typeof file === 'string' && (file.endsWith('.node') || file.endsWith('spawn-helper')))
      .sort().map(file => {
        const path = join(root, file);
        return { name, file, mode: statSync(path).mode,
          digest: createHash('sha256').update(readFileSync(path)).digest('hex') };
      });
  });
}

it('launches the memory benchmark with installed native addons without changing them', async ({ onTestFinished }) => {
  const evidence = process.env.O8_SESSION_NATIVE_EVIDENCE ?? mkdtempSync(join(tmpdir(), 'o8-session-native-'));
  const before = nativeAddons();
  expect(before.some(addon => addon.name === 'better-sqlite3')).toBe(true);
  expect(before.some(addon => addon.name === 'node-pty')).toBe(true);
  try {
    const modulePath = resolve('scripts/bench/session-memory.mjs');
    const { measureSessionMemory } = await import(/* @vite-ignore */ modulePath);
    const receipt = await measureSessionMemory({ output: evidence, sessions: 1, transcriptMiB: 0.1,
      workerSessions: 0, idleMs: 0, registerCleanup: onTestFinished });
    expect(receipt.completedSessions).toBe(1);
    expect(receipt.projects).toBe(4);
    expect(receipt.persistedOutputUnchanged).toBe(true);
  } finally {
    expect(nativeAddons()).toEqual(before);
    if (!process.env.O8_SESSION_NATIVE_EVIDENCE) rmSync(evidence, { recursive: true, force: true });
  }
}, 120_000);

it('bounds idle memory after chat and worker history reads, project switches and closed sockets', async ({ onTestFinished }) => {
  const evidence = process.env.O8_SESSION_MEMORY_EVIDENCE ?? mkdtempSync(join(tmpdir(), 'o8-session-memory-'));
  try {
    const modulePath = resolve('scripts/bench/session-memory.mjs');
    const { measureSessionMemory, assertIdleRssBudget } = await import(/* @vite-ignore */ modulePath);
    const receipt = await measureSessionMemory({ output: evidence, sessions: 12, transcriptMiB: 4,
      workerSessions: 12, idleMs: 65_000, registerCleanup: onTestFinished });
    console.log(JSON.stringify(receipt));
    expect(receipt.completedSessions).toBe(12);
    expect(receipt.completedWorkers).toBe(12);
    expect(receipt.sandboxedWorkers).toBe(12);
    expect(receipt.sandboxDenials).toBe(1);
    expect(receipt.persistedOutputUnchanged).toBe(true);
    assertIdleRssBudget(receipt);
    for (const phase of ['after', 'afterIdle'] as const) {
      const trees = receipt.processTrees.postGc[phase === 'after' ? 'afterRun' : 'afterIdle'];
      const servers = Object.values(trees) as Array<{ rssMiB: number }>;
      expect.soft(servers.reduce((sum, server) => sum + server.rssMiB, 0) * 1024 * 1024,
        `${phase} server trees including helpers exceed 500 MB`).toBeLessThan(500_000_000);
      for (const name of ['next', 'ws'] as const) {
        expect.soft(receipt[phase][name].heapUsedMiB, `${name} ${phase} idle heap ceiling`).toBeLessThan(96);
        if (phase === 'afterIdle') {
          expect.soft(receipt[phase][name].heapUsedMiB - receipt.idle[name].heapUsedMiB,
            `${name} ${phase} retained heap growth ceiling`).toBeLessThan(24);
          expect.soft(receipt[phase][name].arrayBuffersMiB - receipt.idle[name].arrayBuffersMiB,
            `${name} ${phase} cached-buffer growth ceiling`).toBeLessThan(8);
        }
      }
    }
  } finally {
    if (!process.env.O8_SESSION_MEMORY_EVIDENCE) rmSync(evidence, { recursive: true, force: true });
  }
}, 300_000);
