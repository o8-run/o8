import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from '@/lib/providers/child-process';
import { childEnvironment } from '@/lib/providers/spawn-environment';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { EffortPinRejectionError } from '@/lib/orchestrator/effort-pin';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

const execute = promisify(execFile);
const choicesByExecutable = new Map<string, { identity: string; choices: Promise<ReadonlySet<string>> }>();

async function probeOutput(binary: string, args: string[]): Promise<string> {
  const launch = cliInvocation(binary, args);
  const { stdout } = await execute(launch.command, launch.args, {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 256 * 1024, windowsHide: true,
    env: childEnvironment({ runtimeId: 'openclaw', env: { FORCE_COLOR: '0', NO_COLOR: '1' } }),
  });
  return stdout;
}

async function probeChoices(binary: string): Promise<ReadonlySet<string>> {
  const stdout = await probeOutput(binary, ['agent', '--help']);
  // Only the option's choice list counts. Examples and unrelated prose do
  // not establish support, and wrapped help lines remain part of the list.
  const section = stdout.match(/^\s+--thinking\b[^\n]*Thinking level:\s*([\s\S]*?)(?=\n\s+-{1,2}[a-zA-Z]|\n\s*\n|(?![\s\S]))/m)?.[1];
  if (!section) throw new Error('The thinking choice list was not recognized.');
  const choices = section.replace(/\s+where supported[\s\S]*$/, '').split('|').map(choice => choice.trim()).filter(Boolean);
  if (!choices.length || choices.some(choice => !/^[a-z][a-z0-9_-]*$/i.test(choice))) {
    throw new Error('The thinking choice list was empty or unrecognized.');
  }
  return new Set(choices);
}

async function installedChoices(binary: string): Promise<ReadonlySet<string>> {
  const { dev, ino, size, mtimeMs } = await stat(binary);
  // Wrappers can retain their file identity while the installed CLI changes.
  const version = (await probeOutput(binary, ['--version']).catch(() => '')).trim();
  if (!version) {
    choicesByExecutable.delete(binary);
    return probeChoices(binary);
  }
  const identity = JSON.stringify([dev, ino, size, mtimeMs, version]);
  let entry = choicesByExecutable.get(binary);
  if (!entry || entry.identity !== identity) {
    entry = { identity, choices: probeChoices(binary) };
    choicesByExecutable.set(binary, entry);
  }
  try {
    return await entry.choices;
  } catch (error) {
    // Failed probes are retryable; only a parsed vocabulary is reusable.
    if (choicesByExecutable.get(binary) === entry) choicesByExecutable.delete(binary);
    throw error;
  }
}

/** Read the selected executable's vocabulary before starting a gateway or turn. */
export async function openclawThinkingFlag(binary: string, effort: ThinkingEffort | undefined): Promise<ThinkingEffort | null> {
  if (!effort) return null;
  try {
    if ((await installedChoices(binary)).has(effort)) return effort;
  } catch {
    // A failed or unrecognized probe cannot establish an explicit pin.
  }
  throw new EffortPinRejectionError('effort_cli_incompatible',
    `Cannot honor effort "${effort}": the installed CLI did not advertise that thinking choice. Update the CLI, choose an advertised effort, or omit the effort pin.`);
}
