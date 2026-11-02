import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repo = process.cwd();
const workflow = parse(readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8'));
const root = mkdtempSync(path.join(tmpdir(), 'o8-ci-gates-'));
const probeRoot = mkdtempSync(path.join(tmpdir(), 'o8-ci-native-probe-'));
const nativeScript = path.join(repo, 'scripts/ci/native-changes.mjs');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(probeRoot, { recursive: true, force: true });
});

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

git('init', '-q', '-b', 'main');
git('config', 'user.name', 'CI Fixture');
git('config', 'user.email', 'fixture@example.invalid');
writeFileSync(path.join(root, 'README.md'), 'fixture\n');
git('add', '.');
git('commit', '-qm', 'fixture base');
const base = git('rev-parse', 'HEAD');

function commit(file: string, remove = false, retainContents = false): string {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  if (remove) rmSync(target);
  else writeFileSync(target, retainContents ? readFileSync(target, 'utf8') + '\n' : `${git('rev-parse', 'HEAD')}\n`);
  git('add', '--', file);
  git('commit', '-qm', 'fixture change');
  return git('rev-parse', 'HEAD');
}

function select(eventName: string, event: object): string {
  const eventPath = path.join(root, 'event.json');
  const outputPath = path.join(root, 'output.txt');
  writeFileSync(eventPath, JSON.stringify(event));
  writeFileSync(outputPath, '');
  // Execute the selector command wired into each required job, from a real
  // committed fixture repository; no GitHub API or native build is involved.
  for (const id of ['rust-check-linux', 'rust-check-windows']) {
    const step = workflow.jobs[id].steps.find((entry: { id?: string }) => entry.id === 'native');
    expect(step, `${id} must select inputs inside the required job`).toBeDefined();
    const command = step.run.replace('scripts/ci/native-changes.mjs', nativeScript);
    const result = spawnSync(command, {
      shell: true,
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
    });
    expect(result.status, result.stderr).toBe(0);
  }
  const outputs = readFileSync(outputPath, 'utf8').trim().split('\n');
  expect(outputs).toHaveLength(2);
  expect(outputs[0]).toBe(outputs[1]);
  return outputs[0];
}

function condition(source: string, github: object, needs: object = {}): boolean {
  const expression = source.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replaceAll('needs.test-shards', 'needs["test-shards"]');
  return Boolean(new Function('github', 'inputs', 'needs', 'always', `return (${expression});`)(
    github, { integration_base: '' }, needs, () => true,
  ));
}

