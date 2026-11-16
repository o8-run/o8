import { apiFetch, CliError, EXIT, type ExitCode } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';

interface MachineDevice {
  machineId: string;
  installId: string;
  name: string;
  platform: string;
  appVersion: string;
  createdAt?: string;
  lastSeenAt?: string;
}

interface ConnectApiError {
  code?: string;
  status?: number;
  message?: string;
  deviceCap?: number;
  devices?: MachineDevice[];
}

interface ConnectApiResponse {
  ok?: boolean;
  machineId?: string | null;
  deviceCap?: number;
  disconnected?: boolean;
  currentMachineId?: string | null;
  devices?: MachineDevice[];
  error?: ConnectApiError;
  hint?: string | null;
}

type ConnectAction = 'connect' | 'status' | 'disconnect';

function schemaFor(action: ConnectAction): string {
  if (action === 'status') return 'o8/cli/connect-status/v1';
  return `o8/cli/${action}/v1`;
}

function exitFor(code: string): ExitCode {
  if (code === 'auth_required') return EXIT.UNAUTHORIZED;
  if (code === 'unsupported') return EXIT.NOT_FOUND;
  if (code === 'device_cap') return EXIT.CONFLICT;
  if (code === 'network_error') return EXIT.CONNECTION_REFUSED;
  return EXIT.INVALID_ARGS;
}

function deviceLine(device: MachineDevice, currentMachineId?: string | null): string {
  const current = device.machineId === currentMachineId ? ' (this machine)' : '';
  return `  ${device.name} — ${device.platform} — ${device.machineId}${current}\n`;
}

