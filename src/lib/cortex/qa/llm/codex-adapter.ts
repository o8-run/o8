import { childEnvironment } from '@/lib/providers/spawn-environment';
import { providerSpawnEnvironment } from '@/lib/providers/spawn-environment';
/**
 * Codex CLI adapter for the Cortex Q&A layer (epic #915 path-to-70 phase 1.7 v2).
 *
 * Single-purpose, non-streaming wrapper around `codex exec --skip-git-repo-check
 * --output-last-message <tmpfile> -m <model>`. Sits as the second free-tier
 * fallback in the Class A chain, after Haiku CLI:
 *
 *   composeClassA():  Haiku CLI → Codex CLI → OpenRouter → Flash → Sonnet → heuristic
 *   classifyQuestion: Haiku CLI → Codex CLI → OpenRouter → Flash → heuristic
 *
 * Why a CLI tier (not API):
 *   - The founder has the ChatGPT Plus / Codex subscription, so the CLI is
 *     free (uses the sub's quota). Two free paths beat one for users with
 *     either Claude Max or ChatGPT Plus — most have one or the other.
 *   - No OPENAI_API_KEY needed, no billing leak.
 *
 * Why a separate adapter (vs. extending haiku-adapter):
 *   - Different binary (`codex` vs `claude`), different output mechanism
 *     (Codex writes the final message to a tmpfile; Claude streams JSON to
 *     stdout). Mixing them would muddle the parser.
 *   - Codex bootstrap + reasoning is ~15-16s for trivial prompts (verified
 *     live with gpt-5.4). The default 30s timeout reflects this.
 */

import 'server-only';

