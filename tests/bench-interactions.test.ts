import { longHistoryFixture } from '../scripts/bench/interactions/long-history-fixture.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildFixturePlan,
  designFixturePage,
  fixtureDigest,
  materializeFixture,
} from '../scripts/bench/interactions/fixtures.mjs';
import {
  packagedTargetIdentityProblems,
  parseTargetOption,
  releaseArtifactIdentity,
} from '../scripts/bench/interactions/targets.mjs';
import { summarizeTerminalWorkload } from '../scripts/bench/interactions/composed.mjs';
import { distribution, scenarioResult } from '../scripts/bench/interactions/statistics.mjs';
import {
  INTERACTION_BUDGETS,
  checkReceiptValidity,
  evaluateInteractionBudgets,
} from '../scripts/bench/interactions/budgets.mjs';
import {
  addOwnedProcessRoot,
  captureOwnedProcessTree,
  createOwnedProcessInventory,
  listTmuxSessions,
  snapshotProcessInventory,
  survivingOwnedProcesses,
  terminateAndWaitOwnedProcesses,
  verifyCleanup,
} from '../scripts/bench/interactions/cleanup.mjs';
import { baselineFromReceipt, deriveRunStatus } from '../scripts/bench/run-interactions.mjs';
import { interactionConfig } from '../scripts/bench/interactions/receipt.mjs';
import { stableSoakGroups } from '../scripts/bench/interactions/soak.mjs';

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function scenario(values: number[]) {
  return scenarioResult({
    samples: values.map((durationMs) => ({ durationMs, phases: {} })),
    phaseNames: ['serverWaitMs', 'mainThreadMs', 'reactCommitMs', 'presentationMs'],
  });
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'o8/interaction-performance/v1',
    target: { buildMode: 'production' },
    stack: { buildMode: 'production' },
    fixture: { scale: 50 },
    scenarios: {
      dashboard_cold_ready_ms: scenario([1200]),
      warm_relaunch_ready_ms: scenario([400]),
      first_interaction_accepted_ms: scenario([300]),
      fleet_reveal_ms: scenario([60]),
      active_context_reveal_ms: scenario([45]),
      composer_keystroke_to_paint_ms: scenario([20, 24, 26, 30, 33]),
      tab_switch_ms: scenario([90, 110, 130]),
      repo_inventory_ms: scenario([120, 140, 180]),
      design_arm_ms: scenario([90]),
      design_hover_ms: scenario([60]),
      design_select_ms: scenario([180]),
      design_prompt_ready_ms: scenario([210]),
      design_screenshot_crop_ms: scenarioResult({
        samples: [],
        phaseNames: [],
        unavailableReason: 'the embedded-browser Design Mode path does not capture a screenshot crop in this build',
      }),
    },
    soak: { longTaskMsPerMinute: 200 },
    falsification: {
      injectedDelayMs: 500,
      injectedDelayApplications: 5,
      delayExecuted: true,
      metric: 'keystroke_to_paint_ms',
      budgetFailed: true,
    },
    cleanup: { status: 'clean', residue: null },
    ...overrides,
  };
}

