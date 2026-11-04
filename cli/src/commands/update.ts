import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printJson, type OutputMode } from '../output.js';
import type { CliUpdateRecord } from '../../../src/lib/setup/cli-updates.js';

interface UpdateApplyResponse {
  currentVersion?: string;
  ok?: boolean;
  requested?: boolean;
  checkedAt?: string | null;
  checkAgeMs?: number | null;
  forced?: boolean;
  message?: string;
  error?: { code?: string; message?: string };
  idle?: {
    idle?: boolean;
    active?: {
      lanes?: Array<{ id?: string; label?: string; status?: string }>;
      terminalSessions?: Array<{ name?: string; kind?: string }>;
      managedRuns?: Array<{ id?: string; command?: string }>;
      ownedSessions?: Array<{ surfaceId?: string; pid?: number | null; tmuxSession?: string | null }>;
    };
    unavailable?: string[];
  };
  result?: { code?: string };
  state?: {
    version?: string | null;
    check?: {
      outcome?: string;
      checkedAt?: string | null;
      errorCode?: string | null;
      error?: string | null;
    };
  };
}

export async function runUpdate(
  mode: OutputMode,
  subcommand: string | undefined,
  rest: string[],
): Promise<number> {
  if (subcommand === undefined || subcommand === 'apply') {
    return runInstalledUpdates(mode, rest);
  }
  if (subcommand !== 'check') {
    throw new CliError(
      'unknown_update_subcommand',
      `Unknown update subcommand: ${subcommand ?? '(none)'}`,
      EXIT.INVALID_ARGS,
      'Run `o8 update [apply] [--dry-run] [--runtimes a,b] [--machines]` or `o8 update check`.',
    );
  }
  const unknown = rest[0];
  if (unknown) {
    throw new CliError(
      'unknown_update_apply_flag',
      `Unknown update check flag: ${unknown}`,
      EXIT.INVALID_ARGS,
      'Run `o8 update check` without flags.',
    );
  }

  const response = await apiFetch<UpdateApplyResponse>(
    resolveConfig(),
    '/api/panel/update/apply',
    { method: 'POST', body: { force: false, checkOnly: true }, allowConflict: true, allowUnavailable: true, timeoutMs: 35_000 },
  );
  const data = response.data ?? {};
  const payload = {
    schema: 'o8/cli/update.check/v1',
    ok: data.ok === true,
    requested: data.requested === true,
    forced: data.forced === true,
    version: data.state?.version ?? null,
    result: data.result?.code ?? null,
    check: data.state?.check ?? null,
    checkedAt: data.checkedAt ?? null,
    checkAgeMs: data.checkAgeMs ?? null,
    message: data.message ?? data.error?.message ?? null,
    error: data.error ?? null,
    idle: data.idle ?? null,
  };

  if (mode.human) {
    printHumanHeading(`o8 update ${subcommand}`);
    process.stdout.write(`  ${payload.message ?? (payload.requested ? 'Update apply requested.' : 'Update apply refused.')}\n`);
    const active = data.idle?.active;
    for (const lane of active?.lanes ?? []) {
      process.stdout.write(`  lane ${lane.label ?? lane.id ?? 'unknown'} (${lane.status ?? 'active'})\n`);
    }
    for (const session of active?.terminalSessions ?? []) {
      process.stdout.write(`  terminal ${session.name ?? 'unknown'} (${session.kind ?? 'live'})\n`);
    }
    for (const run of active?.managedRuns ?? []) {
      process.stdout.write(`  run ${run.id ?? 'unknown'}${run.command ? `: ${run.command}` : ''}\n`);
    }
    for (const session of active?.ownedSessions ?? []) {
      process.stdout.write(`  owned ${session.surfaceId ?? 'unknown'} (${session.tmuxSession ?? session.pid ?? 'live'})\n`);
    }
  } else {
    printJson(payload);
  }

  return response.status === 409 ? EXIT.CONFLICT : response.status === 503 ? EXIT.INVALID_ARGS : 0;
}

