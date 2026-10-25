import { unprivilegedChildEnvironment } from '../../../src/lib/providers/ambient-environment.js';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printJson, type OutputMode } from '../output.js';
import { cliInvocation } from '../../../src/lib/runtimes/shared/cli-spawn.js';

interface CiCheck {
  name: string;
  command: string[];
  featureId?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

interface CiConfig {
  schema: 'o8/ci/v1';
  repoPath?: string;
  sprintId?: string;
  checks: CiCheck[];
  skeptic?: {
    task: string;
    base?: string;
    acceptanceCriteria?: string[];
  };
}

interface CheckResult {
  name: string;
  featureId: string | null;
  command: string[];
  status: 'passed' | 'failed';
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  outputTail: string;
}

interface HarnessResponse<T> {
  ok?: boolean;
  result?: T;
  error?: { message?: string } | string;
}

function configPath(rest: string[]): string {
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === '--config') return resolve(rest[i + 1] ?? '');
    if (token.startsWith('--config=')) return resolve(token.slice('--config='.length));
    if (!token.startsWith('--')) return resolve(token);
  }
  return resolve('o8.ci.json');
}

function loadConfig(path: string): CiConfig {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new CliError('invalid_ci_config', `Unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`, EXIT.INVALID_ARGS);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError('invalid_ci_config', 'CI config must be a JSON object.', EXIT.INVALID_ARGS);
  }
  const config = value as Partial<CiConfig>;
  if (config.schema !== 'o8/ci/v1') {
    throw new CliError('invalid_ci_config', `Expected schema o8/ci/v1, received ${String(config.schema)}.`, EXIT.INVALID_ARGS);
  }
  if (!Array.isArray(config.checks) || config.checks.length === 0 || config.checks.length > 20) {
    throw new CliError('invalid_ci_config', 'checks must contain between 1 and 20 entries.', EXIT.INVALID_ARGS);
  }
  for (const check of config.checks) {
    if (!check || typeof check !== 'object' || typeof check.name !== 'string' || !check.name.trim()) {
      throw new CliError('invalid_ci_config', 'Every check requires a name.', EXIT.INVALID_ARGS);
    }
    if (!Array.isArray(check.command) || check.command.length === 0 || check.command.some((part) => typeof part !== 'string' || !part)) {
      throw new CliError('invalid_ci_config', `Check ${check.name} command must be a non-empty string array.`, EXIT.INVALID_ARGS);
    }
    if (check.command.length > 32) throw new CliError('invalid_ci_config', `Check ${check.name} has too many command arguments.`, EXIT.INVALID_ARGS);
  }
  if (config.skeptic) {
    if (typeof config.skeptic.task !== 'string' || !config.skeptic.task.trim()) {
      throw new CliError('invalid_ci_config', 'skeptic.task is required when skeptic is configured.', EXIT.INVALID_ARGS);
    }
    if (config.skeptic.acceptanceCriteria && (
      !Array.isArray(config.skeptic.acceptanceCriteria)
      || config.skeptic.acceptanceCriteria.some((item) => typeof item !== 'string')
    )) {
      throw new CliError('invalid_ci_config', 'skeptic.acceptanceCriteria must be a string array.', EXIT.INVALID_ARGS);
    }
  }
  return config as CiConfig;
}

function tail(value: string, max = 20_000): string {
  return value.length <= max ? value : value.slice(-max);
}

