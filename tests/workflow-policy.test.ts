/**
 * Filesystem-driven GitHub Actions policy coverage.
 *
 * Every workflow is discovered from disk so a newly added file is governed
 * automatically. The assertions protect repository secrets, Actions spend,
 * runner cost, action supply-chain integrity, and least-privilege defaults.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type RecordValue = Record<string, unknown>;

interface WorkflowFile {
  file: string;
  name: string;
  workflow: RecordValue;
}

interface UsesReference {
  location: string;
  uses: string;
}

const WORKFLOWS_ROOT = path.join(process.cwd(), '.github', 'workflows');

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walkFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function parseWorkflow(file: string): WorkflowFile {
  const name = path.relative(WORKFLOWS_ROOT, file);
  const parsed = parse(readFileSync(file, 'utf8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${name} must parse to a YAML mapping`);
  }
  return { file, name, workflow: parsed };
}

function triggerNames(workflow: RecordValue): Set<string> {
  const trigger = workflow.on;
  if (typeof trigger === 'string') return new Set([trigger]);
  if (Array.isArray(trigger)) {
    return new Set(trigger.filter((value): value is string => typeof value === 'string'));
  }
  if (isRecord(trigger)) return new Set(Object.keys(trigger));
  return new Set();
}

function collectUses(value: unknown, location: string, output: UsesReference[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectUses(entry, `${location}[${index}]`, output));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, entry] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    if (key === 'uses' && typeof entry === 'string') {
      output.push({ location: childLocation, uses: entry.trim() });
    }
    collectUses(entry, childLocation, output);
  }
}

function usesReferences(file: WorkflowFile): UsesReference[] {
  const references: UsesReference[] = [];
  collectUses(file.workflow.jobs, `${file.name}.jobs`, references);
  return references;
}

function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (isRecord(value)) return Object.values(value).flatMap(stringsIn);
  return [];
}

function matrixValues(job: RecordValue, key: string): string[] {
  const strategy = isRecord(job.strategy) ? job.strategy : {};
  const matrix = isRecord(strategy.matrix) ? strategy.matrix : {};
  const values = stringsIn(matrix[key]);
  if (Array.isArray(matrix.include)) {
    for (const entry of matrix.include) {
      if (isRecord(entry)) values.push(...stringsIn(entry[key]));
    }
  }
  return values;
}

function usesMacOsRunner(job: RecordValue): boolean {
  const runners = stringsIn(job['runs-on']);
  if (runners.some((runner) => /^macos-/i.test(runner.trim()))) return true;

  for (const runner of runners) {
    for (const match of runner.matchAll(/matrix\.([A-Za-z0-9_-]+)/g)) {
      if (matrixValues(job, match[1]).some((value) => /^macos-/i.test(value.trim()))) {
        return true;
      }
    }
  }
  return false;
}

function jobsIn(file: WorkflowFile): Array<[string, RecordValue]> {
  if (!isRecord(file.workflow.jobs)) return [];
  return Object.entries(file.workflow.jobs).filter(
    (entry): entry is [string, RecordValue] => isRecord(entry[1]),
  );
}

const workflowFiles = walkFiles(WORKFLOWS_ROOT)
  .filter((file) => /\.ya?ml$/i.test(file))
  .sort()
  .map(parseWorkflow);

describe('workflow policy — every workflow is classified from the filesystem', () => {
  it('parses every workflow and discovers a non-vacuous workflow set', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
    for (const file of workflowFiles) {
      expect(triggerNames(file.workflow).size, `${file.name} must declare at least one trigger`).toBeGreaterThan(0);
      expect(jobsIn(file).length, `${file.name} must declare at least one job`).toBeGreaterThan(0);
    }
  });

  it('keeps pull_request_target metadata-only except the base-owned native boundary', () => {
    const violations = workflowFiles.flatMap((file) => {
      if (!triggerNames(file.workflow).has('pull_request_target')) return [];
      if (file.name === 'next-surface-boundary.yml') {
        // This lane is base-owned precisely so a PR cannot replace its rules.
        // It never checks out a PR, receives write authority, or saves PR caches.
        expect(file.workflow.permissions).toEqual({ contents: 'read' });
        const triggers = file.workflow.on as Record<string, { paths: string[] }>;
        for (const event of ['pull_request', 'pull_request_target']) {
          expect(triggers[event].paths).toEqual(['native/o8-next/**', 'scripts/next/**', '.github/workflows/next-surface-boundary.yml']);
        }
        expect(jobsIn(file).map(([name]) => name)).toEqual(['boundary']);
        const job = jobsIn(file)[0][1];
        expect(job.permissions).toBeUndefined();
        expect(job.environment).toBeUndefined();
        expect(stringsIn(job.env).some(value => value.includes('secrets.'))).toBe(false);
        const env = job.env as RecordValue;
        expect(env.BASE_SHA).toBe('${{ github.event.pull_request.base.sha }}');
        expect(env.POLICY_BOOTSTRAP_REF).toMatch(/^[a-f0-9]{40}$/);
        expect(job.if).toBe("github.event_name == 'pull_request_target' || github.event.pull_request.base.sha == '417586b6b00e55f4759fc95a68091ffad7596213'");
        const steps = job.steps as RecordValue[];
        const checkouts = steps.filter(step => String(step.uses).startsWith('actions/checkout@'));
        expect(checkouts).toHaveLength(1);
        expect(checkouts[0].with).toEqual({ ref: '${{ github.event.pull_request.base.sha }}', 'fetch-depth': 0, 'persist-credentials': false });
        expect(steps.some(step => String(step.uses).startsWith('actions/cache@'))).toBe(false);
        const runs = steps.filter(step => typeof step.run === 'string').map(step => String(step.run));
        expect(runs).toHaveLength(3);
        expect(runs[0]).toContain('git show "$BASE_SHA:$CHECKER_PATH" > "$POLICY_PATH"');
        expect(runs[0]).toContain('git show "$POLICY_BOOTSTRAP_REF:$CHECKER_PATH" > "$POLICY_PATH"');
        for (const run of runs.slice(1)) expect(run).toMatch(/^node "\$POLICY_PATH" --base "\$BASE_REF" --head "\$HEAD_REF"/);
        return [];
      }
      const checkoutViolations = usesReferences(file)
        .filter(({ uses }) => /^actions\/checkout(?:@|\/|$)/i.test(uses))
        .map(({ location, uses }) => `${location}: ${uses}`);
      const runViolations = jobsIn(file).flatMap(([jobName, job]) => {
        const steps = Array.isArray(job.steps) ? job.steps : [];
        return steps.flatMap((step, index) => (
          isRecord(step) && typeof step.run === 'string'
            ? [`${file.name}.jobs.${jobName}.steps[${index}].run`]
            : []
        ));
      });
      return [...checkoutViolations, ...runViolations];
    });

    expect(
      violations,
      'pull_request_target runs with secrets against the base repository; checking out or running pull request-controlled content can exfiltrate them.',
    ).toEqual([]);
  });

  it('allows push triggers only for pushes to main, never tags or other branches', () => {
    // The repo is public, so runners are free; a push-to-main run keeps the
    // default-branch status honest after every merge (ruling 2026-09-11,
    // reversing the PR-only rule from the private-repo days). Tag pushes and
    // unscoped pushes stay forbidden: tags would re-run CI on every release,
    // and an unscoped push would run it on every branch push.
    const violations: string[] = [];
    for (const file of workflowFiles) {
      if (!triggerNames(file.workflow).has('push')) continue;
      const trigger = file.workflow.on;
      const push = isRecord(trigger) ? trigger.push : undefined;
      const branches = isRecord(push) && Array.isArray(push.branches) ? push.branches : null;
      const tags = isRecord(push) ? push.tags : undefined;
      const onlyMain = branches !== null && branches.length === 1 && branches[0] === 'main';
      if (!onlyMain || tags !== undefined) violations.push(file.name);
    }
    expect(violations, 'push triggers are permitted only as push.branches: [main] with no tag filter').toEqual([]);
  });

  it('limits macOS runners to manual work and the bounded native regression checks', () => {
    const prebuild = workflowFiles.find(file => file.name === 'macos-prebuild-profile.yml');
    expect(prebuild, 'prebuild lifetime fixtures need a bounded native macOS check').toBeDefined();
    const violations: string[] = [];
    for (const file of workflowFiles) {
      const triggers = triggerNames(file.workflow);
      const manualOnly = triggers.size === 1 && triggers.has('workflow_dispatch');
      // The native resource suite also covers changes to its preservation
      // fixture or workflow; unrelated pull requests never request this runner.
      const weeklyResources = file.name === 'macos-resource-tests.yml';
      if (weeklyResources) {
        expect([...triggers].sort()).toEqual(['pull_request', 'schedule', 'workflow_dispatch']);
        expect((file.workflow.on as RecordValue).pull_request).toEqual({
          branches: ['main'],
          paths: [
            'tests/workspace-preservation-cli-real-path.test.ts',
            '.github/workflows/macos-resource-tests.yml',
          ],
        });
        expect((file.workflow.on as RecordValue).schedule).toEqual([{ cron: '37 6 * * 2' }]);
        expect(jobsIn(file)).toHaveLength(1);
        const job = jobsIn(file)[0][1];
        expect(job['timeout-minutes']).toBe(45);
        expect(job.strategy).toBeUndefined();
      }
      // The minimum-OS DMG fixture is explicitly bounded to three minutes and
      // runs only when its format, OS floor, workflow or policy changes.
      const minimumOsDmg = file.name === 'macos-dmg-compatibility.yml';
      if (minimumOsDmg) {
        expect([...triggers].sort()).toEqual(['pull_request', 'workflow_dispatch']);
        expect((file.workflow.on as RecordValue).pull_request).toEqual({ paths: [
          '.github/workflows/macos-dmg-compatibility.yml',
          'scripts/sign-and-notarize.mjs',
          'src-tauri/tauri.conf.json',
          'tests/workflow-policy.test.ts',
        ] });
        expect(jobsIn(file)).toHaveLength(1);
        const job = jobsIn(file)[0][1];
        expect(job['runs-on']).toBe('macos-14');
        expect(job['timeout-minutes']).toBe(3);
        expect(job.strategy).toBeUndefined();
        expect(job.steps).toHaveLength(2);
      }
      const prebuildProfile = file.name === 'macos-prebuild-profile.yml';
      if (prebuildProfile) {
        expect([...triggers].sort()).toEqual(['pull_request', 'workflow_dispatch']);
        expect((file.workflow.on as RecordValue).pull_request).toEqual({ branches: ['main'], paths: [
          'tests/tauri-prebuild-profile.test.ts',
          'scripts/lib/generated-output-launch.mjs',
          'scripts/lib/prebuild-continuation.mjs',
          'scripts/lib/release-build-profile.mjs',
          'src/lib/workspace/generated-output-producer.ts',
          '.github/workflows/macos-prebuild-profile.yml',
        ] });
        expect(jobsIn(file)).toHaveLength(1);
        const job = jobsIn(file)[0][1];
        expect(job['runs-on']).toBe('macos-15-intel');
        expect(job['timeout-minutes']).toBe(15);
        expect(job.strategy).toBeUndefined();
        expect(stringsIn(job.steps).some(value => value.includes("env -u CI npx vitest run tests/tauri-prebuild-profile.test.ts -t 'retains linked'"))).toBe(true);
      }
      for (const [jobName, job] of jobsIn(file)) {
        if (usesMacOsRunner(job) && !manualOnly && !weeklyResources && !minimumOsDmg && !prebuildProfile) {
          violations.push(`${file.name}: jobs.${jobName}`);
        }
      }
    }
    expect(violations, 'macOS jobs require explicit dispatch except the bounded workspace and minimum-OS DMG checks').toEqual([]);
  });

  it('pins every third-party action to a full commit SHA', () => {
    const violations = workflowFiles.flatMap((file) =>
      usesReferences(file)
        .filter(({ uses }) => {
          const normalized = uses.toLowerCase();
          if (normalized.startsWith('actions/')) return false;
          if (normalized.startsWith('./') || normalized.startsWith('docker://')) return false;
          return !/@[0-9a-f]{40}$/i.test(uses);
        })
        .map(({ location, uses }) => `${location}: ${uses}`),
    );
    expect(violations, 'third-party action tags are mutable; pin each action to a full 40-character commit SHA').toEqual([]);
  });

  it('requires explicit top-level permissions in every workflow', () => {
    const violations = workflowFiles
      .filter((file) => !isRecord(file.workflow.permissions))
      .map((file) => file.name);
    expect(violations, 'top-level permissions make the default token scope explicit and least-privilege').toEqual([]);
  });

  it('keeps runner and step contexts out of job-level environments', () => {
    // GitHub rejects the whole workflow before creating any jobs when job.env
    // uses a context that is available only after the job has started.
    const violations = workflowFiles.flatMap(file => jobsIn(file).flatMap(([name, job]) =>
      stringsIn(job.env)
        .filter(value => /\$\{\{[^}]*\b(?:runner|steps|job|env)\s*(?:\.|\[)/.test(value))
        .map(value => `${file.name}: jobs.${name}.env: ${value}`),
    ));
    expect(violations, 'job.env accepts github, inputs, matrix, needs, secrets, strategy and vars contexts').toEqual([]);
  });
});

describe('workflow policy — github-script syntax', () => {
  it('compiles every parsed github-script body as async JavaScript', () => {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<unknown>;

    for (const file of workflowFiles) {
      for (const [jobName, job] of jobsIn(file)) {
        const steps = Array.isArray(job.steps) ? job.steps : [];
        steps.forEach((step, index) => {
          if (!isRecord(step) || typeof step.uses !== 'string') return;
          if (!/^actions\/github-script@/i.test(step.uses)) return;
          const inputs = isRecord(step.with) ? step.with : {};
          expect(typeof inputs.script, `${file.name}: jobs.${jobName}.steps[${index}] needs a script`).toBe('string');
          expect(
            () => new AsyncFunction('github', 'context', 'core', 'require', String(inputs.script)),
            `${file.name}: jobs.${jobName}.steps[${index}] has invalid JavaScript`,
          ).not.toThrow();
        });
      }
    }
  });
});
