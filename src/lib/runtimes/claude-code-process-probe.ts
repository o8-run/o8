import { execFile } from '@/lib/providers/child-process';
import { readFile, readlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LiveClaudeProcess {
  pid: number;
  cwd?: string;
  sessionId?: string;
  tty?: string;
}

export interface LiveClaudeProbe {
  processes: LiveClaudeProcess[];
  probed: boolean;
}

export function createLiveClaudeSessionMatcher(processes: LiveClaudeProcess[]) {
  const exactSessionIds = new Set(
    processes.map((process) => process.sessionId).filter((value): value is string => Boolean(value)),
  );
  const availableSlotsByCwd = new Map<string, number>();
  for (const process of processes) {
    if (process.sessionId || !process.cwd) continue;
    const cwd = process.cwd.replace(/\/+$/, '');
    availableSlotsByCwd.set(cwd, (availableSlotsByCwd.get(cwd) ?? 0) + 1);
  }
  const claimedSlotsByCwd = new Map<string, number>();

  return (sessionId: string, cwd: string): boolean => {
    if (exactSessionIds.has(sessionId)) return true;
    const available = availableSlotsByCwd.get(cwd) ?? 0;
    const claimed = claimedSlotsByCwd.get(cwd) ?? 0;
    if (available <= claimed) return false;
    claimedSlotsByCwd.set(cwd, claimed + 1);
    return true;
  };
}

export type ClaudeProcessProbeExec = (
  file: string,
  args: string[],
  options: { windowsHide: boolean; timeout: number },
) => Promise<{ stdout: string }>;

export interface ClaudeProcessSessionState {
  cwd?: string;
  sessionId?: string;
}

async function readClaudeProcessSessionState(pid: number): Promise<ClaudeProcessSessionState | null> {
  const claudeHome = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
  try {
    const parsed = JSON.parse(await readFile(path.join(claudeHome, 'sessions', `${pid}.json`), 'utf8')) as Record<string, unknown>;
    return {
      cwd: typeof parsed.cwd === 'string' && parsed.cwd.trim() ? parsed.cwd : undefined,
      sessionId: typeof parsed.sessionId === 'string' && parsed.sessionId.trim() ? parsed.sessionId : undefined,
    };
  } catch {
    return null;
  }
}

export async function probeLiveClaudeProcesses(options: {
  execFile?: ClaudeProcessProbeExec;
  readSessionState?: (pid: number) => Promise<ClaudeProcessSessionState | null>;
} = {}): Promise<LiveClaudeProbe> {
  const runExecFile = options.execFile ?? execFileAsync as ClaudeProcessProbeExec;
  const readSessionState = options.readSessionState ?? readClaudeProcessSessionState;
  try {
    // bash/ps/lsof are Unix-only. On Windows, list claude.exe worker
    // processes (those launched with flags, i.e. "--" in the command line)
    // through PowerShell + CIM, excluding the store-packaged desktop app
    // the way the Unix grep excludes .app bundles; the pid-per-line output
    // stays format-compatible with the parser below.
    const { stdout } = process.platform === 'win32'
      ? await runExecFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name = 'claude.exe'\" | Where-Object { $_.CommandLine -match '--' -and $_.ExecutablePath -notmatch 'WindowsApps' } | ForEach-Object { \"{0} {1}\" -f $_.ProcessId, $_.CommandLine }"],
        { windowsHide: true, timeout: 10_000 })
      : await runExecFile(
        'bash', ['-c', 'ps -eo pid=,command= | grep -E "claude (--|-)" | grep -v grep | grep -v ".app/"'],
        { windowsHide: true, timeout: 3000 },
      );
    const pids: number[] = [];
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const match = line.trim().match(/^(\d+)/);
      if (match) pids.push(Number(match[1]));
    }
    if (pids.length === 0) return { processes: [], probed: true };

    const processes: LiveClaudeProcess[] = pids.map((pid) => ({ pid }));
    let cwdProbed = true;
    try {
      // lsof has no Windows equivalent; the probe stays inconclusive on cwd,
      // exactly like a missing lsof on Linux.
      if (process.platform === 'win32') throw new Error('lsof is unavailable on Windows');
      const { stdout: cwdOut } = await runExecFile(
        'lsof', ['-a', '-p', pids.join(','), '-d', 'cwd,0', '-Fpfn'],
        { windowsHide: true, timeout: 4000 },
      );
      let currentPid: number | null = null;
      let currentDescriptor: string | null = null;
      for (const line of cwdOut.split('\n')) {
        if (line.startsWith('p')) {
          currentPid = Number(line.slice(1));
          currentDescriptor = null;
        } else if (line.startsWith('f')) {
          currentDescriptor = line.slice(1);
        } else if (line.startsWith('n/') && currentPid !== null) {
          const proc = processes.find((candidate) => candidate.pid === currentPid);
          if (!proc) continue;
          if (currentDescriptor === '0') {
            proc.tty = line.slice(1);
          } else if (currentDescriptor === 'cwd' || currentDescriptor === null) {
            proc.cwd = line.slice(1);
          }
        }
      }
    } catch {
      cwdProbed = false;
      if (process.platform === 'linux') {
        // lsof is optional on Linux. Observe the same candidate PIDs through
        // procfs, keeping the probe inconclusive if any cwd cannot be read.
        const observed = await Promise.all(processes.map(async (process) => {
          try {
            const cwd = await readlink(`/proc/${process.pid}/cwd`);
            if (!path.isAbsolute(cwd) || cwd.endsWith(' (deleted)')) return false;
            process.cwd = cwd;
            const stdin = await readlink(`/proc/${process.pid}/fd/0`).catch(() => null);
            if (stdin && /^\/dev\/(?:pts\/\d+|tty\w*)$/.test(stdin)) process.tty = stdin;
            return true;
          } catch {
            return false;
          }
        }));
        cwdProbed = observed.every(Boolean);
      }
    }
    await Promise.all(processes.map(async (process) => {
      const state = await readSessionState(process.pid).catch(() => null);
      if (!state) return;
      process.cwd = state.cwd ?? process.cwd;
      process.sessionId = state.sessionId;
    }));
    return { processes, probed: cwdProbed };
  } catch (error) {
    const failure = error as { code?: unknown; killed?: unknown };
    return { processes: [], probed: failure.code === 1 && !failure.killed };
  }
}

export async function findLiveClaudeProcesses(): Promise<LiveClaudeProcess[]> {
  return (await probeLiveClaudeProcesses()).processes;
}
