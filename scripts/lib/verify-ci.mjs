import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import { buildTestClassificationReport } from './test-classification.mjs';

// Every job must be either executable locally or explicitly hosted. Unknown
// jobs fail closed, including jobs added without updating a separate inventory.
const alwaysHostedJobs = {
  'typecheck-parity': 'weekly comparison',
  'integration-weekly': 'main and scheduled full integration matrix',
  'integration-weekly-report': 'hosted reporting',
  'integration-weekly-watch': 'hosted scheduling',
  build: 'manual build',
  'rust-check-windows': 'native target runner',
  'rust-check-linux': 'native target runner',
  'roadmap-check': 'authenticated issue inventory',
};
const alwaysLocalJobs = ['typecheck', 'server-bundle-size', 'lint', 'test-shards', 'test', 'security', 'governance-smoke', 'integration-changed'];
const setupActions = ['actions/checkout@', 'actions/setup-node@', 'actions/cache/restore@',
  'actions/cache/save@', 'actions/upload-artifact@'];
const auditAction = 'rustsec/audit-check@';
const bootstrapCommands = new Set([
  'npm ci --prefer-offline',
  `npm install -g "$(node -p 'require("./package.json").packageManager')"`,
]);
const integrationPolicyCommand = 'node scripts/ci/prepare-integration-policy.mjs';

