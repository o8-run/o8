import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Exercise the real coverage CLI against a small, real classified source tree. */
export function createVerifierCoverageFixture(repo: string, parent: string): string {
  const directory = mkdtempSync(path.join(parent, 'coverage-'));
  for (const file of [
    'scripts/ci/check-verify-ci.mjs', 'scripts/lib/verify-ci.mjs',
    'scripts/lib/test-classification.mjs', 'scripts/lib/browser-prerequisites.mjs',
    '.github/actions/next-linux-setup/action.yml',
    '.github/actions/linux-package-prerequisites/action.yml',
    '.github/workflows/ci.yml', 'package.json',
  ]) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    copyFileSync(path.join(repo, file), path.join(directory, file));
  }
  symlinkSync(path.join(repo, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
  mkdirSync(path.join(directory, 'tests'));
  writeFileSync(path.join(directory, 'tests/browser-fixture.test.ts'),
    "import { chromium } from 'playwright-core';\n");
  writeFileSync(path.join(directory, 'tests/test-classification.json'), JSON.stringify({
    resourceOwning: [{ path: 'tests/browser-fixture.test.ts', browser: true }],
  }));
  return directory;
}

/** Mutate the real native setup action for verifier refusal checks. */
export function mutateNativeSetupFixture(setup: { runs: { steps: Array<{
  id?: string; run?: string; with?: Record<string, string>;
}> } }, change: string): void {
  const cache = setup.runs.steps.find(step => step.id === 'native-cache');
  if (change === 'cache dependencies only' && cache?.with) cache.with.path = '.o8-next-cargo/registry';
  if (change === 'cache without source key' && cache?.with) cache.with.key = 'native-tests-lock-only';
  if (change === 'architecture') setup.runs.steps[0].with!.architecture = 'arm64';
  if (change === 'missing install') setup.runs.steps = setup.runs.steps.filter(step => step.run !== 'npm ci --prefer-offline');
}

export function writeListingCheckFixture(directory: string) {
  writeFileSync(path.join(directory, 'scripts/ci/test-classification-listing.test.mjs'), `
    import { appendFileSync } from 'node:fs';
    appendFileSync(process.env.VERIFY_FIXTURE_RECEIPT, JSON.stringify({ tool: 'classification-listing', args: [] }) + '\\n');
  `);
}

export function registerClassificationCoverageTests(
  coverageRoot: string,
  workflowPath: string,
  coverage: (workflow: object) => SpawnSyncReturns<string>,
  execute: (fail?: string) => { status: number | null; stdout: string; stderr: string; calls: Array<{ args: string[] }> },
) {
  it('runs classification as an independent local job and requires its result', () => {
    const source = `import { readVerificationPlan } from './scripts/lib/verify-ci.mjs';
      const plan = readVerificationPlan(process.cwd());
      console.log(JSON.stringify(plan.checks.filter(check => ['classification', 'test'].includes(check.id))));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: coverageRoot, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const checks = JSON.parse(result.stdout);
    const classification = checks.find((check: { id: string }) => check.id === 'classification');
    const unit = checks.find((check: { id: string }) => check.id === 'test');
    expect(classification.name).toBe('Test Classification');
    expect(classification.after).toEqual([]);
    expect(classification.steps.map((step: { command: string }) => step.command)).toEqual([
      'npm run test:classification:check', 'node --test scripts/ci/test-classification-listing.test.mjs',
    ]);
    expect(unit.after).not.toContain('classification');
    expect(unit.requiredResults).toContain('classification');
    expect(unit.steps.some((step: { command: string }) => step.command.includes('test:classification:check'))).toBe(false);
  });

  it.each(['success', 'failure', 'cancelled', 'skipped'])('executes the aggregate with classification result %s', status => {
    const workflow = parse(readFileSync(workflowPath, 'utf8'));
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', workflow.jobs.test.steps[0].run], {
      encoding: 'utf8', env: { ...process.env, SHARD_RESULT: 'success', NATIVE_RESULT: 'success', CLASSIFICATION_RESULT: status },
    });
    expect(result.status, result.stderr).toBe(status === 'success' ? 0 : 1);
  });

  it('fails the local aggregate when classification fails while retaining every shard', () => {
    const result = execute('test:classification:check');
    expect(result.status, result.stderr + result.stdout).toBe(1);
    expect(result.stdout).toContain('FAIL Test Classification');
    expect(result.stdout).toContain('FAIL Hermetic Unit Tests');
    expect(result.calls.filter(call => call.args.includes('test:unit'))).toHaveLength(4);
  }, 60_000);

  it.each(['dependency', 'command', 'condition', 'tolerance', 'shard dependency', 'duplicate in shard'])(
    'rejects a classification coverage regression: %s', change => {
      const workflow = parse(readFileSync(workflowPath, 'utf8'));
      if (change === 'dependency') workflow.jobs.test.needs.pop();
      if (change === 'command') workflow.jobs.classification.steps = workflow.jobs.classification.steps.filter(
        (step: { run?: string }) => step.run !== 'npm run test:classification:check');
      if (change === 'condition') workflow.jobs.classification.if = "github.event_name == 'push'";
      if (change === 'tolerance') workflow.jobs.classification['continue-on-error'] = true;
      if (change === 'shard dependency') workflow.jobs.classification.needs = 'test-shards';
      if (change === 'duplicate in shard') workflow.jobs['test-shards'].steps.push({ run: 'npm run test:classification:check' });
      const result = coverage(workflow);
      expect(result.status, result.stdout).toBe(1);
      expect(result.stderr).toContain('verify:ci coverage:');
    },
  );

}
