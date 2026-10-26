import { childEnvironment } from '@/lib/providers/spawn-environment';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { spawn, type ChildProcess } from '@/lib/providers/child-process';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { knowledgeSourceWriteRefusal } from '@/lib/cortex/knowledge/sources';

// ── Active dev server processes ──
const activeServers = new Map<string, {
  process: ChildProcess;
  pid: number;
  command: string;
  cwd: string;
  port: number | null;
  startedAt: number;
  lastOutput: string;
}>();

// GET — list active dev servers
export async function GET(req: NextRequest) {
  if (resolveRequestPrincipal(req) !== 'operator') {
    return NextResponse.json({ error: 'Dev server controls are operator-only.' }, { status: 403 });
  }
  const servers = Array.from(activeServers.entries()).map(([id, srv]) => ({
    id,
    pid: srv.pid,
    command: srv.command,
    cwd: srv.cwd,
    port: srv.port,
    startedAt: srv.startedAt,
    alive: !srv.process.killed,
    lastOutput: srv.lastOutput.slice(-500),
  }));
  return NextResponse.json({ servers });
}

// POST — start a dev server
export async function POST(req: NextRequest) {
  // Operator-only: this spawns an arbitrary shell (`sh -c <command>` below). A
  // dispatched worker (local-worker token) must never reach this RCE primitive
  // (SECURITY_AUDIT_2026-07-02 §HIGH-3). Only the desktop repo-card UI calls it.
  if (resolveRequestPrincipal(req) !== 'operator') {
    return NextResponse.json({ error: 'Starting a dev server is operator-only.' }, { status: 403 });
  }
  try {
    const body = await req.json() as {
      repoPath: string;
      command: string;
      port?: number;
    };

    const { repoPath, command, port } = body;
    if (!repoPath || !command) {
      return NextResponse.json({ error: 'repoPath and command required' }, { status: 400 });
    }

    // Check if already running for this repo
    const existingId = `dev-${repoPath}`;
    const existing = activeServers.get(existingId);
    if (existing && !existing.process.killed) {
      return NextResponse.json({
        error: 'Dev server already running for this repo',
        pid: existing.pid,
        port: existing.port,
      }, { status: 409 });
    }

    // Resolve path
    const cwd = repoPath.replace(/^~/, process.env.HOME || require('os').homedir());
    const sourceRefusal = knowledgeSourceWriteRefusal(repoPath, cwd);
    if (sourceRefusal) return sourceRefusal;

    // Spawn the dev server
    const child = spawn('sh', ['-c', command], {
      windowsHide: true,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: childEnvironment({ env: { FORCE_COLOR: '0', NO_COLOR: '1' } }),
    });

    const serverEntry = {
      process: child,
      pid: child.pid ?? 0,
      command,
      cwd,
      port: port ?? null,
      startedAt: Date.now(),
      lastOutput: '',
    };

    // Capture output for status display
    child.stdout?.on('data', (data: Buffer) => {
      serverEntry.lastOutput += data.toString();
      // Keep last 2K
      if (serverEntry.lastOutput.length > 2048) {
        serverEntry.lastOutput = serverEntry.lastOutput.slice(-1024);
      }
      // Try to detect port from output
      if (!serverEntry.port) {
        const portMatch = data.toString().match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/);
        if (portMatch) serverEntry.port = parseInt(portMatch[1], 10);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      serverEntry.lastOutput += data.toString();
      if (serverEntry.lastOutput.length > 2048) {
        serverEntry.lastOutput = serverEntry.lastOutput.slice(-1024);
      }
      if (!serverEntry.port) {
        const portMatch = data.toString().match(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)/);
        if (portMatch) serverEntry.port = parseInt(portMatch[1], 10);
      }
    });

    child.on('exit', () => {
      activeServers.delete(existingId);
    });

    // Unref so the process doesn't keep the server alive
    child.unref();
    activeServers.set(existingId, serverEntry);

    return NextResponse.json({
      started: true,
      id: existingId,
      pid: child.pid,
      command,
      port: port ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to start dev server' },
      { status: 500 },
    );
  }
}

// DELETE — stop a dev server
export async function DELETE(req: NextRequest) {
  if (resolveRequestPrincipal(req) !== 'operator') {
    return NextResponse.json({ error: 'Stopping a dev server is operator-only.' }, { status: 403 });
  }
  try {
    const body = await req.json() as { repoPath: string };
    const id = `dev-${body.repoPath}`;
    const server = activeServers.get(id);

    if (!server) {
      // Try to find by port scan and kill
      return NextResponse.json({ error: 'No active dev server for this repo' }, { status: 404 });
    }

    // Kill the process group (negative PID kills the group)
    try {
      if (server.process.pid) {
        process.kill(-server.process.pid, 'SIGTERM');
      }
    } catch {
      // Process might already be dead
      try {
        server.process.kill('SIGTERM');
      } catch { /* already dead */ }
    }

    activeServers.delete(id);

    return NextResponse.json({
      stopped: true,
      id,
      pid: server.pid,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to stop dev server' },
      { status: 500 },
    );
  }
}
