import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/linux-gpui-publish.yml', 'utf8'));

it('requires a manual opt-in before granting release write access', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.on.workflow_dispatch.inputs.publish_linux).toMatchObject({ type: 'boolean', default: false });
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(workflow.jobs.attach.if).toBe('inputs.publish_linux == true');
});

it('authenticates exact-tag GPUI bytes before an upload without replacement or feed writes', () => {
  const commands = workflow.jobs.attach.steps.filter((step: { run?: string }) => step.run)
    .map((step: { run: string }) => step.run).join('\n');
  const verification = commands.indexOf('node scripts/prepare-linux-release-attachment.mjs');
  const upload = commands.indexOf('node scripts/upload-linux-release-assets.mjs');
  const prepare = workflow.jobs.attach.steps.find((step: { run?: string }) => step.run?.includes('node scripts/prepare-linux-release-attachment.mjs'));
  expect(prepare.env.O8_PUBLISH_LINUX).toBe('${{ inputs.publish_linux }}');
  expect(commands).toContain('run.head_sha !== process.env.EXPECTED_SHA');
  expect(commands).toContain('run.path !== ".github/workflows/linux-downloads.yml"');
  expect(verification).toBeGreaterThan(0);
  expect(upload).toBeGreaterThan(verification);
  expect(commands).not.toContain('--clobber');
  expect(commands).not.toMatch(/publish\/\*\.(deb|rpm)/);
  expect(commands).not.toMatch(/(?:latest|beta|preview)\.json/);
});


it('pins actions and verifies from the release tag without saved credentials', () => {
  for (const step of workflow.jobs.attach.steps) {
    if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  }
  const checkout = workflow.jobs.attach.steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/checkout@'));
  expect(checkout.with).toEqual({ ref: 'refs/tags/${{ inputs.release_tag }}', 'persist-credentials': false });
  const commands = workflow.jobs.attach.steps.map((step: { run?: string }) => step.run ?? '').join('\n');
  expect(commands).toContain('node scripts/ci/check-linux-glibc.mjs --max 2.35 "$image"');
  expect(commands).not.toContain('git fetch');
});


it('rolls back its partial pair, permits a rerun, and preserves preexisting assets', () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-upload-'));
  const name = 'o8-1.2.3-x86_64.AppImage';
  try {
    mkdirSync(join(root, 'publish'));
    mkdirSync(join(root, 'bin'));
    for (const file of [name, name + '.sig']) writeFileSync(join(root, 'publish', file), 'verified');
    const state = join(root, 'state.json');
    writeFileSync(state, JSON.stringify({ assets: [], fail: true }));
    const gh = join(root, 'bin/gh');
    writeFileSync(gh, `#!${process.execPath}
      const fs = require('node:fs');
      const state = JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE));
      const args = process.argv.slice(2);
      const save = () => fs.writeFileSync(process.env.FIXTURE_STATE, JSON.stringify(state));
      if (args[0] === 'api' && args.length === 2) console.log(JSON.stringify({assets: state.assets}));
      else if (args[1] === 'upload') {
        for (const arg of args.filter(arg => arg.includes('#'))) {
          const [file, label] = arg.split('#');
          state.assets.push({id: state.assets.length + 1, name: file.split('/').pop(), label, size: fs.statSync(file).size});
          save();
          if (state.fail) { state.fail = false; save(); process.exit(1); }
        }
      } else if (args[0] === 'api' && args[2] === 'DELETE') {
        state.assets = state.assets.filter(asset => asset.id !== Number(args[3].split('/').pop())); save();
      } else process.exit(9);
    `);
    chmodSync(gh, 0o755);
    const run = () => spawnSync(process.execPath, [resolve('scripts/upload-linux-release-assets.mjs')], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH,
        FIXTURE_STATE: state, RELEASE_TAG: 'v1.2.3', GH_REPO: 'o8-run/o8' },
    });
    expect(run().status).toBe(1);
    expect(JSON.parse(readFileSync(state, 'utf8')).assets).toEqual([]);
    const rerun = run();
    expect(rerun.status, rerun.stderr).toBe(0);
    const assets = JSON.parse(readFileSync(state, 'utf8')).assets;
    expect(assets.map((asset: { name: string }) => asset.name)).toEqual([name, name + '.sig']);
    expect(run().status).toBe(1);
    expect(JSON.parse(readFileSync(state, 'utf8')).assets).toEqual(assets);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