describe('required CI gates through workflow commands', () => {
  it('keeps the merge-group trigger and the eight required check names', () => {
    expect(workflow.on.merge_group).toEqual({ types: ['checks_requested'], branches: ['main'] });
    const required = {
      typecheck: 'Type Check', lint: 'Lint', test: 'Hermetic Unit Tests', security: 'Security Audit',
      'governance-smoke': 'Governance Smoke', 'rust-check-linux': 'Rust Compile Gate (Linux)',
      'rust-check-windows': 'Rust Compile Gate (Windows)', 'integration-changed': 'Integration Tests (changed files)',
    };
    for (const [id, name] of Object.entries(required)) {
      expect(workflow.jobs[id].name).toBe(name);
      for (const event_name of ['pull_request', 'merge_group']) {
        expect(condition(workflow.jobs[id].if, { event_name, event: {} }, {
          'test-shards': { result: 'success' },
        }), `${id} must report on ${event_name}`).toBe(true);
      }
    }
  });

  it('skips compile work for TypeScript-only PRs and main pushes', () => {
    const head = commit('src/fixture.ts');
    expect(select('pull_request', { pull_request: { base: { sha: base }, head: { sha: head } } }))
      .toBe('changed=false');
    expect(select('push', { before: base, after: head })).toBe('changed=false');
  });

  it.each(['src-tauri/src/fixture.rs', 'crates/fixture/Cargo.toml', 'Cargo.lock',
    '.cargo/config.toml', 'rust-toolchain.toml', 'src-tauri/tauri.conf.json',
    'src-tauri/capabilities/fixture.json', 'tauri-plugin-mcp/src/fixture.rs',
    'tests/fixtures/update-ping-native/src/lib.rs', 'scripts/test-update-ping-native.mjs',
    '.github/workflows/ci.yml', 'scripts/ci/native-changes.mjs',
    '.github/actions/linux-package-prerequisites/action.yml',
    'scripts/ci/linux-package-prerequisites.mjs', 'scripts/ci/linux-package-prerequisites.json'])('compiles when %s changes', (file) => {
    const before = git('rev-parse', 'HEAD');
    const head = commit(file);
    expect(select('push', { before, after: head })).toBe('changed=true');
  });

  it('covers every queued commit but ignores an unrelated later checkout', () => {
    const queueBase = git('rev-parse', 'HEAD');
    commit('src/queued.ts');
    const head = commit('src-tauri/src/queued.rs');
    const group = { base_sha: queueBase, head_sha: head };
    commit('src/later.ts');
    expect(select('merge_group', { merge_group: group })).toBe('changed=true');
    expect(select('merge_group', { merge_group: { base_sha: head, head_sha: head } })).toBe('changed=false');
  });

  it('compares PRs from their merge base, excluding base-branch-only native changes', () => {
    const fork = git('rev-parse', 'HEAD');
    const head = commit('src/pr-only.ts');
    git('checkout', '-qb', 'fixture/upstream', fork);
    const upstream = commit('src-tauri/src/base-only.rs');
    expect(select('pull_request', { pull_request: { base: { sha: upstream }, head: { sha: head } } }))
      .toBe('changed=false');
    git('checkout', '-q', 'main');
  });

  it('detects deleted and renamed native inputs', () => {
    const before = commit('src-tauri/src/removed.rs');
    const deleted = commit('src-tauri/src/removed.rs', true);
    expect(select('push', { before, after: deleted })).toBe('changed=true');
    const renameBase = commit('crates/fixture/Cargo.lock');
    git('mv', 'crates/fixture/Cargo.lock', 'crates/fixture/old-lock.txt');
    git('commit', '-qm', 'fixture rename');
    expect(select('push', { before: renameBase, after: git('rev-parse', 'HEAD') })).toBe('changed=true');
  });

  it('forces manual runs and fails safe when comparison refs are unavailable', () => {
    expect(select('workflow_dispatch', {})).toBe('changed=true');
    expect(select('push', { before: '0'.repeat(40), after: base })).toBe('changed=true');
    expect(select('pull_request', { pull_request: { base: { sha: 'missing' }, head: { sha: base } } }))
      .toBe('changed=true');
  });

  it('guards all expensive native steps while leaving each required job enabled', () => {
    for (const id of ['rust-check-linux', 'rust-check-windows']) {
      const steps = workflow.jobs[id].steps;
      expect(steps[0].uses).toBe('actions/checkout@v4');
      expect(steps[0].with['fetch-depth']).toBe(0);
      expect(steps[0].with.filter).toBe('blob:none');
      expect(steps[1].id).toBe('native');
      for (const step of steps.slice(2)) expect(step.if).toBe("steps.native.outputs.changed == 'true'");
      const cache = steps.find((step: { uses?: string }) => step.uses?.startsWith('Swatinem/rust-cache@'));
      expect(cache.with['save-if']).toBe("${{ github.ref == 'refs/heads/main' }}");
    }
  });

  it('runs four independent shards and fails the stable aggregate on every non-success', () => {
    const shards = workflow.jobs['test-shards'];
    expect(shards.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2, 3, 4] } });
    expect(workflow.jobs.test.needs).toEqual(['test-shards', 'o8-next-tests']);
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      expect(condition(workflow.jobs.test.if, { event: {} }, { 'test-shards': { result } })).toBe(true);
      const step = workflow.jobs.test.steps[0];
      const run = spawnSync(step.run, {
        shell: true, encoding: 'utf8',
        env: { ...process.env, SHARD_RESULT: result, NATIVE_RESULT: 'success' },
      });
      expect(run.status).toBe(result === 'success' ? 0 : 1);
    }
    const monday = { event: { schedule: '41 13 * * 1' } };
    expect(condition(shards.if, monday)).toBe(false);
    expect(condition(workflow.jobs.test.if, monday, { 'test-shards': { result: 'skipped' } })).toBe(false);
    expect(workflow.jobs['integration-weekly'].needs).toBe('test');
  });

  it('restores lint and typecheck caches, refreshing them only on main', () => {
    for (const id of ['lint', 'typecheck']) {
      const steps = workflow.jobs[id].steps;
      const restore = steps.find((step: { uses?: string }) => step.uses === 'actions/cache/restore@v4');
      const save = steps.find((step: { uses?: string }) => step.uses === 'actions/cache/save@v4');
      expect(restore?.with.path).toBe(id === 'lint' ? '.cache/eslint' : 'tsconfig.tsbuildinfo');
      expect(restore.with['restore-keys']).toBeTruthy();
      expect(save?.with.path).toBe(restore.with.path);
      expect(save.if).toContain("github.ref == 'refs/heads/main'");
    }
    expect(workflow.jobs.lint.steps.some((step: { run?: string }) =>
      step.run?.includes('--cache --cache-strategy content --cache-location .cache/eslint'))).toBe(true);
  });

  it('proves the actual shard union equals the unsharded hermetic entry point', () => {
    const result = spawnSync(process.execPath, ['scripts/ci/check-hermetic-shards.mjs'], {
      cwd: repo, encoding: 'utf8', timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout, result.stderr).toMatch(/\d+ files, 4 shards, 0 missing, 0 duplicates, 0 extra/);
  }, 60_000);
});