function requireCondition(condition, message) {
  if (!condition) throw new Error(`verify:ci coverage: ${message}`);
}
function quote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}
function expand(value, shard) {
  const refs = {
    '${{ github.event.merge_group.base_sha || github.event.pull_request.base.sha || github.event.before }}': 'origin/main',
    '${{ github.event.merge_group.head_sha || github.event.pull_request.head.sha || github.sha }}': '--worktree',
  };
  const result = (refs[String(value)] ?? String(value)).replaceAll('${{ matrix.shard }}', String(shard));
  requireCondition(!result.includes('${{'), 'unsupported hosted expression in a local command or environment');
  return result;
}
function usesTestProcess(command, scripts, seen = new Set()) {
  if (/\bvitest\b|npm run test:(?:unit|integration|classification:check)\b|scripts\/ci\/check-hermetic-shards\.mjs|native-test-shard\.mjs --cargo --phase=timed/.test(command)) return true;
  return [...command.matchAll(/\bnpm run ([\w:-]+)/g)].some(([, name]) => {
    if (seen.has(name) || typeof scripts[name] !== 'string') return false;
    return usesTestProcess(scripts[name], scripts, new Set([...seen, name]));
  });
}
function runStep(step, job, shard, scripts) {
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
  const testProcess = usesTestProcess(command, scripts);
  return { command, env, timeoutMs, temporaryData, testProcess };
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

export function readVerificationPlan(root, workflowPath = path.join(root, '.github/workflows/ci.yml'),
  { platform = process.platform, arch = process.arch, fullIntegration = false } = {}) {
  const nativeLocal = platform === 'linux' && arch === 'x64';
  const hostedJobs = { ...alwaysHostedJobs, ...(!nativeLocal ? {
    'o8-next-tests': 'Linux x64 GPUI/X11 suite requires the hosted Linux x64 runner on this platform',
  } : {}) };
  if (fullIntegration) {
    delete hostedJobs['integration-weekly'];
    hostedJobs['integration-changed'] = 'pull request and merge-group selection';
  }
  const localJobs = [...alwaysLocalJobs.filter(id => !fullIntegration || id !== 'integration-changed'),
    ...(fullIntegration ? ['integration-weekly'] : []), ...(nativeLocal ? ['o8-next-tests'] : [])];
  const scripts = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
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
    requireCondition(!job['continue-on-error'] && job.steps.every(step => !step['continue-on-error']),
      `${id} failure tolerance needs a verify:ci equivalent`);
    requireCondition(job.defaults?.run === undefined, `${id} run defaults need a verify:ci equivalent`);
    job.env = { ...workflow.env, ...job.env };
    requireCondition(typeof job.name === 'string', `${id} needs a CI check name`);
    requireCondition(!job.strategy || ['test-shards', 'o8-next-tests', 'integration-weekly'].includes(id), `${id} has an unsupported matrix`);
    for (const step of job.steps ?? []) {
      if (!step.uses) continue;
      const supported = setupActions.some(prefix => step.uses.startsWith(prefix))
        || (id === 'security' && step.uses.startsWith(auditAction))
        || (['integration-changed', 'integration-weekly'].includes(id) && step.uses === './.github/actions/linux-package-prerequisites')
        || (id === 'o8-next-tests' && step.uses === './.github/actions/next-linux-setup');
      requireCondition(supported, `action ${step.uses} in ${id} has no verify:ci equivalent`);
    }
  }
  requireCondition(JSON.stringify(jobs.test.needs) === JSON.stringify(['test-shards', 'o8-next-tests']),
    'the hermetic aggregate must require both shard and native jobs');
  const testCondition = "github.event.schedule != '41 13 * * 1'";
  requireCondition(jobs['test-shards'].if === testCondition && jobs.test.if === `always() && ${testCondition}`
    && !jobs.test['continue-on-error'], 'required test conditions or failure tolerance need a verify:ci equivalent');
  const aggregate = jobs.test.steps;
  requireCondition(aggregate?.length === 1 && !aggregate[0].if && !aggregate[0]['continue-on-error']
    && aggregate[0].run?.trim() === 'echo "Hermetic shard result: $SHARD_RESULT"\necho "Native test result: $NATIVE_RESULT"\ntest "$SHARD_RESULT" = success && test "$NATIVE_RESULT" = success'
    && aggregate[0].shell === undefined && aggregate[0]['working-directory'] === undefined
    && JSON.stringify(aggregate[0].env) === JSON.stringify({
      SHARD_RESULT: '${{ needs.test-shards.result }}', NATIVE_RESULT: '${{ needs.o8-next-tests.result }}',
    }), 'hermetic aggregate steps changed; update verify:ci coverage');
  const native = jobs['o8-next-tests'];
  requireCondition(native.name === 'o8 next Native Tests (Linux)' && native['runs-on'] === 'ubuntu-24.04'
    && native.if === testCondition && !native.defaults && !native.needs
    && isDeepStrictEqual(native.strategy, { 'fail-fast': false, matrix: { shard: [1, 2, 3, 4] } })
    && !native['continue-on-error'] && native.steps.every(step => !step['continue-on-error']),
  'native test runner or condition needs a verify:ci equivalent');
  const nativeCondition = "steps.native.outputs.changed == 'true'";
  const nativeRunSteps = native.steps.filter(step => step.run);
  requireCondition(native.steps.length === 6 && nativeRunSteps.length === 4
    && nativeRunSteps[0].id === 'native' && nativeRunSteps[0].run === 'node scripts/ci/native-changes.mjs --o8-next'
    && !nativeRunSteps[0].if && !nativeRunSteps[0].env && !nativeRunSteps[0].shell
    && !nativeRunSteps[0]['working-directory']
    && native.steps[0].uses === 'actions/checkout@v4'
    && native.steps[2].uses === './.github/actions/next-linux-setup'
    && native.steps[2].if === nativeCondition
    && !native.steps[0].if && !native.steps[0].env && !native.steps[2].env
    && isDeepStrictEqual(native.steps[0].with, { 'fetch-depth': 0, filter: 'blob:none' })
    && JSON.stringify(native.steps[2].with) === JSON.stringify({
      'cache-key': "tests-${{ hashFiles('crates/o8d/Cargo.lock') }}",
      'headless-tests': 'true',
    }),
  'native selection or setup needs a verify:ci equivalent');
  const build = 'cargo build --locked --manifest-path crates/o8d/Cargo.toml --features experimental-http --bin o8d';
  const test = "unset DISPLAY WAYLAND_DISPLAY\nTIMEFORMAT='o8 next native tests wall=%3R s'\ntime node scripts/ci/native-test-shard.mjs --cargo --phase=regular";
  const probes = "unset DISPLAY WAYLAND_DISPLAY\nTIMEFORMAT='o8 next native probes wall=%3R s'\ntime node scripts/ci/native-test-shard.mjs --cargo --phase=timed";
  requireCondition(nativeRunSteps[1].run === build && nativeRunSteps[2].run.trim() === test
    && nativeRunSteps[3].run.trim() === probes
    && nativeRunSteps.slice(1).every(step => step.if === nativeCondition
      && !step.shell && !step['working-directory'] && !step['continue-on-error'] && !step.env),
  'native test commands need a verify:ci equivalent');
  const nativeEnv = {
    CARGO_HOME: '${{ github.workspace }}/.o8-next-cargo',
    CARGO_TARGET_DIR: '${{ github.workspace }}/native/o8-next/target',
    CARGO_PROFILE_DEV_DEBUG: '0', CARGO_INCREMENTAL: '0',
    O8_NATIVE_REAL_WINDOW_TESTS: 'true',
    O8D_HTTP_TEST_BINARY: '${{ github.workspace }}/native/o8-next/target/debug/o8d',
    O8_NATIVE_TEST_SHARD: '${{ matrix.shard }}/4',
  };
  requireCondition(JSON.stringify(native.env) === JSON.stringify(nativeEnv), 'native environment needs a verify:ci equivalent');
  const setup = parse(readFileSync(path.join(root, '.github/actions/next-linux-setup/action.yml'), 'utf8'));
  const setupNodeVersion = jobs.typecheck.steps.find(step => step.uses?.startsWith('actions/setup-node@'))?.with?.['node-version'];
  const expectedSetup = [
    { uses: 'actions/setup-node@v4', with: { 'node-version': setupNodeVersion, cache: 'npm' } },
    { shell: 'bash', run: `npm install -g "$(node -p 'require("./package.json").packageManager')"` },
    { shell: 'bash', run: 'npm ci --prefer-offline' },
    { uses: 'dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c', with: { toolchain: 'stable' } },
    { uses: 'Swatinem/rust-cache@e18b497796c12c097a38f9edb9d0641fb99eee32', with: {
      workspaces: 'native/o8-next', key: '${{ inputs.cache-key }}', 'save-if': "${{ github.ref == 'refs/heads/main' }}",
    } },
    { shell: 'bash', env: { O8_NATIVE_HEADLESS_TESTS: '${{ inputs.headless-tests }}' },
      run: 'bash scripts/ci/install-native-linux-deps.sh' },
    { if: "inputs.browser == 'true'", shell: 'bash', run: 'npx --no-install playwright-core install --with-deps chromium' },
  ];
  const execution = setup.runs?.steps?.map(step => Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'name')));
  requireCondition(setup.runs?.using === 'composite' && isDeepStrictEqual(execution, expectedSetup)
    && setup.inputs?.browser?.default === 'false' && setup.inputs?.['cache-key']?.default === ''
    && setup.inputs?.['headless-tests']?.default === 'false',
  'native setup action needs a verify:ci equivalent');
  const shardJob = jobs['test-shards'];
  const shards = shardJob.strategy?.matrix?.shard;
  requireCondition(Array.isArray(shards) && shards.length > 0, 'hermetic shard matrix is missing');
  requireCondition(new Set(shards).size === shards.length, 'hermetic shards must be unique');
  const classification = selectedSteps(shardJob, 1).filter(step => step.run === 'npm run test:classification:check');
  requireCondition(classification.length === 1, 'CI must check test classification exactly once');
  const checks = [];
  const dependencies = job => [job.needs ?? []].flat().map(id => id === 'test-shards' ? 'test' : id);
  const appendJob = id => {
    const steps = selectedSteps(jobs[id]).map(step => runStep(step, jobs[id], undefined, scripts));
    requireCondition(steps.length > 0, `${id} has no local checks`);
    checks.push({ id, after: dependencies(jobs[id]), name: jobs[id].name, steps });
  };
  appendJob('typecheck');
  appendJob('lint');
  if (nativeLocal) checks.push({ id: 'o8-next-tests', after: [], name: native.name, nativeInputs: true,
    timeoutMs: native['timeout-minutes'] * 60_000,
    // Each matrix job shares one build/test deadline. Run the same pairs
    // serially against a shared cache without charging earlier shard time.
    steps: [1, 2, 3, 4].flatMap(shard => nativeRunSteps.slice(1).map(step => ({
      ...runStep({ ...step, env: {} }, {
        ...native, env: Object.fromEntries(Object.entries(nativeEnv).map(([key, value]) =>
          [key, value.replaceAll('${{ github.workspace }}', root)])),
      }, shard, scripts), budgetGroup: shard,
    }))),
  });
  checks.push({ id: 'classification', after: dependencies(shardJob), name: classification[0].name ?? 'Test Classification',
    steps: classification.map(step => runStep(step, shardJob, 1, scripts)) });
  const unitSteps = shards.flatMap(shard => selectedSteps(shardJob, shard)
    .filter(step => step.run !== classification[0].run)
    .map(step => {
      const unit = runStep(step, shardJob, shard, scripts);
      return { ...unit, env: { NODE_ENV: 'test', ...unit.env } };
    }));
  requireCondition(unitSteps.some(step => step.command.startsWith('npm run test:unit -- ')), 'CI must execute its hermetic unit entry point');
  checks.push({ id: 'test', after: ['classification'], requiredResults: nativeLocal ? ['o8-next-tests'] : [], name: jobs.test.name, steps: unitSteps });
  appendJob('server-bundle-size');
  const integration = jobs['integration-changed'];
  const packageAction = './.github/actions/linux-package-prerequisites';
  const packageSetup = parse(readFileSync(path.join(root, `${packageAction}/action.yml`), 'utf8'));
  const cachePin = '5a3ec84eff668545956fd18022155c47e93e2684';
  const archivePaths = '${{ steps.identity.outputs.path }}/*.deb\n${{ steps.identity.outputs.path }}/manifest.json\n';
  const expectedPackages = [
    { id: 'identity', shell: 'bash', env: { O8_PACKAGE_GROUP: '${{ inputs.group }}' },
      run: 'node scripts/ci/linux-package-prerequisites.mjs key --group="$O8_PACKAGE_GROUP"' },
    { uses: `actions/cache/restore@${cachePin}`, id: 'archives', with: {
      path: archivePaths, key: '${{ steps.identity.outputs.key }}',
      'restore-keys': '${{ steps.identity.outputs.key }}-',
    } },
    { id: 'install', shell: 'bash', env: { O8_PACKAGE_GROUP: '${{ inputs.group }}',
      O8_PACKAGE_CACHE: '${{ steps.identity.outputs.path }}' },
    run: 'node scripts/ci/linux-package-prerequisites.mjs install --group="$O8_PACKAGE_GROUP" --cache="$O8_PACKAGE_CACHE"' },
    { uses: `actions/cache/save@${cachePin}`,
      if: "github.ref == 'refs/heads/main' && steps.install.outputs.source == 'download'",
      with: { path: archivePaths, key: '${{ steps.identity.outputs.key }}-${{ steps.install.outputs.revision }}' } },
  ];
  requireCondition(packageSetup.runs?.using === 'composite'
    && isDeepStrictEqual(packageSetup.runs.steps, expectedPackages)
    && isDeepStrictEqual(packageSetup.inputs?.group, { description: 'Package group, rust or resources.', required: true }),
  'Linux package prerequisite action needs a verify:ci equivalent');
  const resourceSetup = integration.steps.filter(step => step.uses === packageAction);
  requireCondition(resourceSetup.length === 1
    && isDeepStrictEqual(Object.fromEntries(Object.entries(resourceSetup[0]).filter(([key]) => key !== 'name')), {
      if: "steps.select.outputs.count != '0'", uses: packageAction, with: { group: 'resources' },
    }), 'Linux package prerequisite selection needs a verify:ci equivalent');
  const selection = integration.steps.find(step => step.id === 'select');
  requireCondition(selection?.run === 'node scripts/ci/resource-owning-changed.mjs "$BASE_REF" "$HEAD_REF"',
    'integration selection needs a verify:ci equivalent');
  requireCondition(JSON.stringify(selection.env) === JSON.stringify({
    BASE_REF: "${{ github.event.merge_group.base_sha || (github.event_name == 'pull_request' && format('origin/{0}', github.base_ref)) || inputs.integration_base }}",
    HEAD_REF: '${{ github.event.merge_group.head_sha || github.sha }}',
  }), 'integration comparison refs need a verify:ci equivalent');
  const integrationRun = integration.steps.find(step => step.run === 'npm run test:integration -- ${{ steps.select.outputs.files }}');
  requireCondition(integrationRun?.if === "steps.select.outputs.count != '0'", 'integration command changed');
  const policySteps = integration.steps.filter(step => step.run === integrationPolicyCommand);
  const integrationPolicy = policySteps[0];
  requireCondition(policySteps.length === 1
    && isDeepStrictEqual(Object.fromEntries(Object.entries(integrationPolicy).filter(([key]) => key !== 'name')), {
      if: "steps.select.outputs.count != '0'", run: integrationPolicyCommand,
    }) && integration.steps.indexOf(integrationPolicy) < integration.steps.indexOf(integrationRun),
  'integration immutable policy prerequisite needs a verify:ci equivalent');
  const browserCondition = "steps.select.outputs.browser == 'true'";
  const browserSteps = integration.steps.filter(step => step.if === browserCondition
    && step.run === 'npx --no-install playwright-core install --with-deps chromium');
  requireCondition(browserSteps.length === 1, 'CI must declare exactly one metadata-selected browser prerequisite');
  for (const step of integration.steps.filter(step => step.run)) {
    requireCondition(step.shell === undefined && step['working-directory'] === undefined, 'unsupported integration execution metadata');
    requireCondition(step === selection || browserSteps.includes(step) || (step.if === "steps.select.outputs.count != '0'"
      && (bootstrapCommands.has(step.run.trim()) || step === integrationRun || step === integrationPolicy)),
    'integration step needs a verify:ci equivalent');
  }
  const full = jobs['integration-weekly'];
  requireCondition(full.if === "(github.event_name == 'push' && github.ref == 'refs/heads/main') || github.event.schedule == '17 5 * * 0' || (github.event_name == 'workflow_dispatch' && inputs.integration_base == '')"
    && full.needs === 'test' && !full['continue-on-error'] && full['runs-on'] === 'ubuntu-latest'
    && Number.isFinite(full['timeout-minutes']) && full['timeout-minutes'] > 0
    && isDeepStrictEqual(full.strategy, { 'fail-fast': false, matrix: { shard: [1, 2, 3, 4, 5, 6] } }),
  'main pushes must retain the complete integration matrix');
  const fullSetup = full.steps.filter(step => step.uses === packageAction);
  requireCondition(fullSetup.length === 1
    && isDeepStrictEqual(Object.fromEntries(Object.entries(fullSetup[0]).filter(([key]) => key !== 'name')), {
      uses: packageAction, with: { group: 'resources' },
    }), 'full integration package prerequisites need a verify:ci equivalent');
  const fullRun = full.steps.find(step => step.run === 'npm run test:integration');
  const fullPolicySteps = full.steps.filter(step => step.run === integrationPolicyCommand);
  const fullPolicy = fullPolicySteps[0];
  requireCondition(fullPolicySteps.length === 1
    && isDeepStrictEqual(Object.fromEntries(Object.entries(fullPolicy).filter(([key]) => key !== 'name')), {
      run: integrationPolicyCommand,
    }) && full.steps.indexOf(fullPolicy) < full.steps.indexOf(fullRun),
  'full integration immutable policy prerequisite needs a verify:ci equivalent');
  const fullBrowser = full.steps.find(step => step.run === 'npx --no-install playwright-core install --with-deps chromium');
  const fullClassification = full.steps.find(step => step.run === 'npm run test:classification:check');
  requireCondition(fullRun && !fullRun.if && fullBrowser && !fullBrowser.if
    && fullClassification?.if === 'matrix.shard == 1'
    && isDeepStrictEqual(fullRun.env, { O8_INTEGRATION_SHARD: '${{ matrix.shard }}/6', O8_INTEGRATION_BASELINE: 'tests/integration-linux-baseline.json' }),
  'full integration commands and prerequisites need a verify:ci equivalent');
  for (const step of full.steps.filter(step => step.run)) {
    requireCondition(!step['continue-on-error'] && !step.shell && !step['working-directory']
      && (step === fullRun || step === fullBrowser || step === fullClassification || step === fullPolicy
        || (!step.if && bootstrapCommands.has(step.run.trim()))),
    'full integration step needs a verify:ci equivalent');
  }
  if (fullIntegration) {
    checks.push({ id: 'integration-weekly', after: dependencies(full), name: 'Weekly Integration Tests (all shards)',
      timeoutMs: full['timeout-minutes'] * 60_000,
      steps: [
        { ...runStep(fullPolicy, full, 1, scripts), budgetGroup: 1, stopOnFailure: true },
        { ...runStep(fullBrowser, full, 1, scripts), budgetGroup: 1 },
        { ...runStep(fullClassification, full, 1, scripts), budgetGroup: 1 },
        ...full.strategy.matrix.shard.map(shard => ({ ...runStep(fullRun, full, shard, scripts), budgetGroup: shard })),
      ],
    });
  } else {
    checks.push({ id: 'integration-changed', after: dependencies(integration), name: integration.name, steps: [
      { ...runStep(integrationPolicy, integration, undefined, scripts), requiresIntegration: true, stopOnFailure: true },
      ...browserSteps.map(step => ({ ...runStep(step, integration, undefined, scripts), requiresBrowser: true })),
      { ...runStep({ ...integrationRun, run: 'npm run test:integration --' }, integration, undefined, scripts), selectedFiles: true },
    ] });
  }
  const audit = jobs.security.steps.find(step => step.uses?.startsWith(auditAction));
  requireCondition(audit, 'native dependency audit is missing');
  const ignores = String(audit.with?.ignore ?? '').split(',').map(value => value.trim()).filter(Boolean);
  requireCondition(ignores.every(value => /^RUSTSEC-\d{4}-\d{4}$/.test(value)), 'native audit ignore list is malformed');
  const auditFile = path.posix.join(audit.with?.['working-directory'] ?? '.', 'Cargo.lock');
  checks.push({ id: 'security', after: dependencies(jobs.security), name: jobs.security.name, steps: [
    ...selectedSteps(jobs.security).map(step => runStep(step, jobs.security, undefined, scripts)),
    { command: `cargo-audit audit --file ${quote(auditFile)}${ignores.map(value => ` --ignore ${quote(value)}`).join('')}`,
      env: {}, timeoutMs: jobs.security['timeout-minutes'] * 60_000 },
  ] });
  appendJob('governance-smoke');
  const scheduled = new Set();
  for (const check of checks) {
    requireCondition(check.after.every(id => scheduled.has(id)), `${check.id} needs an unsupported local dependency order`);
    scheduled.add(check.id);
  }
  const nodeVersions = new Set(localJobs.flatMap(id => jobs[id].steps
    .filter(step => step.uses?.startsWith('actions/setup-node@'))
    .map(step => String(step.with?.['node-version']))));
  requireCondition(nodeVersions.size === 1, 'local checks must use one supported runtime version');
  const nodeMajor = [...nodeVersions][0];
  requireCondition(/^\d+$/.test(nodeMajor), 'CI runtime version must identify a major version');
  const browserManifest = JSON.parse(readFileSync(path.join(root, 'tests/test-classification.json'), 'utf8'));
  const expectedBrowsers = new Set(buildTestClassificationReport(root).manifest.resourceOwning
    .filter(entry => entry.browser).map(entry => entry.path));
  const actualBrowsers = new Set((browserManifest.resourceOwning ?? []).filter(entry => entry.browser).map(entry => entry.path));
  for (const file of new Set([...expectedBrowsers, ...actualBrowsers])) {
    requireCondition(expectedBrowsers.has(file) === actualBrowsers.has(file), `${file}: browser metadata drifted; run npm run test:classify`);
  }
  return { checks, hostedJobs, nodeMajor, notes: ['Hosted check publication remains on the runner.',
    'Linux package archive caching and privileged system installation remain hosted setup; install the documented resource-test prerequisites locally.'] };
}