interface UpdateRow {
  machine: string;
  name: string;
  before: string | null;
  after: string | null;
  status: string;
  manager?: string;
  target?: string | null;
  plan?: string;
  message?: string;
}

function updateOptions(rest: string[]) {
  let runtimes: string[] | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--runtimes' || arg.startsWith('--runtimes=')) {
      const value = arg === '--runtimes' ? rest[++i] : arg.slice('--runtimes='.length);
      if (runtimes || !value || value.split(',').some(id => !id.trim() || id.trim().startsWith('-'))) {
        throw new CliError('invalid_update_runtimes', 'Use --runtimes a,b once with nonempty runtime names.', EXIT.INVALID_ARGS);
      }
      runtimes = [...new Set(value.split(',').map(id => id.trim() === 'claude' ? 'claude-code' : id.trim()))];
    } else if (!['--dry-run', '--machines', '--force', '--check'].includes(arg)) {
      throw new CliError('unknown_update_apply_flag', `Unknown update apply flag: ${arg}`, EXIT.INVALID_ARGS);
    }
  }
  return { runtimes, dryRun: rest.includes('--dry-run'), machines: rest.includes('--machines'),
    force: rest.includes('--force'), checkNow: rest.includes('--check') };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Use the server's inventory and original installers, including its manual-update refusals. */
