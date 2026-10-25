#!/usr/bin/env node

/**
 * Read-only structural certification for every runtime o8 advertises as
 * dispatchable. This deliberately does not launch a paid agent turn.
 *
 * Run with:
 *   node scripts/certify-runtimes.mjs
 */

import './register-server-only-stub.mjs';

import { execFile, spawnSync, childEnvironment, configuredMcpEnvironment } from './lib/runtime-payer.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TSX_MARKER = 'O8_RUNTIME_CERTIFY_TSX_LOADER';

if (process.env[TSX_MARKER] !== '1') {
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      env: childEnvironment({ env: { [TSX_MARKER]: '1' } }),
      stdio: 'inherit',
    },
  );
  process.exit(child.status ?? 1);
}

const CAPABILITY_LABELS = {
  discover: 'discover',
  readTranscript: 'read',
  launch: 'launch',
  resume: 'resume',
  interrupt: 'interrupt',
  reviewDiffs: 'review',
  costTelemetry: 'cost',
  streaming: 'stream',
};

const ADAPTER_METHODS = {
  discover: 'discoverSessions',
  readTranscript: 'readTranscript',
  launch: 'launch',
  resume: 'resume',
  interrupt: 'interrupt',
  reviewDiffs: 'getChangedFiles',
};

const BUILTIN_HELP_PROBES = {
  codex: [
    { args: ['--help'], expected: ['exec'] },
    {
      args: ['exec', '--help'],
      expected: ['--json', '--dangerously-bypass-approvals-and-sandbox', '-C', '--ignore-user-config'],
    },
    {
      args: ['exec', 'resume', '--help'],
      expected: ['--json', '--dangerously-bypass-approvals-and-sandbox', '--ignore-user-config'],
    },
  ],
  'claude-code': [{
    args: ['--help'],
    expected: [
      '--input-format',
      '--output-format',
      '--permission-mode',
      '--include-partial-messages',
      '--model',
      '--resume',
    ],
  }],
  gemini: [{
    args: ['--help'],
    expected: ['--prompt', '--yolo', '--output-format', '--model', '--resume'],
  }],
  opencode: [{
    args: ['run', '--help'],
    expected: ['--format', '--model', '--session'],
  }],
  pi: [{
    args: ['--help'],
    expected: ['--mode', 'rpc', '--session', '--model'],
  }],
  cursor: [{
    args: ['--help'],
    expected: ['-p', '--output-format', '--resume', '--model'],
  }],
  grok: [{
    args: ['--help'],
    expected: ['-p', '--json-schema', '--session', '--model'],
  }],
};

function moduleExports(module) {
  return module.default && typeof module.default === 'object'
    ? { ...module.default, ...module }
    : module;
}

