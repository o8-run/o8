import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FOOTPRINT_BUDGET,
  FOOTPRINT_SAMPLE_LIMITS,
  assertSameArtifact,
  buildFootprintSeriesReceipt,
  collectFootprintReceipt,
  computeArtifactDigest,
  descendantPids,
  evaluateFootprintBudget,
  parseCpuTimeSeconds,
  parseFootprintBytes,
  parseProcessTable,
  resolveIdleSampleCount,
  sanitizeCommandDescriptor,
  webkitPids,
} from '../scripts/lib/footprint-budget.mjs';

const MIB = 1024 * 1024;

function processTableOutput(extra = '') {
  return `
100 1 Thu Aug 27 07:00:00 2026 0:10.00 /bundle/o8
101 100 Thu Aug 27 07:00:01 2026 0:04.00 next-server (v16)
102 100 Thu Aug 27 07:00:01 2026 0:02.00 /bundle/ws-server.mjs
201 1 Thu Aug 27 07:00:02 2026 0:03.00 /System/WebKit.framework/WebKit.WebContent.xpc/Contents/MacOS/WebKit.WebContent
${extra}`;
}

function processTable(extra = '') {
  return parseProcessTable(processTableOutput(extra));
}

describe('footprint budget', () => {
  it('parses physical-footprint and CPU-time units', () => {
    expect(parseFootprintBytes('o8 [1]: Footprint: 490 MB (4096 bytes per page)')).toBe(490 * MIB);
    expect(parseFootprintBytes('node [2]: Footprint: 1.5 GB')).toBe(1536 * MIB);
    expect(parseCpuTimeSeconds('8:28.11')).toBeCloseTo(508.11);
    expect(parseCpuTimeSeconds('1:02:03.50')).toBeCloseTo(3723.5);
    expect(parseCpuTimeSeconds('2-01:02:03.50')).toBeCloseTo(176523.5);
  });

  it('attributes descendants and newly launched WebKit helpers without command-path guessing', () => {
    const processes = processTable('103 101 Thu Aug 27 07:00:02 2026 0:01.00 helper');
    expect([...descendantPids(processes, 100)].sort()).toEqual([100, 101, 102, 103]);
    expect([...webkitPids(processes)]).toEqual([201]);
  });

  it('fails only the regression ceiling while retaining the lower product target', () => {
    const metrics = {
      appBundleBytes: 200 * MIB,
      idlePhysicalBytes: 1100 * MIB,
      idleCpuPercent: 3,
      idleProcessChurn: 0,
      components: {
        nativeHost: { bytes: 500 * MIB, cpuPercent: 2 },
        applicationServer: { bytes: 250 * MIB, cpuPercent: 5 },
        realtimeServer: { bytes: 120 * MIB, cpuPercent: 4 },
        webkitContent: { bytes: 230 * MIB, cpuPercent: 4 },
      },
    };
    expect(metrics.idlePhysicalBytes).toBeGreaterThan(FOOTPRINT_BUDGET.targets.idlePhysicalBytes);
    expect(evaluateFootprintBudget(metrics).pass).toBe(true);
    expect(evaluateFootprintBudget({ ...metrics, idleProcessChurn: 1 }).failures)
      .toEqual([expect.objectContaining({ metric: 'idleProcessChurn' })]);
  });

  it('builds a redacted versioned receipt from the real process-table contract', () => {
    const before = processTable();
    const after = parseProcessTable(`
100 1 Thu Aug 27 07:00:00 2026 0:10.20 /bundle/o8
101 100 Thu Aug 27 07:00:01 2026 0:04.10 next-server (v16)
102 100 Thu Aug 27 07:00:01 2026 0:02.05 /bundle/ws-server.mjs
201 1 Thu Aug 27 07:00:02 2026 0:03.05 /System/WebKit.framework/WebKit.WebContent.xpc/Contents/MacOS/WebKit.WebContent
`);
    const commandOutput = new Map([
      ['100', 'o8 [100]: Footprint: 400 MB'],
      ['101', 'node [101]: Footprint: 200 MB'],
      ['102', 'node [102]: Footprint: 100 MB'],
      ['201', 'WebContent [201]: Footprint: 150 MB'],
    ]);
    const run = (command: string, args: string[]) => {
      if (command === 'du') return '204800 /redacted\n';
      if (command === 'ps') return processTableOutput();
      if (command === 'footprint') return commandOutput.get(args[1]) ?? '';
      throw new Error(`unexpected command: ${command}`);
    };
    const receipt = collectFootprintReceipt({
      rootPid: 100,
      appPath: '/redacted/app',
      dataDir: '/redacted/data',
      webkitBaseline: new Set(),
      before,
      after,
      observationMs: 10_000,
      version: '0.1.0',
      gitSha: 'abc123',
      mode: 'test',
      scenario: 'idle-hidden',
      recordedAt: '2026-08-27T00:00:00.000Z',
      run,
    });
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      budgetVersion: 5,
      scenario: 'idle-hidden',
      verdict: 'PASS',
      metrics: {
        idlePhysicalBytes: 850 * MIB,
        idleCpuPercent: 4,
        idleProcessChurn: 0,
        processChurn: { spawnedByComponent: {}, exitedByComponent: {} },
        physicalMeasurementSkippedProcessCount: 0,
        components: {
          nativeHost: { processCount: 1, bytes: 400 * MIB, cpuPercent: 2 },
          applicationServer: { processCount: 1, bytes: 200 * MIB, cpuPercent: 1 },
          realtimeServer: { processCount: 1, bytes: 100 * MIB, cpuPercent: 0.5 },
          webkitContent: { processCount: 1, bytes: 150 * MIB, cpuPercent: 0.5 },
        },
      },
    });
    expect(JSON.stringify(receipt)).not.toContain('/redacted');
  });

  it('skips a child that exits between the process snapshot and footprint probe', () => {
    const transient = '103 100 Thu Aug 27 07:00:03 2026 0:00.01 short-lived-helper';
    const before = processTable(transient);
    const after = processTable(transient);
    const commandOutput = new Map([
      ['100', 'o8 [100]: Footprint: 400 MB'],
      ['101', 'node [101]: Footprint: 200 MB'],
      ['102', 'node [102]: Footprint: 100 MB'],
      ['201', 'WebContent [201]: Footprint: 150 MB'],
    ]);
    let transientPresent = true;
    const run = (command: string, args: string[]) => {
      if (command === 'du') return '204800 /redacted\n';
      if (command === 'ps') return processTableOutput(transientPresent ? transient : '');
      if (command === 'footprint' && args[1] === '103') {
        transientPresent = false;
        throw new Error('footprint: Unable to find pid for process matching 103');
      }
      if (command === 'footprint') return commandOutput.get(args[1]) ?? '';
      throw new Error(`unexpected command: ${command}`);
    };

    const receipt = collectFootprintReceipt({
      rootPid: 100,
      appPath: '/redacted/app',
      dataDir: '/redacted/data',
      webkitBaseline: new Set(),
      before,
      after,
      observationMs: 10_000,
      version: '0.1.0',
      gitSha: 'abc123',
      mode: 'test',
      scenario: 'idle-hidden',
      recordedAt: '2026-08-27T00:00:00.000Z',
      run,
    });

    expect(receipt.verdict).toBe('PASS');
    expect(receipt.metrics.idlePhysicalBytes).toBe(850 * MIB);
    expect(receipt.metrics.physicalMeasurementSkippedProcessCount).toBe(1);
    expect(receipt.metrics.processChurn).toEqual({
      spawnedByComponent: {},
      exitedByComponent: {},
      identities: [],
      truncatedIdentityCount: 0,
    });
    expect(receipt.metrics.components.otherChild).toBeUndefined();
  });

  it('fails when footprint cannot measure a process that is still running', () => {
    const before = processTable();
    const after = processTable();
    const run = (command: string, args: string[]) => {
      if (command === 'ps') return processTableOutput();
      if (command === 'footprint' && args[1] === '100') throw new Error('footprint failed');
      throw new Error(`unexpected command: ${command}`);
    };

    expect(() => collectFootprintReceipt({
      rootPid: 100,
      appPath: '/redacted/app',
      dataDir: '/redacted/data',
      webkitBaseline: new Set(),
      before,
      after,
      observationMs: 10_000,
      version: '0.1.0',
      gitSha: 'abc123',
      mode: 'test',
      scenario: 'idle-hidden',
      recordedAt: '2026-08-27T00:00:00.000Z',
      run,
    })).toThrow('footprint failed');
  });
});