function selectNext(eventName: string, event: object, script = nativeScript): string {
  const job = workflow.jobs['o8-next-tests'];
  expect(job, 'native tests must have an automatic CI job').toBeDefined();
  const step = job.steps.find((entry: { id?: string }) => entry.id === 'native');
  const eventPath = path.join(root, 'next-event.json');
  const outputPath = path.join(root, 'next-output.txt');
  writeFileSync(eventPath, JSON.stringify(event));
  writeFileSync(outputPath, '');
  const result = spawnSync(step.run.replace('scripts/ci/native-changes.mjs', script), {
    shell: true, cwd: root, encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath },
  });
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(outputPath, 'utf8').trim();
}

describe('native next CI through persisted fixtures', () => {
  it('discovers new native literals, transitive imports, aliases and dynamic fixture directories without a maintained list', () => {
    const files = {
      'native/o8-next/src/dependency_probe.rs': 'const CONTRACT: &str = include_str!("../../../fixtures/native-contract.json"); const HOST: &str = "scripts/next/dependency-probe.mjs"; fn family() { std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/native-family").join(format!("{name}.json"))); }',
      'scripts/next/dependency-probe.mjs': "import '../../fixtures/native-adapter.mjs';",
      'fixtures/native-contract.json': '{}',
      'fixtures/native-adapter.mjs': "import '@/lib/native-probe'; import(`./native-records/${name}.json`); const template = 'native-template.md'; readFileSync(join(here, 'prompts', template));",
      'src/lib/native-probe.ts': "import '../../fixtures/native-bootstrap'; export { value } from '../../fixtures/native-leaf';",
      'fixtures/native-bootstrap.mjs': 'globalThis.fixtureReady = true;',
      'fixtures/native-leaf.ts': 'export const value = 1;',
      'fixtures/native-records/one.json': '{}',
      'fixtures/native-family/one.json': '{}',
      'fixtures/prompts/native-template.md': 'fixture template',
    };
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), contents);
    }
    mkdirSync(path.join(root, 'scripts/ci'), { recursive: true });
    copyFileSync(nativeScript, path.join(root, 'scripts/ci/native-changes.mjs'));
    const helper = 'scripts/ci/native-test-inputs.mjs';
    if (existsSync(path.join(repo, helper))) copyFileSync(path.join(repo, helper), path.join(root, helper));
    git('add', '.');
    git('commit', '-qm', 'native dependency fixture');
    const script = path.join(root, 'scripts/ci/native-changes.mjs');
    for (const file of Object.keys(files).filter(file => !/^(native|scripts)\//.test(file))) {
      const before = git('rev-parse', 'HEAD');
      const after = commit(file, false, true);
      expect(selectNext('push', { before, after }, script), file).toBe('changed=true');
      expect(selectNext('pull_request', { pull_request: { base: { sha: before }, head: { sha: after } } }, script), file)
        .toBe('changed=true');
      expect(selectNext('merge_group', { merge_group: { base_sha: before, head_sha: after } }, script), file)
        .toBe('changed=true');
    }
    for (const file of ['fixtures/native-contract.json', 'fixtures/native-records/one.json', 'fixtures/native-family/one.json',
      'fixtures/prompts/native-template.md']) {
      const before = git('rev-parse', 'HEAD');
      const after = commit(file, true);
      expect(selectNext('push', { before, after }, script), `deleted ${file}`).toBe('changed=true');
    }
    const before = git('rev-parse', 'HEAD');
    const after = commit('fixtures/unrelated.ts');
    expect(selectNext('push', { before, after }, script)).toBe('changed=false');
  });

  it.each([true, false])('installs only missing native prerequisites, headless=%s', headless => {
    const setup = parse(readFileSync(path.join(repo, '.github/actions/next-linux-setup/action.yml'), 'utf8'));
    const step = setup.runs.steps.find((entry: { name?: string }) => entry.name?.startsWith('Install X11'));
    const bin = path.join(probeRoot, 'setup-bin');
    mkdirSync(bin, { recursive: true });
    const receipt = path.join(probeRoot, 'apt-calls.jsonl');
    for (const [name, body] of Object.entries({
      sudo: `require('node:fs').appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      'dpkg-query': "if (process.env.FIXTURE_PACKAGES_INSTALLED === 'true') console.log('install ok installed'); else process.exit(1);",
    })) {
      const file = path.join(bin, name);
      writeFileSync(file, `#!${process.execPath}\n${body}\n`);
      chmodSync(file, 0o700);
    }
    const run = (installed: boolean) => {
      writeFileSync(receipt, '');
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step.run], { cwd: repo, encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, O8_NATIVE_HEADLESS_TESTS: String(headless),
          FIXTURE_PACKAGES_INSTALLED: String(installed) } });
      expect(result.status, result.stderr).toBe(0);
      return readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
    };
    expect(run(true), 'installed runner packages must not be upgraded or fetched again').toEqual([]);
    const missing = run(false);
    expect(missing).toHaveLength(2);
    expect(missing[1]).toContain('libfontconfig1-dev');
    for (const graphical of ['mesa-vulkan-drivers', 'xvfb', 'tesseract-ocr']) {
      expect(missing[1].includes(graphical)).toBe(!headless);
    }
  });

  it.each(['native/o8-next/src/main.rs', 'native/o8-next/README.md',
    'native/o8-next/fixtures/state.json', 'scripts/next/dev-server.ts',
    'scripts/parity/surfaces.json', 'tests/helpers/chatgpt-plan-fixture.ts',
    'crates/o8d/src/main.rs', 'package-lock.json', '.cargo/config.toml', 'rust-toolchain.toml', '.github/workflows/ci.yml',
    'scripts/ci/native-changes.mjs', 'scripts/ci/native-test-shard.mjs'])('selects native tests for %s', file => {
    const before = git('rev-parse', 'HEAD');
    const after = commit(file);
    expect(selectNext('push', { before, after })).toBe('changed=true');
    expect(selectNext('pull_request', { pull_request: { base: { sha: before }, head: { sha: after } } }))
      .toBe('changed=true');
    expect(selectNext('merge_group', { merge_group: { base_sha: before, head_sha: after } }))
      .toBe('changed=true');
  });

  it('skips unrelated changes, includes removed inputs and fails safe on missing history', () => {
    const before = git('rev-parse', 'HEAD');
    const after = commit('src/unrelated.ts');
    expect(selectNext('push', { before, after })).toBe('changed=false');
    expect(selectNext('pull_request', { pull_request: { base: { sha: before }, head: { sha: after } } }))
      .toBe('changed=false');
    expect(selectNext('merge_group', { merge_group: { base_sha: before, head_sha: after } })).toBe('changed=false');
    const renameBase = commit('native/o8-next/removed.txt');
    git('mv', 'native/o8-next/removed.txt', 'renamed-outside.txt');
    git('commit', '-qm', 'fixture rename outside native');
    expect(selectNext('push', { before: renameBase, after: git('rev-parse', 'HEAD') })).toBe('changed=true');
    const deleteBase = commit('native/o8-next/deleted.txt');
    const deleted = commit('native/o8-next/deleted.txt', true);
    expect(selectNext('push', { before: deleteBase, after: deleted })).toBe('changed=true');
    expect(selectNext('workflow_dispatch', {})).toBe('changed=true');
    expect(selectNext('push', { before: 'missing', after })).toBe('changed=true');
  });

  it('runs the declared headless cargo command against red and green persisted state', () => {
    const job = workflow.jobs['o8-next-tests'];
    expect(job, 'native tests must have an automatic CI job').toBeDefined();
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job['timeout-minutes']).toBe(30);
    expect(job.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2, 3, 4] } });
    expect(job.if).toBe(workflow.jobs['test-shards'].if);
    const step = job.steps.find((entry: { run?: string }) => entry.run?.includes('native-test-shard.mjs'));
    expect(step.if).toBe("steps.native.outputs.changed == 'true'");
    expect(step['continue-on-error']).toBeUndefined();
    expect(step.run).toContain('node scripts/ci/native-test-shard.mjs --cargo');
    const directory = probeRoot;
    const crate = path.join(directory, 'native/o8-next');
    mkdirSync(path.join(crate, 'src'), { recursive: true });
    writeFileSync(path.join(crate, 'Cargo.toml'), '[package]\nname = "native-probe"\nversion = "0.0.0"\nedition = "2024"\n[workspace]\n');
    writeFileSync(path.join(crate, 'Cargo.lock'), 'version = 4\n\n[[package]]\nname = "native-probe"\nversion = "0.0.0"\n');
    writeFileSync(path.join(crate, 'src/main.rs'), `fn main() {}
#[test]
fn persisted_state() {
    assert!(std::env::var_os("DISPLAY").is_none());
    assert!(std::env::var_os("WAYLAND_DISPLAY").is_none());
    let state = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/state")).unwrap();
    assert_eq!(state, "ready");
}
`);
    const runner = path.join(repo, 'scripts/ci/native-test-shard.mjs').replaceAll("'", "'\"'\"'");
    const command = step.run.replace('scripts/ci/native-test-shard.mjs', `'${runner}'`);
    const run = () => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', command], {
      cwd: directory, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, CARGO_NET_OFFLINE: 'true', CARGO_TARGET_DIR: path.join(directory, 'target'),
        DISPLAY: 'fixture-display', WAYLAND_DISPLAY: 'fixture-display', O8_NATIVE_TEST_SHARD: '1/1' },
    });
    writeFileSync(path.join(crate, 'state'), 'blocked');
    const red = run();
    expect(red.error, red.stderr + red.stdout).toBeUndefined();
    expect(red.status, red.stderr).toBe(101);
    expect(red.stdout).toContain('persisted_state ... FAILED');
    const source = path.join(crate, 'src/main.rs');
    const valid = readFileSync(source, 'utf8');
    writeFileSync(source, valid + '\nfn required_signature(_: bool) {}\nfn probe() { required_signature(); }\n');
    const compileRed = run();
    expect(compileRed.error, compileRed.stderr + compileRed.stdout).toBeUndefined();
    expect(compileRed.status, compileRed.stderr).toBe(101);
    expect(compileRed.stderr).toContain('E0061');
    writeFileSync(source, valid);
    writeFileSync(path.join(crate, 'state'), 'ready');
    const green = run();
    expect(green.error, green.stderr + green.stdout).toBeUndefined();
    expect(green.status, green.stderr).toBe(0);
    expect(green.stdout).toContain('1 passed; 0 failed');
    console.log('declared native command: assertion red=101, E0061 red=101, green=0');
  });

  it('fails the required aggregate for every unsuccessful native result', () => {
    const aggregate = workflow.jobs.test;
    const step = aggregate.steps[0];
    for (const result of ['success', 'failure', 'cancelled', 'skipped']) {
      const run = spawnSync(step.run, {
        shell: true, encoding: 'utf8',
        env: { ...process.env, SHARD_RESULT: 'success', NATIVE_RESULT: result },
      });
      expect(run.status, `native result ${result} must reach the required gate`).toBe(result === 'success' ? 0 : 1);
    }
    expect(aggregate.needs).toContain('o8-next-tests');
  });
});