function runCheck(check: CiCheck, cwd: string): CheckResult {
  const startedAt = Date.now();
  const timeout = Number.isInteger(check.timeoutMs)
    ? Math.max(1_000, Math.min(60 * 60 * 1000, check.timeoutMs!))
    : 10 * 60 * 1000;
  // Checks are configured as ["npm","test"]-shaped arrays, and on Windows `npm`
  // is `npm.cmd` — spawnSync cannot run one, so every check would report a
  // spawn error rather than a result.
  const launch = cliInvocation(check.command[0], check.command.slice(1));
  const result = spawnSync(launch.command, launch.args, {
    windowsHide: true,
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: unprivilegedChildEnvironment(check.env),
    shell: false,
  });
  const output = [result.stdout ?? '', result.stderr ?? '', result.error?.message ?? '']
    .filter(Boolean)
    .join('\n');
  return {
    name: check.name,
    featureId: check.featureId?.trim() || null,
    command: check.command,
    status: result.status === 0 && !result.error ? 'passed' : 'failed',
    exitCode: result.status,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    outputTail: tail(output),
  };
}

async function harnessCall<T>(body: Record<string, unknown>, timeoutMs = 300_000): Promise<T> {
  const cfg = resolveConfig();
  const response = await apiFetch<HarnessResponse<T>>(cfg, '/api/harness', {
    method: 'POST',
    timeoutMs,
    body,
  });
  if (!response.data?.ok) {
    const error = response.data?.error;
    const message = typeof error === 'string' ? error : error?.message ?? 'Harness action failed.';
    throw new CliError('harness_action_failed', message, EXIT.CONFLICT);
  }
  return response.data.result as T;
}

function readDiff(repoPath: string, base: string | undefined): string {
  const target = base?.trim() || 'HEAD^';
  const result = spawnSync('git', ['-C', repoPath, 'diff', '--no-ext-diff', '--unified=80', `${target}...HEAD`], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
    shell: false,
  });
  if (result.status !== 0 || result.error) {
    throw new CliError('diff_failed', result.stderr || result.error?.message || `git diff exited ${result.status}`, EXIT.INVALID_ARGS);
  }
  return result.stdout;
}

export async function runCi(mode: OutputMode, rest: string[]): Promise<number> {
  const path = configPath(rest);
  const config = loadConfig(path);
  const repoPath = resolve(dirname(path), config.repoPath ?? '.');
  const checks = config.checks.map((check) => runCheck(check, repoPath));
  const ledgerResults = checks
    .filter((check) => check.featureId)
    .map((check) => ({
      featureId: check.featureId,
      status: check.status,
      evidence: check.outputTail || `${check.name} exited ${check.exitCode}`,
      command: check.command,
      exitCode: check.exitCode,
    }));
  let verification: unknown = null;
  if (ledgerResults.length > 0) {
    verification = await harnessCall({
      action: 'verify',
      repoPath,
      results: ledgerResults,
      ...(config.sprintId ? { sprintId: config.sprintId } : {}),
      note: 'Recorded by o8 ci.',
    });
  }

  let skeptic: unknown = null;
  if (config.skeptic && checks.every((check) => check.status === 'passed')) {
    skeptic = await harnessCall({
      action: 'evaluate_diff',
      repoPath,
      task: config.skeptic.task,
      diff: readDiff(repoPath, config.skeptic.base),
      acceptanceCriteria: config.skeptic.acceptanceCriteria ?? [],
    }, 600_000);
  }
  const skepticVerdict = skeptic && typeof skeptic === 'object'
    ? (skeptic as { verdict?: unknown }).verdict
    : null;
  const passed = checks.every((check) => check.status === 'passed')
    && (!config.skeptic || skepticVerdict === 'approve');
  const payload = {
    schema: 'o8/cli/ci/v1',
    config: path,
    repoPath,
    passed,
    checks,
    verification,
    skeptic,
  };
  if (mode.human) {
    printHumanHeading(passed ? 'o8 ci passed' : 'o8 ci failed');
    for (const check of checks) {
      process.stdout.write(`${check.status === 'passed' ? 'PASS' : 'FAIL'}  ${check.name}  ${check.durationMs}ms\n`);
    }
    if (skepticVerdict) process.stdout.write(`skeptic  ${String(skepticVerdict)}\n`);
  } else {
    printJson(payload);
  }
  return passed ? 0 : 1;
}
