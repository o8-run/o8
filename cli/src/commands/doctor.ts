/**
 * `o8 doctor` — verify port + token resolution, ping the server, report drift.
 *
 * Drift means the disk port and the actually-reachable port disagree. Useful
 * after a sidecar restart that picked a different port.
 */

import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { printHumanHeading, printHumanKv, printJson, type OutputMode } from '../output.js';
import { repairCliInstall, type CliInstallResult } from './install.js';

interface ReapCandidate {
  lane: {
    id: string;
    label: string;
    packetId: string | null;
    status: string;
    repoPath: string;
    branch: string;
    sessionKey: string | null;
  };
  staleMs: number;
  lastHeartbeatAt: number | null;
  probe: {
    source: string;
    pid?: number;
    sessionName?: string;
    note?: string;
  };
  reason: string;
}

interface ReapResponse {
  ok: boolean;
  candidates: ReapCandidate[];
  reaped?: Array<{ candidate: ReapCandidate }>;
}

interface CodexVoiceDoctorCapability {
  capable: boolean;
  whyNot: string | null;
  appServer: {
    transports: string[];
  };
  auth: {
    mode: string;
  };
}

interface TerminalPersistenceHealth {
  status: 'unverified' | 'ready' | 'degraded' | 'disabled';
  reason: string;
  checkedAt: string;
}

function parseDoctorArgs(rest: string[]) {
  let reap = false;
  let force = false;
  let repair = false;
  for (const tok of rest) {
    if (tok === '--reap') reap = true;
    else if (tok === '--force') force = true;
    else if (tok === '--repair') repair = true;
    else {
      throw new CliError('invalid_args', `Unknown doctor flag: ${tok}`, EXIT.INVALID_ARGS);
    }
  }
  if (force && !reap) {
    throw new CliError('invalid_args', '`o8 doctor --force` requires --reap.', EXIT.INVALID_ARGS);
  }
  return { reap, force, repair };
}