describe('interaction fixtures', () => {
  it('does not compare startup observations made with different measurement methods', () => {
    const current = receipt();
    Object.assign(current.scenarios.first_interaction_accepted_ms, { measurementMethod: 'page-readiness-plus-trusted-input-paint-v1' });
    const result = evaluateInteractionBudgets(current, { metrics: {
      'first_interaction_accepted_ms@50': { value: 200 },
    } });
    const startup = result.results.find((entry) => entry.metric === 'first_interaction_accepted_ms');
    expect(startup?.deltaStatus).toBe('incomparable');
    expect(startup?.deltaValue).toBeNull();
    expect(startup?.baselineValue).toBe(200);
    const compatible = evaluateInteractionBudgets(current, { metrics: {
      'first_interaction_accepted_ms@50': { value: 200, measurementMethod: 'page-readiness-plus-trusted-input-paint-v1' },
    } });
    expect(compatible.results.find((entry) => entry.metric === 'first_interaction_accepted_ms')?.deltaStatus).toBe('unchanged');
  });

  it('produces the same plan and digest for the same scale and seed', () => {
    const first = buildFixturePlan(250, 4242);
    const second = buildFixturePlan(250, 4242);
    expect(second).toEqual(first);
    expect(fixtureDigest(second)).toBe(fixtureDigest(first));
    expect(first.repos).toHaveLength(250);
  });

  it('generates a byte-identical Design Mode fixture page for a given seed', () => {
    expect(designFixturePage(4242).digest).toBe(designFixturePage(4242).digest);
    expect(designFixturePage(4242).digest).not.toBe(designFixturePage(9001).digest);
    expect(designFixturePage(4242).blocks).toHaveLength(12);
  });

  it('separates scales so two workloads can never share a digest', () => {
    expect(fixtureDigest(buildFixturePlan(50))).not.toBe(fixtureDigest(buildFixturePlan(1000)));
  });

  it('materializes the requested scale into an isolated data dir, never the operator home', () => {
    const plan = buildFixturePlan(3, 7);
    const fixture = materializeFixture(plan, { root: fs.mkdtempSync(path.join(os.tmpdir(), 'o8-bench-test-')) });
    scratchDirs.push(fixture.dataDir);
    const registry = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'repos.json'), 'utf8'));
    const terminalState = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'terminal-states', 'tile-root.json'), 'utf8'));
    expect(registry.repos).toHaveLength(3);
    expect(terminalState.activeTabId).toBe('fixture-agent');
    expect(terminalState.tabs.map((tab: { id: string }) => tab.id)).toEqual(plan.tabs.map((tab) => tab.id));
    expect(fs.existsSync(path.join(fixture.dataDir, 'chat-history', 'thoughts-interaction-fixture.json'))).toBe(true);
    expect(fixture.digest).toBe(fixtureDigest(plan));
    expect(fixture.dataDir.startsWith(os.homedir() + '/.o8')).toBe(false);
    for (const repo of registry.repos) {
      expect(fs.existsSync(path.join(repo.localPath, '.git'))).toBe(true);
    }
  });
});

describe('measurement targets', () => {
  it('honors explicit zero bounds instead of replacing them with defaults', () => {
    const config = interactionConfig(process.cwd(), ['--soak-ms=0', '--inject-delay-ms=0']);
    expect(config.soakMs).toBe(0);
    expect(config.injectedDelayMs).toBe(0);
  });

  it('separates a source stack from a shipped release artifact', () => {
    expect(parseTargetOption('source')).toEqual({ kind: 'source', appPath: null });
    expect(parseTargetOption('release')).toEqual({ kind: 'release', appPath: '/Applications/o8.app' });
    expect(parseTargetOption('release:/tmp/o8-0.1.729.app'))
      .toEqual({ kind: 'release', appPath: '/tmp/o8-0.1.729.app' });
    expect(() => parseTargetOption('dev-stack')).toThrow(/expected source, release/);
  });

  it('requires a full explicit release commit SHA for release targets', () => {
    expect(() => interactionConfig(process.cwd(), ['--target=release:/tmp/o8.app']))
      .toThrow(/--release-git-sha is required/);
    expect(() => interactionConfig(process.cwd(), [
      '--target=release:/tmp/o8.app',
      '--release-git-sha=508c7a1',
    ])).toThrow(/full 40-character/);
    const releaseGitSha = '508c7a1e7208e4a729a9ca5afe4bcd64e0354cbd';
    expect(interactionConfig(process.cwd(), [
      '--target=release:/tmp/o8.app',
      `--release-git-sha=${releaseGitSha}`,
    ]).releaseGitSha).toBe(releaseGitSha);
  });

  it('rejects a server-reported release SHA that conflicts with explicit provenance', () => {
    const releaseGitSha = '508c7a1e7208e4a729a9ca5afe4bcd64e0354cbd';
    const artifact = { identityProblems: [], bundleVersion: '0.1.727', releaseGitSha };
    expect(packagedTargetIdentityProblems({
      appVersion: '0.1.727',
      buildGitSha: releaseGitSha,
      serverReportedBuildGitSha: '5236ea26af8214ca6241bb40aa39784fa6d5b0f8',
      platform: 'darwin',
    }, { buildMode: 'packaged', releaseArtifact: artifact })).toContain(
      'server-reported build Git SHA 5236ea26af8214ca6241bb40aa39784fa6d5b0f8 does not match release provenance 508c7a1e7208e4a729a9ca5afe4bcd64e0354cbd',
    );
  });

  it('refuses to treat a path without a packaged server as a release artifact', () => {
    const identity = releaseArtifactIdentity('/tmp/definitely-not-an-o8-release');
    expect(identity.serverDir).toBeNull();
    expect(identity.unavailableReason).toContain('no packaged server.js');
  });
});