const SECRET_COMMAND = '/Users/operator/bin/ps -axo pid --token=sk-live-abcdef123456 --host=operator-macbook';

function receiptRun(psOutput: string, footprintByPid: Map<string, string>) {
  return (command: string, args: string[]) => {
    if (command === 'du') return '204800 /redacted\n';
    if (command === 'ps') return psOutput;
    if (command === 'footprint') return footprintByPid.get(args[1]) ?? `x [${args[1]}]: Footprint: 10 MB`;
    throw new Error(`unexpected command: ${command}`);
  };
}

function baseSample(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    budgetVersion: 1,
    version: '0.1.0',
    gitSha: 'abc123',
    mode: 'test',
    scenario: 'idle-hidden',
    artifactDigest: 'digest-a',
    recordedAt: '2026-08-27T00:00:00.000Z',
    metrics: {
      idlePhysicalBytes: 800 * MIB,
      idleCpuPercent: 2,
      idleProcessChurn: 0,
      idleProcessSpawnsPerMinute: 0,
      idleProcessExitsPerMinute: 0,
      physicalMeasurementSkippedProcessCount: 0,
      isolatedDataBytes: 1024,
      appBundleBytes: 200 * MIB,
      components: {},
    },
    verdict: 'PASS' as const,
    checks: [
      { metric: 'idlePhysicalBytes', actual: 800 * MIB, ceiling: 1536 * MIB, pass: true },
      { metric: 'idleCpuPercent', actual: 2, ceiling: 15, pass: true },
    ],
    ...overrides,
  };
}