async function runInstalledUpdates(mode: OutputMode, rest: string[]): Promise<number> {
  const options = updateOptions(rest);
  const config = resolveConfig();
  const results: UpdateRow[] = [];
  let failed = false;
  let tools: CliUpdateRecord[] = [];
  try {
    const inventory = await apiFetch<{ tools: CliUpdateRecord[] }>(config, '/api/setup/cli-updates', { query: { refresh: '1' } });
    if (!Array.isArray(inventory.data?.tools)) throw new Error('Runtime update inventory is unavailable.');
    tools = inventory.data.tools;
  } catch (error) {
    results.push({ machine: 'local', name: 'runtimes', before: null, after: null, status: 'failed', message: errorMessage(error) });
    failed = true;
  }
  if (options.runtimes && !failed) {
    const unknown = options.runtimes.filter(id => !tools.some(tool => tool.runtimeId === id));
    if (unknown.length) throw new CliError('unknown_update_runtime', `Unknown runtime: ${unknown.join(', ')}.`, EXIT.INVALID_ARGS);
    tools = tools.filter(tool => options.runtimes!.includes(tool.runtimeId));
  }

  if (options.machines) {
    try {
      const registry = await apiFetch<{ ok: boolean; currentMachineId?: string; devices?: Array<{ machineId: string; appVersion?: string }>;
        error?: { message?: string } }>(config, '/api/panel/connect');
      if (!registry.data?.ok || !Array.isArray(registry.data.devices)) {
        throw new Error(registry.data?.error?.message ?? 'Machine registry is unavailable.');
      }
      if (!registry.data.devices.length) {
        results.push({ machine: 'local', name: 'machines', before: null, after: null, status: 'local-only',
          message: 'No registered machines; updating this machine only.' });
      }
      for (const device of registry.data.devices) {
        if (device.machineId === registry.data.currentMachineId) continue;
        results.push({ machine: device.machineId, name: 'o8', before: device.appVersion ?? null, after: null,
          status: 'unavailable', message: 'Fleet execution is unavailable on this server. Run o8 update on this machine.' });
        failed = true;
      }
    } catch (error) {
      results.push({ machine: 'local', name: 'machines', before: null, after: null, status: 'failed', message: errorMessage(error) });
      failed = true;
    }
  }

  // Finish runtime installers before asking the native app updater to restart the server.
  for (const tool of tools) {
    const row: UpdateRow = { machine: 'local', name: tool.runtimeId, before: tool.installedVersion,
      after: tool.installedVersion, status: tool.status, manager: tool.manager, target: tool.latestVersion };
    results.push(row);
    if (tool.status === 'not-installed' || tool.status === 'current') continue;
    if (!tool.updateSupported) {
      row.status = 'manual-update';
      row.message = tool.updateHint ?? 'Use this runtime’s original installer to update it.';
      if (!options.dryRun) failed = true;
      continue;
    }
    row.plan = `Update with the detected ${tool.manager ?? 'original'} installer through /api/setup/cli-updates.`;
    if (options.dryRun) { row.status = 'planned'; continue; }
    try {
      const response = await apiFetch<{ status?: string; installedVersion?: string; error?: string; code?: string }>(
        config, '/api/setup/cli-updates', { method: 'POST', body: { runtime: tool.runtimeId },
          allowConflict: true, allowUnavailable: true, timeoutMs: 300_000 },
      );
      if (response.data?.status !== 'succeeded') throw new Error(response.data?.error ?? 'Runtime update was refused.');
      row.status = 'succeeded';
      row.after = response.data.installedVersion ?? null;
    } catch (error) {
      row.status = 'failed'; row.message = errorMessage(error); failed = true;
      // An installer may have changed the version before failing verification.
      row.after = null;
      try {
        const observed = await apiFetch<{ tools: CliUpdateRecord[] }>(config, '/api/setup/cli-updates',
          { query: { runtime: tool.runtimeId, refresh: '1' } });
        row.after = observed.data?.tools?.[0]?.installedVersion ?? null;
      } catch { /* The version remains unknown when the follow-up probe fails. */ }
    }
  }

  let before: string | null = null;
  let target: string | null = null;
  try {
    const state = await apiFetch<UpdateApplyResponse>(config, '/api/panel/update/apply');
    before = state.data?.currentVersion ?? null;
    target = state.data?.state?.version ?? null;
  } catch { /* The apply response still reports whether the app accepted an update. */ }
  const app: UpdateRow = { machine: 'local', name: 'o8', before, after: before, target,
    status: 'planned', plan: 'Request the native app updater after runtime updates finish.' };
  results.push(app);
  let appData: UpdateApplyResponse = {};
  let appExit = 0;
  if (!options.dryRun) {
    try {
      const response = await apiFetch<UpdateApplyResponse>(config, '/api/panel/update/apply', {
        method: 'POST', body: { force: options.force, ...(options.checkNow ? { checkNow: true } : {}) },
        allowConflict: true, allowUnavailable: true, timeoutMs: 35_000,
      });
      appData = response.data ?? {};
      appExit = response.status === 409 ? EXIT.CONFLICT : response.status === 503 ? EXIT.INVALID_ARGS : 0;
      app.status = appData.ok !== true ? 'failed' : appData.requested ? 'requested' : appData.result?.code ?? 'current';
      // Native apply is asynchronous; a request is not a verified installed version.
      app.after = appData.requested ? null : before;
      app.target = appData.state?.version ?? target;
      app.message = appData.message ?? appData.error?.message;
      if (appData.ok !== true) failed = true;
    } catch (error) {
      app.status = 'failed'; app.after = null; app.message = errorMessage(error); failed = true;
    }
  }
  const payload = {
    schema: 'o8/cli/update.apply/v1', ok: !failed, dryRun: options.dryRun,
    requested: appData.requested === true, forced: appData.forced === true,
    version: appData.state?.version ?? target, result: appData.result?.code ?? null,
    check: appData.state?.check ?? null, checkedAt: appData.checkedAt ?? null, checkAgeMs: appData.checkAgeMs ?? null,
    message: appData.message ?? appData.error?.message ?? null, error: appData.error ?? null, idle: appData.idle ?? null,
    results,
  };
  if (mode.human) {
    printHumanHeading(options.dryRun ? 'o8 update plan' : 'o8 update');
    process.stdout.write('machine\tname\tbefore\tafter\tstatus\tplan / message\n');
    for (const row of results) process.stdout.write([row.machine, row.name, row.before ?? '-', row.after ?? '-', row.status,
      row.message ?? row.plan ?? ''].join('\t') + '\n');
  } else printJson(payload);
  return appExit || (failed ? EXIT.INVALID_ARGS : EXIT.OK);
}
