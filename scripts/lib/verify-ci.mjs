import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

// Every job must be either executable locally or explicitly hosted. Unknown
// jobs fail closed, including jobs added without updating a separate inventory.
const hostedJobs = {
  'typecheck-parity': 'weekly comparison',
  'integration-changed': 'resource-owning integration lane',
  'integration-weekly': 'weekly integration lane',
  'integration-weekly-report': 'hosted reporting',
  'integration-weekly-watch': 'hosted scheduling',
  build: 'manual build',
  'rust-check-windows': 'native target runner',
  'rust-check-linux': 'native target runner',
  'roadmap-check': 'authenticated issue inventory',
};
const localJobs = ['typecheck', 'server-bundle-size', 'lint', 'test-shards', 'test', 'security', 'governance-smoke'];
const setupActions = ['actions/checkout@', 'actions/setup-node@', 'actions/cache/restore@',
  'actions/cache/save@', 'actions/upload-artifact@'];
const auditAction = 'rustsec/audit-check@';
const reviewAction = 'actions/dependency-review-action@';
const bootstrapCommands = new Set([
  'npm ci --prefer-offline',
  `npm install -g "$(node -p 'require("./package.json").packageManager')"`,
]);

function requireCondition(condition, message) {
  if (!condition) throw new Error(`verify:ci coverage: ${message}`);
}
function quote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}
function expand(value, shard) {
  const result = String(value).replaceAll('${{ matrix.shard }}', String(shard));
  requireCondition(!result.includes('${{'), 'unsupported hosted expression in a local command or environment');
  return result;
}
function runStep(step, job, shard) {
  const env = Object.fromEntries(Object.entries({ ...job.env, ...step.env })
    .map(([key, value]) => [key, expand(value, shard)]));
  let command = expand(step.run, shard).trim();
  // Measurement is not a check; use the same underlying command on hosts
  // without the runner's time binary and its platform-specific flags.
  command = command.replace(/^\/usr\/bin\/time -f '[^']*' /, '');
  let timeoutMs = (step['timeout-minutes'] ?? job['timeout-minutes'] ?? 15) * 60_000;
  let temporaryData = false;
  if (command.startsWith('timeout ')) {
    const smoke = /^timeout --signal=KILL (\d+) env CORTEX_IDE_DATA_DIR=\$\(mktemp -d\) NODE_OPTIONS=(\S+) ([\s\S]+)$/.exec(command);
    requireCondition(smoke, 'unsupported timeout wrapper; add a portable local equivalent');
    timeoutMs = Number(smoke[1]) * 1000;
    env.NODE_OPTIONS = smoke[2];
    command = smoke[3];
    temporaryData = true;
  }
  return { command, env, timeoutMs, temporaryData };
}
function selectedSteps(job, shard) {
  return job.steps.filter(step => {
    if (!step.run) return false;
    requireCondition(step.shell === undefined && step['working-directory'] === undefined,
      'step shell or working-directory needs a verify:ci equivalent');
    const command = step.run.trim();
    if (/^npm (?:install -g |ci(?:\s|$))/.test(command)) {
      requireCondition(bootstrapCommands.has(command), 'compound or changed setup command needs a verify:ci equivalent');
      return false;
    }
    requireCondition(!step.if || step.if === 'matrix.shard == 1', `unsupported local step condition: ${step.if}`);
    return !step.if || shard === 1;
  });
}