describe('footprint churn identities', () => {
  it('retains a sanitized identity for every spawned and exited child', () => {
    const beforeOutput = processTableOutput('103 100 Thu Aug 27 07:00:03 2026 0:00.10 /opt/o8/bin/du -sk /Users/operator/.o8');
    const afterOutput = processTableOutput(`104 101 Thu Aug 27 07:00:04 2026 0:00.02 ${SECRET_COMMAND}`);
    const before = parseProcessTable(beforeOutput);
    const after = parseProcessTable(afterOutput);
    const footprintByPid = new Map([
      ['100', 'o8 [100]: Footprint: 400 MB'],
      ['101', 'node [101]: Footprint: 200 MB'],
      ['102', 'node [102]: Footprint: 100 MB'],
      ['104', 'probe [104]: Footprint: 5 MB'],
      ['201', 'WebContent [201]: Footprint: 150 MB'],
    ]);

    const receipt = collectFootprintReceipt({
      rootPid: 100,
      appPath: '/redacted/app',
      dataDir: '/redacted/data',
      webkitBaseline: new Set(),
      before,
      after,
      observationMs: 10_000,
      version: '0.1.0',
      gitSha: 'abc123',
      mode: 'test',
      scenario: 'idle-hidden',
      recordedAt: '2026-08-27T00:00:00.000Z',
      run: receiptRun(afterOutput, footprintByPid),
    });

    const churn = receipt.metrics.processChurn!;
    expect(receipt.metrics.idleProcessChurn).toBe(2);
    expect(churn.identities).toHaveLength(2);
    expect(churn.truncatedIdentityCount).toBe(0);
    expect(churn.identities).toEqual([
      {
        lifecycle: 'exited',
        component: 'otherChild',
        descriptor: 'diskUsageProbe',
        depthFromRoot: 1,
        parentComponent: 'nativeHost',
      },
      {
        lifecycle: 'spawned',
        component: 'otherChild',
        descriptor: 'processProbe',
        depthFromRoot: 2,
        parentComponent: 'applicationServer',
      },
    ]);
  });

  it('never leaks a home path, command line, token, or machine name into the receipt', () => {
    const afterOutput = processTableOutput(`104 100 Thu Aug 27 07:00:04 2026 0:00.02 ${SECRET_COMMAND}`);
    const receipt = collectFootprintReceipt({
      rootPid: 100,
      appPath: '/redacted/app',
      dataDir: '/redacted/data',
      webkitBaseline: new Set(),
      before: processTable(),
      after: parseProcessTable(afterOutput),
      observationMs: 10_000,
      version: '0.1.0',
      gitSha: 'abc123',
      mode: 'test',
      scenario: 'idle-hidden',
      recordedAt: '2026-08-27T00:00:00.000Z',
      run: receiptRun(afterOutput, new Map([['104', 'probe [104]: Footprint: 5 MB']])),
    });

    const serialized = JSON.stringify(receipt);
    for (const secret of ['/Users/operator', 'sk-live-abcdef123456', 'operator-macbook', '--token', '-axo pid']) {
      expect(serialized).not.toContain(secret);
    }
    // No field is derived from the raw command at all — not even a hash of it.
    expect(Object.keys(receipt.metrics.processChurn!.identities[0]).sort()).toEqual([
      'component', 'depthFromRoot', 'descriptor', 'lifecycle', 'parentComponent',
    ]);
  });

  it('reduces any unrecognized command to the closed descriptor vocabulary', () => {
    expect(sanitizeCommandDescriptor('/Users/operator/secret-tool --key=abc')).toBe('unclassified');
    expect(sanitizeCommandDescriptor('/x/next-server (v16)')).toBe('applicationServer');
    expect(sanitizeCommandDescriptor('/opt/o8/bin/du -sk /Users/operator/.o8')).toBe('diskUsageProbe');
    expect(sanitizeCommandDescriptor('/usr/bin/git status')).toBe('versionControl');
    // Two different unrecognized commands are indistinguishable by design: the
    // vocabulary is the resolution limit, and no command-derived fingerprint
    // sharpens it.
    expect(sanitizeCommandDescriptor('/Users/operator/tool-a --key=1'))
      .toBe(sanitizeCommandDescriptor('/Users/operator/tool-b --key=2'));
  });
});