describe('composed terminal-workload coverage', () => {
  const terminalReceipt = {
    schema: 'o8/terminal-workload/v1',
    generatedAt: '2026-08-29T08:39:34.200Z',
    commit: 'e489dff0e1234567890',
    dirty: false,
    buildMode: 'production',
    summary: {
      1: { sampleCount: 3, keystrokeToPaintMs: { samples: 9, p50: 48.1, p95: 67.1 }, revealMs: {}, longTaskMsPerMinute: {} },
      4: { sampleCount: 3, keystrokeToPaintMs: { samples: 9, p50: 41.2, p95: 47.7 } },
      12: { sampleCount: 3, keystrokeToPaintMs: { samples: 9, p50: 43.6, p95: 59 } },
    },
    samples: [{ sessionCount: 12, rapidSwitch: { passed: true } }],
  };

  it('reports a missing terminal receipt as unavailable with the command that produces it', () => {
    const composition = summarizeTerminalWorkload(null);
    expect(composition.status).toBe('unavailable');
    expect(composition.unavailableReason).toContain('npm run bench:terminal');
  });

  it('carries the composed receipt provenance instead of implying it measured this build', () => {
    const composition = summarizeTerminalWorkload(terminalReceipt, { measuredTarget: { appVersion: '0.1.728' } });
    expect(composition.status).toBe('historical');
    expect(composition.provenance).toBe('historical');
    expect(composition.currentBuildProof).toBe(false);
    expect(composition.provenanceNote).toContain('e489dff0e');
    expect(composition.provenanceNote).toContain('Git SHA unavailable');
    expect(composition.coverage?.['12']).toMatchObject({ keystrokeToPaintMs: { p50: 43.6, p95: 59 } });
    expect(composition.rapidSwitch).toEqual({ samples: 1, allPassed: true });
  });

  it('fails the composition when the locked terminal budgets fail', () => {
    const composition = summarizeTerminalWorkload({ ...terminalReceipt, summary: {} });
    expect(composition.status).toBe('historical');
    expect(composition.budgetStatus).toBe('fail');
    expect(composition.budgetFailures?.length).toBeGreaterThan(0);
  });
});

describe('interaction sample statistics', () => {
  it('reports an explicit reason instead of a zero when nothing was sampled', () => {
    expect(distribution([])).toEqual({
      samples: 0, min: null, p50: null, p95: null, p99: null, max: null, note: 'no samples collected',
    });
  });

  it('keeps p50, p95, and p99 separate', () => {
    const result = distribution([10, 20, 30, 40, 50, 60, 70, 80, 90, 1000]);
    expect(result.p50).toBe(50);
    expect(result.p95).toBe(1000);
    expect(result.p99).toBe(1000);
  });

  it('carries failed sample notes onto the scenario instead of dropping them', () => {
    const result = scenarioResult({
      samples: [{ durationMs: 40 }, { durationMs: null, note: 'composer did not take focus' }],
      phaseNames: ['mainThreadMs'],
    });
    expect(result.distribution.samples).toBe(1);
    expect(result.distribution.note).toContain('composer did not take focus');
  });

  it('preserves a censored timeout as a measurable lower bound', () => {
    const result = scenarioResult({
      samples: [{ durationMs: 10_000, censoredLowerBound: true, note: 'request exceeded 10000ms' }],
      phaseNames: ['serverWaitMs'],
    });
    expect(result.distribution.p95).toBe(10_000);
    expect(result.censoredLowerBounds).toBe(1);
    expect(result.lowerBoundNote).toContain('exceeded 10000ms');
  });
});

