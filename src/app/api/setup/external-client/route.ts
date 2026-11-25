import { childEnvironment } from '@/lib/providers/spawn-environment';
import { providerSpawnEnvironment } from '@/lib/providers/spawn-environment';
/**
 * External MCP Client Auto-Register
 *
 * Lets users connect o8's MCP server to Hermes Agent and OpenClaw with a
 * single click — same UX as the Claude Desktop / Claude Code preset, but
 * different mechanism: both have first-class MCP CLIs we shell out to,
 * instead of editing a JSON config file directly.
 *
 *   target=hermes    → hermes mcp add o8 --command <cmd> --args <args>
 *   target=openclaw  → openclaw mcp set o8 '<json>'
 *
 * GET  — probes whether the binary is installed AND whether o8 is already
 *        registered. Returns a status the MCPTab UI can render.
 * POST — installs (or removes, when body.remove=true).
 *
 * Resolving the CLIs:
 *   `command -v` inside a Finder-launched app misses ~/.local/bin and
 *   ~/.npm-global/bin (login-shell-only paths). We resolve through the
 *   user's login shell (`$SHELL -lc 'command -v <cli>'`) so nvm/pyenv/etc.
 *   profile additions are honored. Same trick the Tauri sidecar uses for
 *   `node`. Final fallback: well-known install locations.
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { execFile, execFileSync, spawn, type ChildProcess } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toClaudeDesktopJson } from '@/lib/mcp/tool-spine/emit-claude-desktop';
import { hermesAddArgs, openclawSetPayload } from '@/lib/mcp/external-client-args';
import { resolveShell } from '@/lib/process/resolve-shell';
import { pathLookupProgram, pickLookupResult, scanForBinary } from '@/lib/runtimes/shared/cli-locate';
import { cliInvocation, spawnsViaInterpreter } from '@/lib/runtimes/shared/cli-spawn';

const execFileAsync = promisify(execFile);

// ── Target dispatch ──

type Target = 'hermes' | 'openclaw';

function normalizeTarget(value: unknown): Target | null {
  if (value === 'hermes') return 'hermes';
  if (value === 'openclaw') return 'openclaw';
  return null;
}

// ── CLI resolution via login shell ──

function resolveCli(name: string): string | null {
  // Both probes below are POSIX-only by construction — `command` is a shell
  // builtin, not a program, and `-lc` needs a POSIX login shell. Windows gets
  // `where` instead, which is the same question asked of the same PATH.
  if (process.platform === 'win32') {
    try {
      const stdout = execFileSync(pathLookupProgram(), [name], {
        windowsHide: true,
        encoding: 'utf-8',
        timeout: 3_000,
      });
      const found = pickLookupResult(stdout);
      if (found && existsSync(found)) return found;
    } catch {
      // not on PATH — fall through to the well-known scan
    }
    // wellKnownCliDirs knows %APPDATA%\npm and friends; the hand-written list
    // at the bottom of this function is entirely POSIX paths.
    return scanForBinary(name);
  }

  // Try the inherited PATH first — fast path that works in dev.
  try {
    const direct = execFileSync('command', ['-v', name], {
      windowsHide: true,
      encoding: 'utf-8',
      shell: '/bin/sh',
    } as never).trim();
    if (direct && existsSync(direct)) return direct;
  } catch {
    // fall through to login-shell probe
  }

  // Login-shell probe — picks up ~/.zshrc / ~/.profile additions that
  // Finder-launched apps don't inherit.
  try {
    const shell = resolveShell();
    const out = execFileSync(shell, ['-lc', `command -v ${name}`], {
      windowsHide: true,
      encoding: 'utf-8',
    }).trim();
    if (out && existsSync(out)) return out;
  } catch {
    // not installed
  }

  // Final guess: well-known install locations.
  const home = process.env.HOME || '';
  const candidates = name === 'hermes'
    ? [
      join(home, '.local', 'bin', 'hermes'),
      '/opt/homebrew/bin/hermes',
      '/usr/local/bin/hermes',
    ]
    : [
      join(home, '.npm-global', 'bin', 'openclaw'),
      '/opt/homebrew/bin/openclaw',
      '/usr/local/bin/openclaw',
    ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// ── o8 MCP server config: the Tool-Spine claude-desktop projection ──

interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// external-client forwards ONLY the operator entry (named "o8") — never
// DB externals — so it picks the `o8` key out of the Set-B
// projection. repoPath is irrelevant to this surface (cortex/externals filtered
// out); process.cwd() keeps resolver inputs identical to the old builder.
function buildServerConfig(): McpServerConfig {
  const projected = toClaudeDesktopJson(buildToolRegistry(process.cwd()), {}).mcpServers as Record<string, unknown>;
  const o8 = projected['o8'] as { command: string; args: string[]; env?: Record<string, string> };
  return { command: o8.command, args: o8.args, env: o8.env ?? {} };
}

/**
 * Stop a timed-out install/remove. On Windows the CLI is a GRANDchild of
 * cmd.exe, so `child.kill()` reaches the interpreter and leaves the real
 * process running with its pipes broken — the tree has to be taken explicitly.
 */