describe('footprint idle sample series', () => {
  it('defaults to one sample and refuses unbounded or invalid counts', () => {
    expect(resolveIdleSampleCount(undefined)).toBe(FOOTPRINT_SAMPLE_LIMITS.defaultSamples);
    expect(resolveIdleSampleCount('')).toBe(1);
    expect(resolveIdleSampleCount('3')).toBe(3);
    expect(() => resolveIdleSampleCount('0')).toThrow('positive integer');
    expect(() => resolveIdleSampleCount('2.5')).toThrow('positive integer');
    expect(() => resolveIdleSampleCount('nine')).toThrow('positive integer');
    expect(() => resolveIdleSampleCount(String(FOOTPRINT_SAMPLE_LIMITS.maxSamples + 1)))
      .toThrow(`exceeds the bound of ${FOOTPRINT_SAMPLE_LIMITS.maxSamples}`);
  });

  it('digests the executable\'s actual bytes, not just its size and timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'o8-footprint-artifact-'));
    try {
      const binary = join(dir, 'o8');
      const identity = { version: '0.1.0', gitSha: 'abc', executablePath: binary, chunkBytes: 8 };
      writeFileSync(binary, 'AAAABBBBCCCCDDDD');
      const digest = computeArtifactDigest(dir, identity);
      expect(digest).toMatch(/^[0-9a-f]{16}$/);
      expect(computeArtifactDigest(dir, identity)).toBe(digest);

      // Same length, same mtime, different bytes: the old size+mtime digest
      // called these one artifact. The byte digest cannot.
      const before = statSync(binary);
      writeFileSync(binary, 'AAAABBBBCCCCDDDE');
      utimesSync(binary, before.atime, before.mtime);
      expect(statSync(binary).size).toBe(before.size);
      // utimesSync restores whole-millisecond precision, which is exactly what
      // the retired size+mtime digest hashed — so those inputs now collide.
      expect(Math.round(statSync(binary).mtimeMs)).toBe(Math.round(before.mtimeMs));
      expect(computeArtifactDigest(dir, identity)).not.toBe(digest);

      // Chunking is an implementation detail, never part of the identity.
      expect(computeArtifactDigest(dir, { ...identity, chunkBytes: 3 }))
        .toBe(computeArtifactDigest(dir, { ...identity, chunkBytes: 4096 }));
      // The build identity still participates.
      expect(computeArtifactDigest(dir, { ...identity, gitSha: 'def' }))
        .not.toBe(computeArtifactDigest(dir, identity));
      // Hashing reads the real file; a missing binary fails loudly.
      expect(() => computeArtifactDigest(dir, { ...identity, executablePath: join(dir, 'absent') })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the packaged Mach-O path from the app bundle by default', () => {
    const seen: string[] = [];
    const io = {
      openSync: (target: string) => { seen.push(target); return 1; },
      readSync: () => 0,
      closeSync: () => undefined,
    };
    computeArtifactDigest('/redacted/o8.app', { version: '0.1.0', gitSha: 'abc', io });
    expect(seen).toEqual(['/redacted/o8.app/Contents/MacOS/o8']);
  });

  it('reports per-sample and aggregate results and fails on the worst sample', () => {
    const samples = [
      baseSample(),
      baseSample({
        recordedAt: '2026-08-27T00:01:00.000Z',
        metrics: { ...baseSample().metrics, idlePhysicalBytes: 1600 * MIB, idleCpuPercent: 4 },
        verdict: 'FAIL' as const,
        checks: [
          { metric: 'idlePhysicalBytes', actual: 1600 * MIB, ceiling: 1536 * MIB, pass: false },
          { metric: 'idleCpuPercent', actual: 4, ceiling: 15, pass: true },
        ],
      }),
    ];
    const receipt = buildFootprintSeriesReceipt({ samples, loadScenario: { available: false, reason: 'not-requested' } });

    expect(receipt.schemaVersion).toBe(2);
    expect(receipt.sampleCount).toBe(2);
    expect(receipt.samples.map((sample) => sample.index)).toEqual([0, 1]);
    expect(receipt.aggregate.metrics.idlePhysicalBytes)
      .toEqual({ min: 800 * MIB, max: 1600 * MIB, mean: 1200 * MIB, median: 1200 * MIB });
    expect(receipt.aggregate.metrics.idleCpuPercent).toEqual({ min: 2, max: 4, mean: 3, median: 3 });
    expect(receipt.verdict).toBe('FAIL');
    expect(receipt.aggregate.failures).toEqual([expect.objectContaining({ metric: 'idlePhysicalBytes' })]);
    // The compatibility view retains the highest-memory observation; the
    // aggregate/checks above retain each metric's actual worst case.
    expect(receipt.metrics.idlePhysicalBytes).toBe(1600 * MIB);
    expect(receipt.loadScenario).toEqual({ available: false, reason: 'not-requested' });
  });

  it('refuses to aggregate samples that did not observe the same artifact', () => {
    expect(() => assertSameArtifact([])).toThrow('at least one sample');
    expect(() => assertSameArtifact([baseSample({ artifactDigest: undefined })]))
      .toThrow('requires an artifactDigest');
    expect(() => buildFootprintSeriesReceipt({
      samples: [baseSample(), baseSample({ artifactDigest: 'digest-b' })],
      loadScenario: { available: false, reason: 'not-requested' },
    })).toThrow('artifactDigest differs');
    expect(() => buildFootprintSeriesReceipt({
      samples: [baseSample(), baseSample({ scenario: 'loaded-lanes' })],
      loadScenario: { available: false, reason: 'not-requested' },
    })).toThrow('scenario differs');
  });
});

describe('gate composition', () => {
  it('builds the series receipt the gate writes from repeated real collections', () => {
    const output = processTableOutput();
    const footprintByPid = new Map([
      ['100', 'o8 [100]: Footprint: 400 MB'],
      ['101', 'node [101]: Footprint: 200 MB'],
      ['102', 'node [102]: Footprint: 100 MB'],
      ['201', 'WebContent [201]: Footprint: 150 MB'],
    ]);
    const artifactDigest = computeArtifactDigest('/redacted/o8.app', {
      version: '0.1.0',
      gitSha: 'abc123',
      io: { openSync: () => 1, readSync: () => 0, closeSync: () => undefined },
    });
    const samples = [0, 1].map((index) => collectFootprintReceipt({
      rootPid: 100,
      appPath: '/redacted/app',
      dataDir: '/redacted/data',
      webkitBaseline: new Set(),
      before: processTable(),
      after: processTable(),
      observationMs: 15_000,
      version: '0.1.0',
      gitSha: 'abc123',
      mode: 'fail-fast',
      scenario: 'idle-hidden',
      artifactDigest,
      recordedAt: `2026-08-27T00:0${index}:00.000Z`,
      run: receiptRun(output, footprintByPid),
    }));

    const receipt = buildFootprintSeriesReceipt({
      samples,
      loadScenario: { available: false, reason: 'not-requested' },
    });

    expect(receipt).toMatchObject({
      schemaVersion: 2,
      budgetVersion: 5,
      sampleCount: 2,
      artifactDigest,
      verdict: 'PASS',
      loadScenario: { available: false, reason: 'not-requested' },
    });
    expect(receipt.aggregate.metrics.idlePhysicalBytes).toEqual({
      min: 850 * MIB,
      max: 850 * MIB,
      mean: 850 * MIB,
      median: 850 * MIB,
    });
    expect(receipt.metrics.idleProcessChurn).toBe(0);
    expect(JSON.stringify(receipt)).not.toContain('/redacted');
  });
});