export async function runDoctor(mode: OutputMode, rest: string[] = []): Promise<number> {
  const args = parseDoctorArgs(rest);
  const cfg = resolveConfig();
  const findings: Array<{ level: 'info' | 'warn' | 'error'; code: string; message: string }> = [];
  let reapPayload: ReapResponse | null = null;
  let repairPayload: CliInstallResult | null = null;

  if (args.repair) {
    repairPayload = repairCliInstall(process.argv[1] ?? '');
    if (!repairPayload.installedAt) {
      findings.push({
        level: 'error',
        code: 'cli_install_failed',
        message: 'Could not install the o8 CLI symlink. See repair.candidates for details.',
      });
    } else if (!repairPayload.onPath) {
      findings.push({
        level: 'warn',
        code: 'cli_not_on_path',
        message: `o8 is installed at ${repairPayload.installedAt}, but that directory is not on PATH.`,
      });
    }
    if (!repairPayload.nodeResolvable) {
      findings.push({
        level: 'error',
        code: 'node_not_resolvable',
        message: 'Node.js is not resolvable from this shell. Install Node 22 or relaunch o8 so O8_NODE_BIN can be injected.',
      });
    }
  }

  let serverReachable = false;
  let serverPayload: Record<string, unknown> | null = null;
  let terminalPersistence: TerminalPersistenceHealth | null = null;
  try {
    const res = await apiFetch<Record<string, unknown>>(cfg, '/api/panel/status');
    serverReachable = res.status === 200;
    serverPayload = res.data ?? null;
  } catch (err) {
    serverReachable = false;
    findings.push({
      level: 'error',
      code: (err as { code?: string }).code ?? 'unreachable',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const terminalCandidate = serverPayload?.terminalPersistence as Partial<TerminalPersistenceHealth> | undefined;
  if (
    terminalCandidate
    && (terminalCandidate.status === 'unverified'
      || terminalCandidate.status === 'ready'
      || terminalCandidate.status === 'degraded'
      || terminalCandidate.status === 'disabled')
    && typeof terminalCandidate.reason === 'string'
    && typeof terminalCandidate.checkedAt === 'string'
  ) {
    terminalPersistence = terminalCandidate as TerminalPersistenceHealth;
  }
  if (terminalPersistence?.status === 'degraded') {
    findings.push({
      level: 'warn',
      code: 'persistent_terminal_degraded',
      message: `Persistent terminals fell back to plain shells (${terminalPersistence.reason}).`,
    });
  } else if (terminalPersistence?.status === 'unverified') {
    findings.push({
      level: 'info',
      code: 'persistent_terminal_unverified',
      message: 'Persistent terminals are enabled but no real dashboard shell has receipted the backing path yet.',
    });
  }

  if (serverReachable && !cfg.token && cfg.source.port !== 'env') {
    findings.push({
      level: 'info',
      code: 'no_token',
      message: 'No bearer token found. Loopback fetches still work; cross-origin will 401.',
    });
  }
  if (cfg.source.port === 'default') {
    findings.push({
      level: 'warn',
      code: 'default_port',
      message: 'No api-port file on disk; using fallback 3001. Sidecar may not have started.',
    });
  }
  if (cfg.source.port === 'cortex-ide-dir' || cfg.source.token === 'cortex-ide-dir') {
    findings.push({
      level: 'info',
      code: 'legacy_data_dir',
      message: 'Reading config from ~/.cortex-ide/ (legacy). New installs use ~/.o8/.',
    });
  }

  if (args.reap && serverReachable) {
    const res = await apiFetch<ReapResponse>(cfg, '/api/lanes/reap', {
      method: 'POST',
      body: { force: args.force },
    });
    reapPayload = res.data;
  }

  // Runtime readiness — binary present AND its auth (key/login) configured.
  // Sourced from /api/setup/detect so the CLI stays in lockstep with the GUI dots.
  type DetectRuntime = { id: string; name: string; detected: boolean; ready?: boolean; authHint?: string; version?: string };
  let runtimes: DetectRuntime[] = [];
  let codexVoiceCapability: CodexVoiceDoctorCapability | null = null;
  if (serverReachable) {
    try {
      const res = await apiFetch<{
        tools: DetectRuntime[];
        codexVoiceCapability?: CodexVoiceDoctorCapability;
      }>(cfg, '/api/setup/detect');
      const ids = ['codex', 'claude-code', 'antigravity', 'opencode', '3code', 'pi'];
      runtimes = (res.data?.tools ?? []).filter((t) => ids.includes(t.id));
      codexVoiceCapability = res.data?.codexVoiceCapability ?? null;
    } catch {
      // best-effort; server reachability is already reported above
    }
  }
  for (const rt of runtimes) {
    if (rt.detected && rt.ready === false) {
      findings.push({
        level: 'warn',
        code: 'runtime_auth_missing',
        message: `${rt.name}: installed but not authed — ${rt.authHint ?? 'configure its API key/login'}.`,
      });
    }
  }

  const payload = {
    schema: 'o8/cli/doctor/v1',
    ok: serverReachable && !findings.some((f) => f.level === 'error'),
    config: {
      apiPort: cfg.apiPort,
      apiBase: cfg.apiBase,
      portSource: cfg.source.port,
      tokenPresent: cfg.token != null,
      tokenSource: cfg.source.token,
      dataDir: cfg.dataDir,
    },
    server: {
      reachable: serverReachable,
      response: serverPayload,
    },
    reap: reapPayload ? {
      force: args.force,
      candidates: reapPayload.candidates,
      reaped: reapPayload.reaped ?? [],
    } : null,
    repair: repairPayload,
    runtimes: runtimes.map((rt) => ({
      id: rt.id,
      name: rt.name,
      detected: rt.detected,
      ready: rt.ready ?? rt.detected,
      authHint: rt.authHint ?? null,
    })),
    codexVoiceCapability,
    terminalPersistence,
    findings,
  };

  if (mode.human) {
    printHumanHeading('o8 doctor');
    printHumanKv([
      ['api port', String(cfg.apiPort)],
      ['port source', cfg.source.port],
      ['token', cfg.token ? `present (${cfg.source.token})` : 'none'],
      ['data dir', cfg.dataDir ?? '(none)'],
      ['reachable', serverReachable ? 'yes' : 'no'],
      ['terminal persistence', terminalPersistence ? `${terminalPersistence.status} (${terminalPersistence.reason})` : 'unknown'],
    ]);
    if (repairPayload) {
      printHumanHeading('cli repair');
      printHumanKv([
        ['source', repairPayload.source],
        ['installed at', repairPayload.installedAt ?? '(not installed)'],
        ['on PATH', repairPayload.onPath ? 'yes' : 'no'],
        ['node', repairPayload.nodeBin ?? 'missing'],
      ]);
      for (const candidate of repairPayload.candidates) {
        process.stdout.write(`  ${candidate.path}: ${candidate.status} — ${candidate.detail}\n`);
      }
    }
    if (runtimes.length > 0) {
      printHumanHeading('runtimes');
      for (const rt of runtimes) {
        const state = !rt.detected
          ? 'not installed'
          : rt.ready === false ? 'auth missing' : 'ready';
        const extra = !rt.detected
          ? ''
          : rt.ready === false
            ? ` — ${rt.authHint ?? ''}`
            : rt.version ? ` (${rt.version})` : '';
        process.stdout.write(`  ${rt.name}: ${state}${extra}\n`);
      }
    }
    if (codexVoiceCapability) {
      const state = codexVoiceCapability.capable
        ? `ready (${codexVoiceCapability.auth.mode}; ${codexVoiceCapability.appServer.transports.join(', ')})`
        : `unavailable — ${codexVoiceCapability.whyNot ?? 'capability could not be confirmed'}`;
      process.stdout.write(`  Codex Connected Voice: ${state}\n`);
    }
    if (findings.length > 0) {
      printHumanHeading('findings');
      for (const f of findings) {
        process.stdout.write(`  [${f.level}] ${f.code} — ${f.message}\n`);
      }
    }
    if (reapPayload) {
      printHumanHeading(args.force ? 'reaped zombie lanes' : 'zombie lane candidates');
      if (reapPayload.candidates.length === 0) {
        process.stdout.write('  none\n');
      } else {
        for (const candidate of reapPayload.candidates) {
          const age = Math.round(candidate.staleMs / 1000);
          const owner = candidate.probe.pid
            ? `pid ${candidate.probe.pid}`
            : candidate.probe.sessionName
              ? `session ${candidate.probe.sessionName}`
              : candidate.probe.source;
          process.stdout.write(
            `  ${candidate.lane.id} ${candidate.lane.packetId ?? '(no packet)'} ${candidate.lane.branch} — stale ${age}s, owner ${owner}\n`,
          );
        }
      }
    }
    process.stdout.write(`\n${payload.ok ? 'OK' : 'FAIL'}\n`);
  } else {
    printJson(payload);
  }

  return payload.ok ? 0 : 1;
}