function abandonChild(child: ChildProcess, cliPath: string): void {
  if (spawnsViaInterpreter(cliPath) && child.pid) {
    const pid = child.pid;
    void import('@/lib/runtimes/shared/owned-session/helpers')
      .then(({ forceKillTreeWindows }) => forceKillTreeWindows(pid))
      .catch(() => { /* best effort — the SIGTERM below still fires */ });
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // already gone
  }
}

// ── Hermes ──

async function hermesStatus(cliPath: string): Promise<{ registered: boolean; raw: string }> {
  try {
    // Every spawn in this file goes through cliInvocation: an npm-installed CLI
    // is a `.cmd` on Windows and spawning it directly throws EINVAL, which this
    // function would report as "installed but not registered".
    const list = cliInvocation(cliPath, ['mcp', 'ls']);
    const { stdout } = await execFileAsync(list.command, list.args, {
      env: providerSpawnEnvironment(childEnvironment({ ...{ runtimeId: 'hermes' } }), { runtimeId: 'hermes' }),
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 5000,
    });
    // The list prints server names — match `o8` as a standalone token.
    const registered = /(^|\s)o8(\s|:|$)/m.test(stdout);
    return { registered, raw: stdout };
  } catch {
    return { registered: false, raw: '' };
  }
}

async function hermesInstall(cliPath: string, server: McpServerConfig): Promise<void> {
  // Wipe any prior entry first so re-install always lands the current shape.
  try {
    const wipe = cliInvocation(cliPath, ['mcp', 'remove', 'o8']);
    await execFileAsync(wipe.command, wipe.args, { windowsHide: true, timeout: 5000, env: providerSpawnEnvironment(childEnvironment({ ...{ runtimeId: 'hermes' } }), { runtimeId: 'hermes' }) });
  } catch {
    // remove fails when it doesn't exist — that's fine
  }

  // `hermes mcp add` connects to the server, lists its tools, and then prompts
  // `Enable all N tools? [Y/n/select]:` interactively. We write `Y\n` to stdin
  // so the install runs unattended.
  const args = hermesAddArgs(server);

  await new Promise<void>((resolve, reject) => {
    const launch = cliInvocation(cliPath, args);
    const child = spawn(launch.command, launch.args, { windowsHide: true, env: providerSpawnEnvironment(childEnvironment({ ...{ runtimeId: 'hermes' } }), { runtimeId: 'hermes' }), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      abandonChild(child, cliPath);
      reject(new Error('hermes mcp add timed out after 30s'));
    }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const detail = (stderr.trim() || stdout.trim() || `exited with code ${code}`).slice(-1200);
        reject(new Error(detail));
      }
    });
    child.stdin.write('Y\n');
    child.stdin.end();
  });
}

async function hermesRemove(cliPath: string): Promise<void> {
  // `hermes mcp remove` prompts `Remove server 'o8'? [Y/n]:` interactively.
  // Same stdin-Y trick as install.
  await new Promise<void>((resolve, reject) => {
    const launch = cliInvocation(cliPath, ['mcp', 'remove', 'o8']);
    const child = spawn(launch.command, launch.args, { windowsHide: true, env: providerSpawnEnvironment(childEnvironment({ ...{ runtimeId: 'hermes' } }), { runtimeId: 'hermes' }), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      abandonChild(child, cliPath);
      reject(new Error('hermes mcp remove timed out after 15s'));
    }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const detail = (stderr.trim() || stdout.trim() || `exited with code ${code}`).slice(-1200);
        reject(new Error(detail));
      }
    });
    child.stdin.write('Y\n');
    child.stdin.end();
  });
}

// ── OpenClaw ──

