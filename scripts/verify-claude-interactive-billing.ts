import { childEnvironment } from '../src/lib/providers/spawn-environment';
/**
 * One-shot smoke for Claude Code interactive billing routing.
 *
 * Run:
 *   npx tsx scripts/verify-claude-interactive-billing.ts
 */

import { spawn } from '../src/lib/providers/child-process';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';

const EXPECTED_API_KEY_SOURCE = 'none';
const EXPECTED_RATE_LIMIT_TYPE = 'five_hour';
const TIMEOUT_MS = Number(process.env.CLAUDE_BILLING_VERIFY_TIMEOUT_MS ?? 90_000);
const USER_MESSAGE = JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: 'say hi',
  },
});

interface ParsedEvent {
  raw: Record<string, unknown>;
  type: string | null;
  subtype: string | null;
}

interface Observations {
  initApiKeySources: string[];
  rateLimitTypes: string[];
  parsedStdoutEvents: number;
  stderrTail: string;
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function resolveClaudeBin(): string {
  const override = process.env.O8_CLAUDE_CODE_BIN?.trim()
    || process.env.CLAUDE_BIN?.trim();
  return expandHome(override || '~/.local/bin/claude');
}

function timeoutMs(): number {
  return Number.isFinite(TIMEOUT_MS) && TIMEOUT_MS > 0 ? TIMEOUT_MS : 90_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

function stringAtPath(value: Record<string, unknown>, keys: string[]): string | null {
  let cursor: unknown = value;
  for (const key of keys) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  return typeof cursor === 'string' ? cursor : null;
}

function firstStringAtPaths(value: Record<string, unknown>, paths: string[][]): string | null {
  for (const keys of paths) {
    const found = stringAtPath(value, keys);
    if (found) return found;
  }
  return null;
}

function parseEventLine(line: string): ParsedEvent | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return null;
    return {
      raw: parsed,
      type: stringField(parsed, 'type'),
      subtype: stringField(parsed, 'subtype'),
    };
  } catch {
    return null;
  }
}

function isInitEvent(event: ParsedEvent): boolean {
  return event.type === 'init'
    || event.type === 'system/init'
    || event.subtype === 'init'
    || event.type === 'system';
}

function isRateLimitEvent(event: ParsedEvent): boolean {
  return event.type === 'rate_limit_event'
    || event.type === 'system/rate_limit_event'
    || event.subtype === 'rate_limit_event'
    || event.subtype === 'rate_limit'
    || isRecord(event.raw.rate_limit_event)
    || isRecord(event.raw.rateLimitEvent);
}

function apiKeySourceFromEvent(event: ParsedEvent): string | null {
  return firstStringAtPaths(event.raw, [
    ['apiKeySource'],
    ['api_key_source'],
    ['data', 'apiKeySource'],
    ['data', 'api_key_source'],
  ]);
}

function rateLimitTypeFromEvent(event: ParsedEvent): string | null {
  return firstStringAtPaths(event.raw, [
    ['rateLimitType'],
    ['rate_limit_type'],
    ['rateLimitEvent', 'rateLimitType'],
    ['rateLimitEvent', 'rate_limit_type'],
    ['rate_limit_event', 'rateLimitType'],
    ['rate_limit_event', 'rate_limit_type'],
    ['data', 'rateLimitType'],
    ['data', 'rate_limit_type'],
  ]);
}

function observeEvent(event: ParsedEvent, observations: Observations): void {
  observations.parsedStdoutEvents += 1;

  if (isInitEvent(event)) {
    const apiKeySource = apiKeySourceFromEvent(event);
    if (apiKeySource) observations.initApiKeySources.push(apiKeySource);
  }

  if (isRateLimitEvent(event)) {
    const rateLimitType = rateLimitTypeFromEvent(event);
    if (rateLimitType) observations.rateLimitTypes.push(rateLimitType);
  }
}

function hasPassingTelemetry(observations: Observations): boolean {
  return observations.initApiKeySources.includes(EXPECTED_API_KEY_SOURCE)
    && observations.rateLimitTypes.length > 0
    && observations.rateLimitTypes.every((rateLimitType) => rateLimitType === EXPECTED_RATE_LIMIT_TYPE);
}

function formatValues(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}

function failureDetails(observations: Observations): string[] {
  return [
    `system/init apiKeySource values: ${formatValues(observations.initApiKeySources)}`,
    `rate_limit_event rateLimitType values: ${formatValues(observations.rateLimitTypes)}`,
    `parsed stdout events: ${observations.parsedStdoutEvents}`,
    observations.stderrTail.trim() ? `stderr tail:\n${observations.stderrTail.trim()}` : '',
  ].filter(Boolean);
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, 2_000).unref();
}

async function runClaudeInteractive(): Promise<Observations> {
  const args = [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  const binary = resolveClaudeBin();
  const observations: Observations = {
    initApiKeySources: [],
    rateLimitTypes: [],
    parsedStdoutEvents: 0,
    stderrTail: '',
  };

  return await new Promise<Observations>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: process.cwd(),
      env: childEnvironment({ runtimeId: 'claude-code' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    let settled = false;

    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdout.close();
      stderr.close();
      terminate(child);
      if (err) {
        reject(err);
      } else {
        resolve(observations);
      }
    };

    const timer = setTimeout(() => {
      finish(new Error([
        `timed out after ${timeoutMs()}ms`,
        ...failureDetails(observations),
      ].join('\n')));
    }, timeoutMs());

    child.on('error', (err) => {
      finish(err);
    });

    child.on('close', (exitCode, signal) => {
      if (hasPassingTelemetry(observations)) {
        finish(null);
        return;
      }

      const reason = signal ? `signal ${signal}` : `exit code ${exitCode ?? 'unknown'}`;
      finish(new Error([
        `claude exited before billing telemetry passed (${reason})`,
        ...failureDetails(observations),
      ].join('\n')));
    });

    stdout.on('line', (line) => {
      const event = parseEventLine(line);
      if (!event) return;
      observeEvent(event, observations);
      if (hasPassingTelemetry(observations)) finish(null);
    });

    stderr.on('line', (line) => {
      observations.stderrTail = `${observations.stderrTail}${line}\n`.slice(-4_000);
    });

    child.stdin.end(`${USER_MESSAGE}\n`);
  });
}

runClaudeInteractive()
  .then((observations) => {
    console.log(
      `PASS interactive Claude Code billing smoke: apiKeySource=${EXPECTED_API_KEY_SOURCE}; rate_limit_event=${EXPECTED_RATE_LIMIT_TYPE}; events=${observations.parsedStdoutEvents}`,
    );
    process.exit(0);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('FAIL interactive Claude Code billing smoke');
    console.error(`  ${message}`);
    console.error(`  binary: ${resolveClaudeBin()}`);

    process.exit(1);
  });