function printFailure(
  mode: OutputMode,
  action: ConnectAction,
  data: ConnectApiResponse,
): ExitCode {
  const code = data.error?.code ?? 'connect_failed';
  const message = data.error?.message ?? 'The o8 machine connection request failed.';
  const hint = data.hint ?? null;
  const payload = {
    schema: schemaFor(action),
    ok: false,
    error: {
      code,
      status: data.error?.status ?? null,
      message,
      deviceCap: data.error?.deviceCap ?? null,
      devices: data.error?.devices ?? [],
    },
    hint,
  };

  if (mode.human) {
    process.stderr.write(`error: ${code}\n`);
    process.stderr.write(`  ${message}\n`);
    if ((data.error?.devices?.length ?? 0) > 0) {
      process.stderr.write('  connected devices:\n');
      for (const device of data.error?.devices ?? []) {
        process.stderr.write(deviceLine(device));
      }
    }
    if (hint) process.stderr.write(`  hint: ${hint}\n`);
  } else {
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
  return exitFor(code);
}

function printDevices(devices: MachineDevice[], currentMachineId?: string | null): void {
  if (devices.length === 0) {
    process.stdout.write('  no connected machines\n');
    return;
  }
  for (const device of devices) process.stdout.write(deviceLine(device, currentMachineId));
}

function validateArgs(action: ConnectAction, rest: string[]): void {
  const allowed = action === 'connect' ? new Set(['--status', '--sign-in']) : new Set<string>();
  const unknown = rest.find((argument) => !allowed.has(argument));
  if (unknown) {
    throw new CliError(
      'invalid_args',
      `Unknown ${action} flag: ${unknown}`,
      EXIT.INVALID_ARGS,
      action === 'connect'
        ? 'Run `o8 connect`, `o8 connect --status` or `o8 connect --sign-in`.'
        : 'Run `o8 disconnect` without arguments.',
    );
  }
}

interface SignInResponse {
  ok?: boolean;
  status?: string;
  reason?: string;
  userCode?: string;
  verificationUrl?: string;
  expiresAt?: string;
  interval?: number;
  plan?: string | null;
  connected?: boolean;
  machineId?: string | null;
  connectError?: string | null;
}

const SIGN_IN_ROUTE = '/api/panel/auth/device/link';

/**
 * Sign in a computer that has no browser. The app asks the account service for
 * a short code; a signed-in person approves it on the verification page; the
 * app then finishes sign-in and joins the account's machines.
 */
async function runSignIn(
  mode: OutputMode,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<number> {
  const cfg = resolveConfig();
  const started = (await apiFetch<SignInResponse>(cfg, SIGN_IN_ROUTE, {
    body: { action: 'start' }, allowUnavailable: true,
  })).data;
  if (!started?.ok || !started.userCode || !started.verificationUrl || !started.expiresAt) {
    throw new CliError(
      'sign_in_unavailable',
      'The o8 account service did not issue a sign-in code.',
      EXIT.CONNECTION_REFUSED,
      'Check this computer\'s network connection and try again.',
    );
  }
  // The code goes to stderr in machine mode so stdout stays one JSON document.
  const prompt = mode.human ? process.stdout : process.stderr;
  prompt.write(`\n  Open ${started.verificationUrl} on a device where you are signed in to o8\n`);
  prompt.write(`  and enter this code:\n\n      ${started.userCode}\n\n  Waiting for approval…\n`);

  const intervalMs = Math.max(1, started.interval ?? 5) * 1000;
  const deadline = Date.parse(started.expiresAt);
  let outcome: SignInResponse | null = null;
  while (Date.now() < deadline) {
    await wait(intervalMs);
    const polled = (await apiFetch<SignInResponse>(cfg, SIGN_IN_ROUTE, {
      body: { action: 'poll' }, allowUnavailable: true, allowConflict: true,
    })).data;
    if (polled?.status === 'pending') continue;
    outcome = polled;
    break;
  }
  if (outcome?.ok !== true || outcome.status !== 'signed-in') {
    const expired = !outcome || outcome.status === 'expired' || outcome.status === 'none';
    throw new CliError(
      expired ? 'sign_in_expired' : 'sign_in_failed',
      expired
        ? 'The sign-in code expired before it was approved.'
        : `Sign-in was approved but could not finish (${outcome?.reason ?? 'unknown'}).`,
      expired ? EXIT.NOT_FOUND : EXIT.UNAUTHORIZED,
      'Run `o8 connect --sign-in` again for a new code.',
    );
  }
  if (mode.human) {
    printHumanHeading('o8 connect');
    printHumanKv([
      ['status', 'signed in'],
      ['plan', outcome.plan ?? 'unknown'],
      ['machine', outcome.connected ? outcome.machineId ?? 'connected' : `not connected (${outcome.connectError ?? 'unknown'})`],
    ]);
  } else {
    printJson({
      schema: 'o8/cli/connect-sign-in/v1', ok: true, plan: outcome.plan ?? null,
      connected: outcome.connected === true, machineId: outcome.machineId ?? null,
      connectError: outcome.connectError ?? null,
    });
  }
  return outcome.connected ? EXIT.OK : EXIT.CONFLICT;
}

export async function runConnect(
  mode: OutputMode,
  command: 'connect' | 'disconnect',
  rest: string[],
): Promise<number> {
  const action: ConnectAction = command === 'connect' && rest.includes('--status')
    ? 'status'
    : command;
  validateArgs(command, rest);
  if (command === 'connect' && rest.includes('--sign-in')) {
    if (rest.length > 1) {
      throw new CliError('invalid_args', '`--sign-in` takes no other flag.', EXIT.INVALID_ARGS, 'Run `o8 connect --sign-in`.');
    }
    return runSignIn(mode);
  }

  const method = action === 'status'
    ? 'GET'
    : action === 'disconnect' ? 'DELETE' : 'POST';
  const response = await apiFetch<ConnectApiResponse>(
    resolveConfig(),
    '/api/panel/connect',
    { method },
  );
  const data = response.data;
  if (!data) {
    throw new CliError(
      'invalid_response',
      'The o8 app returned an empty machine connection response.',
      EXIT.INVALID_ARGS,
    );
  }
  if (data.ok !== true) return printFailure(mode, action, data);

  const devices = data.devices ?? [];
  const payload = {
    schema: schemaFor(action),
    ok: true,
    machineId: data.machineId ?? null,
    currentMachineId: data.currentMachineId ?? null,
    disconnected: data.disconnected ?? null,
    deviceCap: data.deviceCap ?? null,
    devices,
  };
  if (mode.human) {
    if (action === 'connect') {
      printHumanHeading('o8 connect');
      printHumanKv([
        ['status', 'connected'],
        ['machine', data.machineId ?? 'unknown'],
        ['device cap', data.deviceCap == null ? 'unknown' : String(data.deviceCap)],
      ]);
      printDevices(devices, data.machineId);
    } else if (action === 'status') {
      printHumanHeading('o8 connect status');
      printHumanKv([
        ['this machine', data.currentMachineId ?? 'not connected'],
        ['connected', String(devices.length)],
      ]);
      printDevices(devices, data.currentMachineId);
    } else {
      printHumanHeading('o8 disconnect');
      printHumanKv([
        ['status', data.disconnected === true ? 'disconnected' : 'not connected'],
        ['machine', data.machineId ?? 'none'],
      ]);
    }
  } else {
    printJson(payload);
  }
  return EXIT.OK;
}
