import { withChildEnvironment } from '@/lib/providers/child-process';
/**
 * terminal-host fork entry point.
 *
 * ws-server forks this file (dev: `node --import tsx …entry.ts`; packaged:
 * `node …/terminal-host.mjs` bundled by scripts/tauri-export.mjs). It loads
 * node-pty here — in the child — so a native-module wedge or a runaway PTY
 * data pump can never freeze the parent's event loop (#1498 follow-up), and
 * runs the pure child logic over Node's fork IPC channel.
 *
 * node-pty is loaded defensively: if it's missing/broken, spawns report a
 * `spawn-error` instead of crashing the fork (parent then surfaces it).
 */

import { createRequire } from 'node:module';
import { createTerminalHostChild, type ChildPty } from './terminal-host-child';
import type { PtySpawnSpec, TerminalHostRequest } from './terminal-host-protocol';

const require = createRequire(import.meta.url);

type NodePtyModule = {
  spawn(
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): ChildPty;
};

let ptyMod: NodePtyModule | null = null;
try {
  ptyMod = require('node-pty') as NodePtyModule;
} catch (err) {
  console.error(`[terminal-host] node-pty unavailable: ${err instanceof Error ? err.message : String(err)}`);
}

function spawnPty(spec: PtySpawnSpec): ChildPty {
  if (!ptyMod) throw new Error('node-pty not available in terminal-host');
  return withChildEnvironment(spec.env, [spec.file, ...spec.args], env => ptyMod!.spawn(spec.file, spec.args, {
    name: spec.name ?? 'xterm-256color',
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
    env,
  }), false, spec.cwd);
}

const child = createTerminalHostChild({
  spawn: spawnPty,
  send: (evt) => {
    // process.send exists because the parent forked us with an IPC channel.
    process.send?.(evt);
  },
  log: (msg) => console.log(`[terminal-host] ${msg}`),
});

process.on('message', (msg) => {
  child.handle(msg as TerminalHostRequest);
});

// Parent closed the IPC channel (shutdown / crash) — kill our PTYs and exit so
// no orphaned shells survive the parent.
process.on('disconnect', () => {
  child.killAll();
  process.exit(0);
});

process.on('SIGTERM', () => {
  child.killAll();
  process.exit(0);
});

console.log('[terminal-host] child started');