export function readVerificationPlan(root, workflowPath = path.join(root, '.github/workflows/ci.yml')) {
  const workflow = parse(readFileSync(workflowPath, 'utf8'));
  const jobs = workflow.jobs;
  requireCondition(jobs && typeof jobs === 'object', 'CI must define jobs');
  requireCondition(workflow.defaults?.run === undefined, 'workflow run defaults need a verify:ci equivalent');
  for (const id of Object.keys(jobs)) {
    requireCondition(localJobs.includes(id) || Object.hasOwn(hostedJobs, id), `CI job ${id} is missing from verify:ci`);
  }
  for (const id of [...localJobs, ...Object.keys(hostedJobs)]) {
    requireCondition(jobs[id], `expected CI job ${id} is missing; update verify:ci coverage`);
  }
  for (const id of localJobs) {
    const job = jobs[id];
    requireCondition(job.defaults?.run === undefined, `${id} run defaults need a verify:ci equivalent`);
    job.env = { ...workflow.env, ...job.env };
    requireCondition(typeof job.name === 'string', `${id} needs a CI check name`);
    requireCondition(!job.strategy || id === 'test-shards', `${id} has an unsupported matrix`);
    for (const step of job.steps ?? []) {
      if (!step.uses) continue;
      const supported = setupActions.some(prefix => step.uses.startsWith(prefix))
        || (id === 'security' && (step.uses.startsWith(auditAction) || step.uses.startsWith(reviewAction)));
      requireCondition(supported, `action ${step.uses} in ${id} has no verify:ci equivalent`);
    }
  }
  requireCondition(Array.isArray(jobs.test.needs) && jobs.test.needs.length === 1
    && jobs.test.needs[0] === 'test-shards', 'the hermetic aggregate must require the shard job');
  const aggregate = jobs.test.steps;
  requireCondition(aggregate?.length === 1
    && aggregate[0].run?.trim() === 'echo "Hermetic shard result: $SHARD_RESULT"\ntest "$SHARD_RESULT" = success'
    && aggregate[0].shell === undefined && aggregate[0]['working-directory'] === undefined
    && aggregate[0].env?.SHARD_RESULT === '${{ needs.test-shards.result }}'
    && Object.keys(aggregate[0].env).length === 1,
  'hermetic aggregate steps changed; update verify:ci coverage');
  const shardJob = jobs['test-shards'];
  const shards = shardJob.strategy?.matrix?.shard;
  requireCondition(Array.isArray(shards) && shards.length > 0, 'hermetic shard matrix is missing');
  requireCondition(new Set(shards).size === shards.length, 'hermetic shards must be unique');
  const classification = selectedSteps(shardJob, 1).filter(step => step.run === 'npm run test:classification:check');
  requireCondition(classification.length === 1, 'CI must check test classification exactly once');
  const checks = [];
  const appendJob = id => {
    const steps = selectedSteps(jobs[id]).map(step => runStep(step, jobs[id]));
    requireCondition(steps.length > 0, `${id} has no local checks`);
    checks.push({ name: jobs[id].name, steps });
  };
  appendJob('typecheck');
  appendJob('lint');
  checks.push({ name: classification[0].name ?? 'Test Classification',
    steps: classification.map(step => runStep(step, shardJob, 1)) });
  const unitSteps = shards.flatMap(shard => selectedSteps(shardJob, shard)
    .filter(step => step.run !== classification[0].run)
    .map(step => {
      const unit = runStep(step, shardJob, shard);
      return { ...unit, env: { NODE_ENV: 'test', ...unit.env } };
    }));
  requireCondition(unitSteps.some(step => step.command.startsWith('npm run test:unit -- ')), 'CI must execute its hermetic unit entry point');
  checks.push({ name: jobs.test.name, steps: unitSteps });
  appendJob('server-bundle-size');
  const audit = jobs.security.steps.find(step => step.uses?.startsWith(auditAction));
  requireCondition(audit, 'native dependency audit is missing');
  const ignores = String(audit.with?.ignore ?? '').split(',').map(value => value.trim()).filter(Boolean);
  requireCondition(ignores.every(value => /^RUSTSEC-\d{4}-\d{4}$/.test(value)), 'native audit ignore list is malformed');
  const auditFile = path.posix.join(audit.with?.['working-directory'] ?? '.', 'Cargo.lock');
  checks.push({ name: jobs.security.name, steps: [
    ...selectedSteps(jobs.security).map(step => runStep(step, jobs.security)),
    { command: `cargo-audit audit --file ${quote(auditFile)}${ignores.map(value => ` --ignore ${quote(value)}`).join('')}`,
      env: {}, timeoutMs: jobs.security['timeout-minutes'] * 60_000 },
  ] });
  appendJob('governance-smoke');
  const nodeVersions = new Set(localJobs.flatMap(id => jobs[id].steps
    .filter(step => step.uses?.startsWith('actions/setup-node@'))
    .map(step => String(step.with?.['node-version']))));
  requireCondition(nodeVersions.size === 1, 'local checks must use one supported runtime version');
  const nodeMajor = [...nodeVersions][0];
  requireCondition(/^\d+$/.test(nodeMajor), 'CI runtime version must identify a major version');
  return { checks, hostedJobs, nodeMajor,
    notes: ['Dependency-change review and hosted check publication require runner credentials.'] };
}