describe('interaction budgets', () => {
  it('records the accepted reference without erasing its raw failure or weakening future gates', () => {
    const accepted = JSON.parse(fs.readFileSync(path.resolve(
      'scripts/bench/interactions/baselines/macos-x64-0.1.747.json',
    ), 'utf8'));
    expect(INTERACTION_BUDGETS.status).toBe('locked-v1');
    expect(INTERACTION_BUDGETS.lockedBy).toBe('operator-acceptance-2026-09-11');
    expect(accepted.status).toBe('accepted');
    expect(accepted.observedFrom.runStatus).toBe('fail');
    expect(Object.keys(accepted.metrics)).toHaveLength(45);
    expect(accepted.acceptance.unavailable).toMatchObject({
      metric: 'design_screenshot_crop_ms', numericValue: null, followUp: 2175,
    });
    expect(JSON.stringify(accepted)).not.toContain('/Users/');
    const method = 'page-readiness-plus-trusted-input-paint-v1';
    const startup = accepted.metrics['first_interaction_accepted_ms@1000'];
    expect(startup).toMatchObject({ value: 1083, measurementMethod: method });
    expect(INTERACTION_BUDGETS.metrics.first_interaction_accepted_ms.max).toBe(2000);
    expect(INTERACTION_BUDGETS.noiseBandMs.first_interaction_accepted_ms).toBe(150);
    const candidate = receipt({ fixture: { scale: 1000 }, scenarios: {
      ...receipt().scenarios,
      first_interaction_accepted_ms: { ...scenario([1236.3]), measurementMethod: method },
    } });
    const evaluation = evaluateInteractionBudgets(candidate, accepted);
    expect(evaluation.results.find(row => row.metric === 'first_interaction_accepted_ms')).toMatchObject({
      status: 'pass', baselineValue: 1083, deltaValue: 153.3, deltaStatus: 'regressed',
    });
    expect(evaluation.status).toBe('fail');
    expect(evaluation.unavailable.map(row => row.metric)).toContain('design_screenshot_crop_ms');
  });

  it('passes every measured budget on a healthy production run', () => {
    const evaluation = evaluateInteractionBudgets(receipt());
    expect(evaluation.failed).toEqual([]);
    expect(evaluation.regressed).toEqual([]);
    expect(evaluation.absoluteApplies).toBe(true);
  });

  it('keeps an unimplemented capability visible instead of letting it vanish or pass', () => {
    const evaluation = evaluateInteractionBudgets(receipt());
    // The Design Mode screenshot crop does not exist on this path yet. It stays
    // in the manifest so it reports itself every run, which means a receipt
    // cannot reach 'pass' while a contracted capability is missing.
    expect(evaluation.unavailable.map((entry) => entry.metric)).toEqual(['design_screenshot_crop_ms']);
    expect(evaluation.status).toBe('incomplete');
  });

  it('fails the keystroke budget when the interaction gets slower than the ceiling', () => {
    const slow = receipt({
      scenarios: { ...receipt().scenarios, composer_keystroke_to_paint_ms: scenario([520, 540, 560, 580, 600]) },
    });
    const evaluation = evaluateInteractionBudgets(slow, null, { forceAbsolute: true });
    expect(evaluation.status).toBe('fail');
    expect(evaluation.failed).toContain('composer_keystroke_to_paint_ms');
    const result = evaluation.results.find((entry) => entry.metric === 'composer_keystroke_to_paint_ms');
    expect(result?.budgetMax).toBe(INTERACTION_BUDGETS.metrics.composer_keystroke_to_paint_ms.max);
  });

  it('never turns a missing measurement into a pass', () => {
    const missing = receipt({
      scenarios: {
        ...receipt().scenarios,
        tab_switch_ms: scenarioResult({ samples: [], phaseNames: [], unavailableReason: 'no second workspace tab rendered' }),
      },
    });
    const evaluation = evaluateInteractionBudgets(missing);
    expect(evaluation.status).toBe('incomplete');
    expect(evaluation.unavailable).toContainEqual({
      metric: 'tab_switch_ms',
      reason: 'no second workspace tab rendered',
    });
    expect(evaluation.results.find((entry) => entry.metric === 'tab_switch_ms')?.status).toBe('unavailable');
  });

  it('refuses to apply production budgets to a next-dev measurement', () => {
    const devRun = receipt({ target: { buildMode: 'development' }, stack: { buildMode: 'next-dev' } });
    const evaluation = evaluateInteractionBudgets(devRun);
    expect(evaluation.absoluteApplies).toBe(false);
    expect(evaluation.status).toBe('incomplete');
    const result = evaluation.results.find((entry) => entry.metric === 'composer_keystroke_to_paint_ms');
    expect(result?.value).toBe(26);
    expect(result?.status).toBe('unavailable');
    expect(result?.reason).toContain('not budget-eligible');
  });

  it('reports absolute values and baseline deltas together', () => {
    const evaluation = evaluateInteractionBudgets(receipt(), {
      source: 'tests/bench/results/interactions-baseline.json',
      metrics: { composer_keystroke_to_paint_ms: { value: 25 }, tab_switch_ms: { value: 40 } },
    });
    const keystroke = evaluation.results.find((entry) => entry.metric === 'composer_keystroke_to_paint_ms');
    expect(keystroke).toMatchObject({ value: 26, baselineValue: 25, deltaValue: 1, deltaStatus: 'unchanged' });
    const tab = evaluation.results.find((entry) => entry.metric === 'tab_switch_ms');
    expect(tab).toMatchObject({ baselineValue: 40, deltaValue: 90, deltaStatus: 'regressed' });
    expect(evaluation.status).toBe('fail');
    expect(evaluation.baselineSource).toBe('tests/bench/results/interactions-baseline.json');
  });
});