import { execFile, spawn } from '@/lib/providers/child-process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveBrainCodexRouteSync } from '@/lib/operator/brain-routing';
import { codexModelArgs } from '@/lib/codex/local-model';
import { resolveCodexReasoningEffort } from '@/lib/codex/reasoning-effort';
import { assertRuntimeEffortPin } from '@/lib/orchestrator/effort-pin';
import type { ManualThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { MODEL_IDS } from '@/lib/models';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';

const execFileAsync = promisify(execFile);

// ── Shared binary detection ──────────────────────────────────────────────────

let cachedCodexBin: string | null | undefined;

/**
 * Resolve the `codex` binary the same way haiku-adapter resolves `claude`:
 * env override → which → login-shell probe (zsh -lic 'command -v codex').
 *
 * Result is cached per-process. `undefined` = not yet probed,
 * `null` = probed and not found.
 */
async function resolveCodexBin(): Promise<string | null> {
  if (cachedCodexBin !== undefined) return cachedCodexBin;

  // 1. Explicit env override (matches the runtime adapter convention).
  for (const envKey of ['O8_CODEX_BIN', 'CODEX_BIN']) {
    const val = process.env[envKey];
    if (val) {
      cachedCodexBin = val;
      return cachedCodexBin;
    }
  }

  // 2. which codex
  try {
    const { stdout } = await execFileAsync('which', ['codex'], { windowsHide: true, timeout: 3_000 });
    const found = stdout.trim();
    if (found) {
      cachedCodexBin = found;
      return cachedCodexBin;
    }
  } catch {
    // not on PATH — try login shell
  }

  // 3. Login-shell probe (catches nvm/fnm/volta binaries — same as Sonnet/Haiku).
  const userShell = process.env.SHELL ?? 'zsh';
  for (const sh of [userShell, 'zsh', 'bash', 'sh']) {
    try {
      const { stdout } = await execFileAsync(sh, ['-l', '-c', 'command -v codex'], {
        windowsHide: true,
        timeout: 10_000,
        env: providerSpawnEnvironment(childEnvironment({ runtimeId: 'codex', env: { FORCE_COLOR: '0', NO_COLOR: '1' } }), { runtimeId: 'codex' }),
      });
      const found = stdout.trim();
      if (found) {
        cachedCodexBin = found;
        return cachedCodexBin;
      }
    } catch {
      // shell not available or command failed
    }
  }

  cachedCodexBin = null;
  return null;
}

/** Force re-detection on next call (useful for testing). */
export function resetCodexProviderCache(): void {
  cachedCodexBin = undefined;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface CallCodexOptions {
  /** Model to pass to `codex exec -m`. Default: the operator's Brain route. */
  model?: string;
  /** Explicit resolved binary, used when the caller already ran auth detection. */
  binary?: string;
  /** Optional Codex config effort passed as `-c model_reasoning_effort=...`. */
  reasoningEffort?: ManualThinkingEffort;
  /** CLI invocation timeout. Default 30s — Codex bootstrap is ~15s. */
  timeoutMs?: number;
  readOnly?: boolean;
}

/** Default Engineering Brain Codex model when operator settings are unavailable. */
export const CODEX_DEFAULT_MODEL = MODEL_IDS.codexWorkerDefault;

/**
 * Resolve the explicit call override against the operator's Brain-only Codex
 * route. Brain model and effort are separate from worker/orchestrator defaults
 * so a visible Settings choice always matches the CLI process that launches.
 */
function resolveCodexQaRoute(options: CallCodexOptions): {
  model: string;
  reasoningEffort?: CallCodexOptions['reasoningEffort'];
} {
  let configured: ReturnType<typeof resolveBrainCodexRouteSync> = {
    model: MODEL_IDS.codexWorkerDefault,
    reasoningEffort: 'xhigh',
  };
  try {
    configured = resolveBrainCodexRouteSync();
  } catch {
    // Operator defaults unavailable: keep the conservative Brain route.
  }
  const model = options.model ?? configured.model;
  const requestedEffort = options.reasoningEffort ?? configured.reasoningEffort;
  if (requestedEffort === 'none' || requestedEffort === 'minimal') {
    assertRuntimeEffortPin('codex', model, requestedEffort);
  }
  const reasoningEffort = requestedEffort
    ? resolveCodexReasoningEffort(requestedEffort, model) as CallCodexOptions['reasoningEffort']
    : undefined;
  return { model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

export function buildCodexQaArgs(options: {
  model: string;
  outputFile: string;
  reasoningEffort?: CallCodexOptions['reasoningEffort'];
}): string[] {
  return [
    'exec',
    '--skip-git-repo-check',
    '--output-last-message', options.outputFile,
    // Local models expand to `--oss --local-provider … --model`; cloud models to
    // `--model <name>` (equivalent to the historical `-m`).
    ...codexModelArgs(options.model),
    ...(options.reasoningEffort
      ? ['-c', `model_reasoning_effort=${options.reasoningEffort}`]
      : []),
  ];
}

/** Host Node flags belong to o8, not to the CLI process launched from /tmp. */
export function buildCodexQaEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const nodeEnv = source.NODE_ENV === 'development' || source.NODE_ENV === 'test'
    ? source.NODE_ENV
    : 'production';
  const env: NodeJS.ProcessEnv = {
    ...source,
    NODE_ENV: nodeEnv,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
  delete env.NODE_OPTIONS;
  return env;
}

/**
 * Call Codex via the CLI with `prompt` on stdin and read the final answer
 * from a tmpfile written by `--output-last-message`.
 *
 * Throws on:
 *   - codex binary not found
 *   - CLI exit code non-zero
 *   - timeout exceeded
 *   - empty result tmpfile
 *
 * Caller is responsible for the fallback chain (composer/classifier each
 * have their own next-step on failure — OpenRouter → Flash → Sonnet → heuristic).
 */
export async function callCodex(prompt: string, opts: CallCodexOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const route = resolveCodexQaRoute(opts);

  const codexBin = opts.binary ?? await resolveCodexBin();
  if (!codexBin) {
    throw new Error('[qa][codex] codex CLI not found on PATH or login shell');
  }

  // Tmpfile for `--output-last-message`. Use a unique name per invocation so
  // concurrent calls don't clobber each other.
  const tmpFile = path.join(
    os.tmpdir(),
    `o8-codex-qa-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );

  const cliArgs = buildCodexQaArgs({
    model: route.model,
    outputFile: tmpFile,
    reasoningEffort: route.reasoningEffort,
  });
  if (opts.readOnly) cliArgs.push('--ignore-user-config', '--sandbox', 'read-only', '-c', 'approval_policy="never"',
    '-c', 'tools.image_generation=false', '--disable', 'apps', '--disable', 'plugins');
  console.info(`[qa][codex] launching model=${route.model} effort=${route.reasoningEffort ?? 'runtime-default'}`);

  // tmpdir cwd so no project .codex/ config bleeds in.
  const cwd = os.tmpdir();
  const env = buildCodexQaEnv();

  try {
    await new Promise<void>((resolve, reject) => {
      const launch = cliInvocation(codexBin, cliArgs);
      const child = spawn(launch.command, launch.args, {
        windowsHide: true,
        cwd,
        env: providerSpawnEnvironment(env, { runtimeId: 'codex' }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      child.stdin!.write(prompt, 'utf-8');
      child.stdin!.end();

      // Drain stdout/stderr so the OS pipe buffer doesn't fill and stall the
      // child. We don't actually read from these — the answer is in tmpFile.
      let errBuf = '';
      child.stdout!.on('data', () => { /* drain */ });
      child.stderr!.on('data', (chunk: Buffer) => { errBuf += chunk.toString(); });

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`[qa][codex] CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`[qa][codex] CLI spawn error: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`[qa][codex] CLI exited ${code}: ${errBuf.slice(0, 400)}`));
        } else {
          resolve();
        }
      });
    });

    // Read the answer from the tmpfile.
    let text = '';
    try {
      text = (await fsp.readFile(tmpFile, 'utf-8')).trim();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[qa][codex] failed to read result tmpfile: ${message}`);
    }

    if (!text) {
      throw new Error('[qa][codex] CLI produced empty result tmpfile');
    }
    return text;
  } finally {
    // Best-effort cleanup; don't mask the original error if unlink fails.
    fsp.unlink(tmpFile).catch(() => undefined);
  }
}
