import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { chainOnKey } from '@/lib/util/keyed-promise-chain';

const root = mkdtempSync(join(tmpdir(), 'o8-absent-stop-'));
process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = join(root, 'sessions');
const { escalateInterruptOwnedSurface, escalateInterrupt } = await import('@/lib/runtime/interrupt-escalation');
await import('@/lib/runtimes');
const { probeOwnedProcessIdentity } = await import('@/lib/runtimes/shared/owned-session/process-identity');
const { createOwnedSessionIo } = await import('@/lib/runtimes/shared/owned-session/session-io');
const { registerOwnedStopHandler, withOwnedStopOutcome } = await import('@/lib/runtimes/shared/owned-session/stop-outcome');
const io = createOwnedSessionIo({ root: join(root, 'sessions'), surfacePrefix: 'claude-code-owned:', invalidateFleetCache: () => {} });
const chains = new Map<string, Promise<unknown>>();
let beforeLock: (() => void) | undefined;
registerOwnedStopHandler('claude-code-owned:', io, (key, operation) => chainOnKey(chains, key, () => {
  const mutation = beforeLock; beforeLock = undefined; mutation?.(); return operation();
}), () => {});

const children: ChildProcess[] = [];
const descendants: Array<{ pid: number; identity: unknown }> = [];
afterEach(async () => {
  beforeLock = undefined;
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
  }
  for (const child of descendants.splice(0)) {
    if (JSON.stringify(await probeOwnedProcessIdentity(child.pid)) === JSON.stringify(child.identity)) {
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.runIf(process.platform !== 'win32')('Stop before the owned exit journal settles', () => {
  it('persists a delivered group Stop when an escaped child is still awaiting provider cleanup', async () => {
    const marker = randomUUID();
    const script = `
      const { spawn } = require('node:child_process');
      const worker = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"],
        { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env });
      worker.once('message', () => process.send(worker.pid));
      process.on('SIGINT', () => {});
      process.on('message', () => {
        worker.once('exit', () => process.exit(0));
        worker.kill('SIGTERM');
      });
    `;
    const child = spawn(process.execPath, ['-e', script], { detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { NODE_ENV: 'test', O8_OWNED_RUN_MARKER: marker } });
    children.push(child);
    const [workerPid] = await once(child, 'message');
    const proof = await probeOwnedProcessIdentity(child.pid!);
    expect(proof.state).toBe('live');
    if (proof.state !== 'live') throw new Error('Fixture identity unavailable.');
    descendants.push({ pid: Number(workerPid), identity: await probeOwnedProcessIdentity(Number(workerPid)) });
    const sessionDir = join(root, 'sessions', marker);
    mkdirSync(sessionDir, { recursive: true });
    const run = { id: marker, pid: child.pid!, processGroupId: child.pid!, processMarker: marker,
      processIdentity: proof.identity, processIdentitySource: proof.source, processIdentityRequired: true,
      outcome: 'running', startedAt: new Date().toISOString(),
      stdoutPath: join(sessionDir, 'out'), stderrPath: join(sessionDir, 'err') };
    const surfaceId = `claude-code-owned:${marker}`;
    const file = join(sessionDir, 'session.json');
    writeFileSync(file, JSON.stringify({ surfaceId, sessionDir, repoPath: root, cwd: root,
      activeRun: run, recentRuns: [run] }));
    const result = await withOwnedStopOutcome(surfaceId, run, () => escalateInterrupt(run, {
      // Release provider cleanup only after the actual group signal and the
      // escaped-child refusal. No cold-start or scheduling deadline is assumed.
      sleep: async () => {
        const exited = once(child, 'exit');
        child.send('finish stopping');
        await exited;
      },
    }));
    expect(result).toMatchObject({ confirmedDead: true, steps: [{ signal: 'SIGINT', sent: true, confirmedDead: true }] });
    expect(JSON.parse(readFileSync(file, 'utf8')).recentRuns[0])
      .toMatchObject({ outcome: 'interrupted', interruptRequestedAt: expect.any(String) });
  }, 20_000);

  it.each(['clear', 'settled', 'successor', 'group', 'escaped', 'unknown', 'mismatch', 'missing-marker', 'missing-group'] as const)(
    'rechecks %s process evidence without signaling or rewriting the saved run', async (kind) => {
      const marker = randomUUID();
      const withDescendant = kind === 'group' || kind === 'escaped';
      const script = withDescendant ? `
        const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,['-e',"process.send('ready');setInterval(()=>{},1000)"],
          {detached:${kind === 'escaped'},stdio:['ignore','ignore','ignore','ipc']});
        child.on('message',()=>process.send(child.pid));setInterval(()=>{},1000);
      ` : "process.send('ready');setInterval(()=>{},1000)";
      const child = spawn(process.execPath, ['-e', script], { detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { NODE_ENV: 'test', O8_OWNED_RUN_MARKER: marker } });
      children.push(child);
      const [message] = await once(child, 'message');
      const proof = await probeOwnedProcessIdentity(child.pid!);
      expect(proof.state).toBe('live');
      if (proof.state !== 'live') throw new Error('Fixture identity unavailable.');
      if (withDescendant) {
        const pid = Number(message);
        const identity = await probeOwnedProcessIdentity(pid);
        expect(identity.state).toBe('live'); descendants.push({ pid, identity });
      }
      const sessionDir = join(root, 'sessions', marker);
      mkdirSync(sessionDir, { recursive: true });
      const run = { id: marker, pid: child.pid, processGroupId: kind === 'missing-group' ? undefined : child.pid,
        processMarker: kind === 'missing-marker' ? undefined : marker,
        processIdentity: kind === 'mismatch' ? { ...proof.identity, startId: `${proof.identity.startId}-different` } : proof.identity,
        processIdentitySource: kind === 'unknown' ? 'incompatible' : proof.source, processIdentityRequired: true,
        outcome: 'interrupted', interruptRequestedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(), stdoutPath: join(sessionDir, 'out'), stderrPath: join(sessionDir, 'err') };
      const surfaceId = `claude-code-owned:${marker}`;
      const file = join(sessionDir, 'session.json');
      writeFileSync(file, JSON.stringify({ surfaceId, sessionDir, repoPath: root, cwd: root,
        activeRun: run, recentRuns: [run] }));
      if (kind !== 'mismatch') {
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      }
      let before = readFileSync(file, 'utf8');
      if (kind === 'settled' || kind === 'successor') beforeLock = () => {
        const current = JSON.parse(readFileSync(file, 'utf8'));
        if (kind === 'settled') delete current.activeRun;
        else current.activeRun.id = randomUUID();
        before = JSON.stringify(current); writeFileSync(file, before);
      };
      const result = await escalateInterruptOwnedSurface(surfaceId);
      const clear = kind === 'clear' || kind === 'settled';
      expect(result).toMatchObject({ attempted: false, confirmedDead: clear,
        alreadyDead: clear, steps: [] });
      expect(readFileSync(file, 'utf8')).toBe(before);
      if (kind === 'mismatch') expect(await probeOwnedProcessIdentity(child.pid!)).toEqual(proof);
      for (const descendant of descendants) expect(await probeOwnedProcessIdentity(descendant.pid)).toEqual(descendant.identity);
    }, 20_000,
  );
});