function stripAnsi(value) {
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function compact(value, max = 180) {
  const normalized = stripAnsi(value).replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function formatCell(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replace(/\r?\n/g, ' ')
    .trim() || '—';
}

function runCli(binaryPath, args, timeoutMs = 8_000) {
  return new Promise((resolve) => {
    execFile(binaryPath, args, {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env: configuredMcpEnvironment(binaryPath, {
        CI: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        PAGER: 'cat',
        TERM: 'dumb',
      }, true, args),
    }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
      resolve({
        ok: !error,
        output,
        reason: error
          ? error.killed
            ? `timed out after ${timeoutMs}ms`
            : compact(error.message)
          : null,
      });
    });
  });
}

function declarativeHelpProbes(manifest) {
  const launchArgs = manifest.launchArgs.filter((arg) => typeof arg === 'string');
  const subcommand = launchArgs.find((arg, index) =>
    index === 0 && !arg.startsWith('-') && !arg.includes('{{'));
  const expected = [...new Set(launchArgs.filter((arg) =>
    arg.startsWith('-') && !arg.includes('{{')))];
  return [{
    args: subcommand ? [subcommand, '--help'] : ['--help'],
    expected: subcommand ? [subcommand, ...expected] : expected,
  }];
}

function helpProbesFor(runtimeId, capability) {
  if (capability.declarative) return declarativeHelpProbes(capability.declarative);
  return BUILTIN_HELP_PROBES[runtimeId] ?? [];
}

function declaredCapabilityList(adapter) {
  return Object.entries(CAPABILITY_LABELS)
    .filter(([key]) => adapter.capabilities[key] === true)
    .map(([, label]) => label);
}

async function runDiscovery(adapter) {
  let timer;
  try {
    const sessions = await Promise.race([
      adapter.discoverSessions(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out after 10s')), 10_000);
      }),
    ]);
    return {
      ok: true,
      count: Array.isArray(sessions) ? sessions.length : 0,
      reason: null,
    };
  } catch (error) {
    return {
      ok: false,
      count: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function verifyHelpSurface(binaryPath, probes) {
  if (probes.length === 0) {
    return { ok: false, missing: ['structural probe contract'], details: [] };
  }
  const missing = [];
  const details = [];
  for (const probe of probes) {
    const result = await runCli(binaryPath, probe.args);
    if (!result.ok && !result.output) {
      missing.push(`${probe.args.join(' ')} (${result.reason ?? 'failed'})`);
      continue;
    }
    const absent = probe.expected.filter((token) => !result.output.includes(token));
    if (absent.length > 0) {
      missing.push(...absent.map((token) => `${probe.args.join(' ')}:${token}`));
    }
    details.push({
      args: probe.args,
      output: result.output,
      missing: absent,
    });
  }
  return { ok: missing.length === 0, missing, details };
}

async function certifyRuntime({
  runtimeId,
  capability,
  adapter,
  costParser,
  scanForBinary,
}) {
  const registryIssues = [];
  if (!adapter) {
    registryIssues.push('adapter is not registered');
  }
  if (!costParser) {
    registryIssues.push('cost parser is not registered');
  }
  if (!capability.label?.trim()) registryIssues.push('label is empty');
  if (!capability.accentColor?.trim()) registryIssues.push('accent is empty');
  if (adapter && adapter.capabilities.launch !== capability.dispatchable) {
    registryIssues.push(
      `dispatchable=${capability.dispatchable} but adapter launch=${adapter.capabilities.launch}`,
    );
  }
  for (const method of Object.values(ADAPTER_METHODS)) {
    if (adapter && typeof adapter[method] !== 'function') {
      registryIssues.push(`adapter method ${method} is missing`);
    }
  }
  if (adapter?.capabilities.costTelemetry && typeof adapter.getTelemetry !== 'function') {
    registryIssues.push('costTelemetry=true but getTelemetry is missing');
  }

  const binaryPath = scanForBinary(capability.binaryName);
  const discovery = adapter
    ? await runDiscovery(adapter)
    : { ok: false, count: 0, reason: 'adapter missing' };
  if (!discovery.ok) registryIssues.push(`discovery failed: ${discovery.reason}`);

  const declared = adapter ? declaredCapabilityList(adapter) : [];
  const verified = [];
  if (adapter && discovery.ok && adapter.capabilities.discover) verified.push('discover');
  if (adapter && typeof adapter.readTranscript === 'function' && adapter.capabilities.readTranscript) {
    verified.push('read');
  }
  if (adapter && typeof adapter.interrupt === 'function' && adapter.capabilities.interrupt) {
    verified.push('interrupt');
  }
  if (adapter && typeof adapter.getChangedFiles === 'function' && adapter.capabilities.reviewDiffs) {
    verified.push('review');
  }
  if (adapter?.capabilities.costTelemetry && costParser && typeof adapter.getTelemetry === 'function') {
    verified.push('cost');
  }

  let version = '—';
  let help = { ok: false, missing: ['CLI missing'], details: [] };
  if (binaryPath) {
    const versionResult = await runCli(binaryPath, ['--version'], 5_000);
    version = compact(versionResult.output || versionResult.reason || 'unknown', 80);
    help = await verifyHelpSurface(binaryPath, helpProbesFor(runtimeId, capability));
    if (help.ok && adapter?.capabilities.launch) verified.push('launch');
    if (help.ok && adapter?.capabilities.resume) verified.push('resume');
    if (help.ok && adapter?.capabilities.streaming) verified.push('stream');
  }

  const missingDeclared = declared.filter((item) => !verified.includes(item));
  let verdict;
  let reason;
  if (registryIssues.length > 0) {
    verdict = 'MISMATCH';
    reason = registryIssues.join('; ');
  } else if (!binaryPath) {
    verdict = 'MISSING-CLI';
    reason = `${capability.binaryName} not found; discovery returned ${discovery.count} session(s)`;
  } else if (!help.ok || missingDeclared.length > 0) {
    verdict = 'MISMATCH';
    const parts = [];
    if (!help.ok) parts.push(`help missing ${help.missing.join(', ')}`);
    if (missingDeclared.length > 0) parts.push(`unverified ${missingDeclared.join(', ')}`);
    reason = parts.join('; ');
  } else {
    verdict = 'PASS';
    reason = `${binaryPath}; discovery returned ${discovery.count} session(s)`;
  }

  return {
    runtimeId,
    binaryName: capability.binaryName,
    binaryFound: binaryPath ? 'yes' : 'no',
    version,
    declared: declared.join(','),
    verified: verified.join(','),
    verdict,
    reason,
  };
}

function renderMatrix(rows) {
  const lines = [
    '| Runtime | Binary | Found | Version | Declared caps | Structurally verified | Verdict | Reason |',
    '|---|---|---:|---|---|---|---|---|',
  ];
  for (const row of rows) {
    lines.push([
      row.runtimeId,
      row.binaryName,
      row.binaryFound,
      row.version,
      row.declared,
      row.verified,
      row.verdict,
      row.reason,
    ].map(formatCell).join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  return lines.join('\n');
}

async function main() {
  const isolatedDataDir = await mkdtemp(path.join(os.tmpdir(), 'o8-runtime-cert-'));
  const priorDataDir = process.env.CORTEX_IDE_DATA_DIR;
  process.env.CORTEX_IDE_DATA_DIR = isolatedDataDir;

  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  try {
    const runtimeModule = moduleExports(await import('../src/lib/runtimes/index.ts'));
    const capabilityModule = moduleExports(
      await import('../src/lib/orchestrator/runtime-capabilities.ts'),
    );
    const locateModule = moduleExports(
      await import('../src/lib/runtimes/shared/cli-locate.ts'),
    );
    const adaptersById = new Map(
      runtimeModule.getAllRuntimes().map((runtime) => [runtime.id, runtime]),
    );
    const rows = [];
    for (const runtimeId of capabilityModule.listDispatchableRuntimes()) {
      rows.push(await certifyRuntime({
        runtimeId,
        capability: capabilityModule.ORCHESTRATOR_RUNTIMES[runtimeId],
        adapter: adaptersById.get(runtimeId),
        costParser: runtimeModule.getCostParser(runtimeId),
        scanForBinary: locateModule.scanForBinary,
      }));
    }

    process.stdout.write(`${renderMatrix(rows)}\n`);
    const mismatches = rows.filter((row) => row.verdict === 'MISMATCH');
    if (mismatches.length > 0) {
      process.stdout.write(`\nMISMATCHES=${mismatches.length}\n`);
      process.exitCode = 1;
    }
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    if (priorDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
    else process.env.CORTEX_IDE_DATA_DIR = priorDataDir;
    await rm(isolatedDataDir, { recursive: true, force: true });
  }
}

await main();