describe('harness validity', () => {
  it('accepts a receipt that proved it can fail and cleaned up', () => {
    expect(checkReceiptValidity(receipt())).toEqual([]);
  });

  it('rejects a run whose injected render delay did not break any budget', () => {
    const problems = checkReceiptValidity(receipt({
      falsification: {
        injectedDelayMs: 500,
        injectedDelayApplications: 3,
        delayExecuted: true,
        metric: 'composer_keystroke_to_paint_ms',
        budgetFailed: false,
      },
    }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('500ms render delay did not fail');
  });

  it('rejects a run that never attempted the falsification probe', () => {
    expect(checkReceiptValidity(receipt({ falsification: { skippedReason: 'Chrome unavailable' } })))
      .toEqual(['falsification probe did not run: Chrome unavailable']);
    expect(checkReceiptValidity(receipt({ falsification: null })))
      .toEqual(['receipt is missing the deliberate-delay falsification probe']);
  });

  it('invalidates a requested injected-delay probe even when the keystroke path was unmeasurable', () => {
    const unmeasurable = receipt({
      scenarios: {
        ...receipt().scenarios,
        composer_keystroke_to_paint_ms: scenarioResult({
          samples: [],
          phaseNames: [],
          unavailableReason: 'no active composer to focus',
        }),
      },
      falsification: { skippedReason: 'no active composer to focus' },
    });
    expect(checkReceiptValidity(unmeasurable))
      .toEqual(['falsification probe did not run: no active composer to focus']);
    expect(evaluateInteractionBudgets(unmeasurable).status).toBe('incomplete');
    const gate = deriveRunStatus([{
      scale: 50,
      budgets: evaluateInteractionBudgets(unmeasurable),
      validity: checkReceiptValidity(unmeasurable),
    }]);
    expect(gate.runStatus).toBe('invalid');
  });

  it('invalidates and refuses a requested delay with missing execution proof', () => {
    const missingProof = receipt({
      falsification: {
        injectedDelayMs: 500,
        injectedDelayApplications: 0,
        delayExecuted: false,
        metric: 'composer_keystroke_to_paint_ms',
        budgetFailed: true,
      },
    });
    expect(checkReceiptValidity(missingProof))
      .toEqual(['injected 500ms render delay has no execution proof; the harness cannot falsify its measurements']);
    expect(() => baselineFromReceipt({
      targetLane: { kind: 'release' },
      runStatus: 'invalid',
      runs: [{ scale: 50, ...missingProof }],
    })).toThrow('falsification has no injected-delay execution proof');
  });

  it('rejects a run that left processes, ports, or worktrees behind', () => {
    const problems = checkReceiptValidity(receipt({
      cleanup: { status: 'residue', residue: { ports: [47131], worktrees: ['/tmp/leaked'] } },
    }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('47131');
  });
});

describe('cleanup verification', () => {
  it('bounds process snapshots above the host process-table size', () => {
    let maxBuffer = 0;
    snapshotProcessInventory((_file, _args, options) => {
      maxBuffer = options.maxBuffer;
      return '';
    });
    expect(maxBuffer).toBe(32 * 1024 * 1024);
  });

  it('reports clean when nothing owned by the run survives', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-bench-cleanup-'));
    fs.rmSync(dataDir, { recursive: true, force: true });
    const result = await verifyCleanup({
      processTermination: { survivors: [] },
      ports: [],
      dataDir,
      repoDir: null,
      tmuxSessionsBefore: listTmuxSessions(),
      worktreesBefore: [],
      worktreesAfter: [],
    });
    expect(result.status).toBe('clean');
    expect(result.residue).toBeNull();
  });

  it('names the residue when the run leaked a process, a data dir, or a worktree', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o8-bench-cleanup-'));
    scratchDirs.push(dataDir);
    const result = await verifyCleanup({
      processTermination: { survivors: [{ pid: process.pid, ppid: 1, pgid: 1, label: 'test-process' }] },
      ports: [],
      dataDir,
      repoDir: null,
      tmuxSessionsBefore: listTmuxSessions(),
      worktreesBefore: [],
      worktreesAfter: ['/tmp/leaked-worktree'],
    });
    expect(result.status).toBe('residue');
    expect(result.residue?.processes).toEqual([{ pid: process.pid, ppid: 1, pgid: 1, label: 'test-process' }]);
    expect(result.residue?.dataDir).toBe(dataDir);
    expect(result.residue?.worktrees).toEqual(['/tmp/leaked-worktree']);
  });

  it('retains and terminates a descendant after its launcher exits and it is reparented', async () => {
    const initial = new Map([
      [100, { pid: 100, ppid: 1, pgid: 100, command: 'node launcher --run-tag-1697' }],
      [101, { pid: 101, ppid: 100, pgid: 100, command: 'next-server (v16)' }],
      [102, { pid: 102, ppid: 101, pgid: 100, command: '/usr/bin/git status --porcelain' }],
      [103, { pid: 103, ppid: 101, pgid: 100, command: '/opt/homebrew/bin/gh issue view 1817 --repo example/repo' }],
    ]);
    const inventory = createOwnedProcessInventory('run-tag-1697', { harnessPid: 999 });
    addOwnedProcessRoot(inventory, 100, 'application-launcher', initial);
    captureOwnedProcessTree(inventory, initial);

    const reparented = new Map([
      [101, { pid: 101, ppid: 1, pgid: 100, command: 'next-server (v16)' }],
    ]);
    expect(survivingOwnedProcesses(inventory, reparented)).toEqual([
      { pid: 101, ppid: 1, pgid: 100, label: 'next-server' },
    ]);

    const signaled: Array<[number, string]> = [];
    const result = await terminateAndWaitOwnedProcesses(inventory, {
      graceMs: 0,
      termMs: 100,
      killMs: 100,
      snapshot: () => reparented,
      sleep: async () => undefined,
      kill: (pid: number, signal: NodeJS.Signals | number) => {
        signaled.push([pid, String(signal)]);
        reparented.delete(pid);
        return true;
      },
    });
    expect(signaled).toEqual([[101, 'SIGTERM']]);
    expect(result.survivors).toEqual([]);
    expect(result.inventoriedByLabel.git).toBe(1);
    expect(result.inventoriedByLabel['github-cli']).toBe(1);
    expect(result.githubCliCommandShapes).toEqual({ 'gh issue view': 1 });
  });

  it('invalidates cleanup when the process inventory itself fails', async () => {
    const inventory = createOwnedProcessInventory('run-tag-snapshot-failure');
    const termination = await terminateAndWaitOwnedProcesses(inventory, {
      graceMs: 0,
      termMs: 0,
      killMs: 0,
      snapshot: () => { throw new Error('process table overflow'); },
    });
    const cleanup = await verifyCleanup({ processTermination: termination });
    expect(termination.snapshotErrors).toEqual(['process table overflow']);
    expect(cleanup.status).toBe('residue');
    expect(cleanup.residue?.processInventoryErrors).toEqual(['process table overflow']);
  });
});

describe('bounded soak accounting', () => {
  it('keeps transient repository workers out of physical-memory probes', () => {
    const processes = new Map([
      [100, { pid: 100, ppid: 1, command: 'next-server (v16)' }],
      [101, { pid: 101, ppid: 100, command: 'git status --porcelain' }],
      [200, { pid: 200, ppid: 1, command: 'node ws-server.mjs' }],
      [300, { pid: 300, ppid: 1, command: 'chrome --type=renderer' }],
    ]);
    expect(stableSoakGroups(processes, {
      applicationServer: [100, 101],
      realtimeServer: [200],
      chromiumRenderer: [300],
    }, { nextPid: 100, wsPid: 200 })).toEqual({
      applicationServer: [100],
      realtimeServer: [200],
      chromiumRenderer: [300],
    });
  });
});

describe('run gate', () => {
  it('marks a run invalid when the instrument could not prove it fails, even with green budgets', () => {
    const runs = [{
      scale: 50,
      budgets: evaluateInteractionBudgets(receipt()),
      validity: checkReceiptValidity(receipt({ falsification: { injectedDelayMs: 500, budgetFailed: false } })),
    }];
    const gate = deriveRunStatus(runs);
    expect(gate.runStatus).toBe('invalid');
    expect(gate.validity[0]).toContain('scale 50:');
  });

  it('marks a run unavailable rather than passing when no measurement produced a value', () => {
    const empty = evaluateInteractionBudgets({
      schema: 'o8/interaction-performance/v1',
      target: { buildMode: 'production' },
      fixture: { scale: 50 },
      scenarios: {},
      soak: { unavailableReason: 'soak disabled' },
    });
    expect(deriveRunStatus([{ scale: 50, budgets: empty, validity: [] }]).runStatus).toBe('unavailable');
  });

  it('reports incomplete, never pass, while a contracted capability is unavailable', () => {
    const gate = deriveRunStatus([{
      scale: 50,
      budgets: evaluateInteractionBudgets(receipt()),
      validity: checkReceiptValidity(receipt()),
    }]);
    expect(gate).toEqual({ runStatus: 'incomplete', validity: [] });
  });

  it('passes when every contracted metric is measured and inside budget', () => {
    const complete = receipt({
      scenarios: { ...receipt().scenarios, design_screenshot_crop_ms: scenario([120]) },
    });
    const gate = deriveRunStatus([{
      scale: 50,
      budgets: evaluateInteractionBudgets(complete),
      validity: checkReceiptValidity(complete),
    }]);
    expect(gate).toEqual({ runStatus: 'pass', validity: [] });
  });

  it('builds scale-matched release observations so deltas never compare different fleets', () => {
    const artifact = {
      bundleVersion: '0.1.728',
      releaseGitSha: '5236ea26af8214ca6241bb40aa39784fa6d5b0f8',
      complete: true,
      identityProblems: [],
      targetDigestSha256: 'a'.repeat(64),
    };
    const packagedRun = (scale: number, digest: string, budgets: ReturnType<typeof evaluateInteractionBudgets>) => ({
      scale,
      target: {
        appVersion: '0.1.728',
        platform: 'darwin',
        buildMode: 'packaged',
        buildGitSha: artifact.releaseGitSha,
        serverReportedBuildGitSha: null,
      },
      stack: { buildMode: 'packaged', releaseArtifact: artifact },
      fixture: { digest },
      budgets,
      cleanup: { status: 'clean' },
      falsification: {
        injectedDelayMs: 500,
        injectedDelayApplications: 3,
        delayExecuted: true,
        budgetFailed: true,
      },
    });
    const baseline = baselineFromReceipt({
      version: '0.1.728',
      gitSha: 'abc1234',
      host: { platform: 'darwin' },
      samples: 7,
      runStatus: 'incomplete',
      targetLane: { kind: 'release', appPath: '/tmp/o8.app' },
      runs: [
        packagedRun(50, 'aaaa', evaluateInteractionBudgets(receipt())),
        packagedRun(250, 'bbbb', evaluateInteractionBudgets({
            ...receipt(),
            fixture: { scale: 250 },
            scenarios: { ...receipt().scenarios, composer_keystroke_to_paint_ms: scenario([90, 92, 94]) },
          }, null, { forceAbsolute: true })),
      ],
    });
    expect(baseline.status).toBe('observed');
    expect(baseline.metrics['composer_keystroke_to_paint_ms@50']).toEqual({ value: 26, statistic: 'p50', scale: 50 });
    expect(baseline.metrics['composer_keystroke_to_paint_ms@250']).toEqual({ value: 92, statistic: 'p50', scale: 250 });
    expect(baseline.observedFrom.benchmarkGitSha).toBe('abc1234');
    expect(baseline.observedFrom.fixtureDigests).toEqual([
      { scale: 50, digest: 'aaaa' },
      { scale: 250, digest: 'bbbb' },
    ]);
  });

  it('refuses a baseline write without a complete packaged identity', () => {
    expect(() => baselineFromReceipt({
      runStatus: 'incomplete',
      targetLane: { kind: 'source' },
      runs: [],
    })).toThrow(/baseline writes require --target=release/);
  });

  it('surfaces a surviving browser process as an invalid run', () => {
    const gate = deriveRunStatus([{
      scale: 50,
      budgets: evaluateInteractionBudgets(receipt()),
      validity: [],
    }], ['browser process 4242 survived the run']);
    expect(gate.runStatus).toBe('invalid');
  });
});


describe('long transcript workload identity', () => {
  it('records reproducible bytes and representative content for all 5,000 messages', () => {
    const fixture = longHistoryFixture();
    expect(fixture).toEqual(longHistoryFixture());
    expect(fixture.messages).toHaveLength(5000);
    expect(new Set(fixture.messages.map(message => message.id)).size).toBe(5000);
    expect(fixture.payloadBytes).toBe(Buffer.byteLength(JSON.stringify(fixture.messages)));
    expect(fixture.payloadBytes).toBe(1704281);
    expect(fixture.messages.map(message => message.text).join('\n')).toMatch(/```typescript[\s\S]*```diff[\s\S]*Exit code: 0/);
    expect(fixture.complexity).toMatchObject({ turns: 2500, messagesPerKind: 1000, fencedBlocks: 3000, tables: 1000 });
    expect(longHistoryFixture(1).digest).not.toBe(fixture.digest);
  });
});