async function openclawStatus(cliPath: string): Promise<{ registered: boolean; raw: string }> {
  try {
    const show = cliInvocation(cliPath, ['mcp', 'show', 'o8']);
    await execFileAsync(show.command, show.args, {
      env: providerSpawnEnvironment(childEnvironment({ ...{ runtimeId: 'openclaw' } }), { runtimeId: 'openclaw' }),
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 5000,
    });
    return { registered: true, raw: '' };
  } catch (error) {
    return {
      registered: false,
      raw: error instanceof Error ? error.message : '',
    };
  }
}

async function openclawInstall(cliPath: string, server: McpServerConfig): Promise<void> {
  const payload = openclawSetPayload(server);
  // NOTE: `payload` is a JSON blob on argv, and cmd.exe expands `%VAR%` even
  // inside quotes. It is o8's own generated server config (paths + our env
  // keys), never user free text — see the constraint noted in cli-spawn.
  const set = cliInvocation(cliPath, ['mcp', 'set', 'o8', payload]);
  await execFileAsync(set.command, set.args, {
    env: providerSpawnEnvironment(childEnvironment({ ...{ runtimeId: 'openclaw' } }), { runtimeId: 'openclaw' }),
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function openclawRemove(cliPath: string): Promise<void> {
  const unset = cliInvocation(cliPath, ['mcp', 'unset', 'o8']);
  await execFileAsync(unset.command, unset.args, {
    env: providerSpawnEnvironment(childEnvironment({ ...{ runtimeId: 'openclaw' } }), { runtimeId: 'openclaw' }),
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

// ── Routes ──

export async function GET(request: Request) {
  const url = new URL(request.url);
  const target = normalizeTarget(url.searchParams.get('target'));
  if (!target) {
    return NextResponse.json(
      { error: 'target must be "hermes" or "openclaw"' },
      { status: 400 },
    );
  }

  const cliPath = resolveCli(target);
  const proposed = buildServerConfig();

  if (!cliPath) {
    return NextResponse.json({
      target,
      installed: false,
      cliPath: null,
      registered: false,
      proposed,
      hint: target === 'hermes'
        ? 'Install Hermes Agent: curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash'
        : 'Install OpenClaw: npm install -g openclaw@latest',
    });
  }

  const status = target === 'hermes'
    ? await hermesStatus(cliPath)
    : await openclawStatus(cliPath);

  return NextResponse.json({
    target,
    installed: true,
    cliPath,
    registered: status.registered,
    proposed,
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as {
    target?: unknown;
    remove?: unknown;
  };
  const target = normalizeTarget(body.target);
  if (!target) {
    return NextResponse.json(
      { ok: false, error: 'target must be "hermes" or "openclaw"' },
      { status: 400 },
    );
  }

  const cliPath = resolveCli(target);
  if (!cliPath) {
    return NextResponse.json(
      {
        ok: false,
        error: `${target} CLI not found on PATH`,
        detail: target === 'hermes'
          ? 'Install Hermes Agent first, then try again.'
          : 'Install OpenClaw first, then try again.',
      },
      { status: 404 },
    );
  }

  const remove = body.remove === true;

  try {
    if (remove) {
      if (target === 'hermes') await hermesRemove(cliPath);
      else await openclawRemove(cliPath);
      return NextResponse.json({
        ok: true,
        action: 'removed',
        target,
        detail: target === 'hermes'
          ? 'Run /reload-mcp inside hermes to drop the o8 tools from your active session.'
          : 'Run `openclaw doctor` if you want to verify the change.',
      });
    }

    const server = buildServerConfig();
    if (target === 'hermes') await hermesInstall(cliPath, server);
    else await openclawInstall(cliPath, server);

    return NextResponse.json({
      ok: true,
      action: 'installed',
      target,
      detail: target === 'hermes'
        ? 'Run /reload-mcp inside hermes (or restart) to load the o8 tools.'
        : 'Restart your OpenClaw gateway / agent session to pick up the new server.',
    });
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer })?.stderr;
    const stdout = (error as { stdout?: string | Buffer })?.stdout;
    const stderrText = stderr ? (typeof stderr === 'string' ? stderr : stderr.toString('utf-8')) : '';
    const stdoutText = stdout ? (typeof stdout === 'string' ? stdout : stdout.toString('utf-8')) : '';
    const baseMessage = error instanceof Error ? error.message : String(error);
    const detail = (stderrText.trim() || stdoutText.trim() || baseMessage).slice(-1500);
    return NextResponse.json(
      {
        ok: false,
        error: `Failed to ${remove ? 'remove' : 'install'} via ${target} CLI`,
        detail,
      },
      { status: 500 },
    );
  }
}
