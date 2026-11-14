import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  expect(workflow.jobs.attach.if).toBe("github.ref == 'refs/heads/main' && inputs.publish_linux == true");
});

it('isolates read-only verification from digest-bound attachment', () => {
  const { verify, attach } = workflow.jobs;
  expect(verify.permissions).toEqual({ contents: 'read', actions: 'read' });
  expect(attach.permissions).toEqual({ contents: 'write' });
  expect(attach.needs).toBe('verify');
  expect(attach['timeout-minutes']).toBeGreaterThanOrEqual(45);
  expect(verify.steps.map((s: {run?: string}) => s.run ?? '').join('\n')).toContain('--no-execute');
  const upload = attach.steps.filter((s: {env?: {GH_TOKEN?: string}}) => s.env?.GH_TOKEN);
  expect(upload).toHaveLength(1);
  expect(upload[0].run).toBe('node scripts/upload-linux-release-assets.mjs');
  expect(upload[0].env.APPIMAGE_SHA256).toBe('${{ needs.verify.outputs.appimage_sha256 }}');
  expect(upload[0].env.SIGNATURE_SHA256).toBe('${{ needs.verify.outputs.signature_sha256 }}');
  for (const job of [verify, attach]) for (const step of job.steps) {
    if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  }
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
        if(state.bothFail) { for(const arg of args.filter(arg=>arg.includes('#'))) { const [file,label]=arg.split('#'); state.assets.push({id:state.assets.length+1,name:file.split('/').pop(),label,size:fs.statSync(file).size}); } save(); process.exit(1); }
        for (const arg of args.filter(arg => arg.includes('#'))) {
          const [file, label] = arg.split('#');
          state.assets.push({id: state.assets.length + 1, name: file.split('/').pop(), label, size: fs.statSync(file).size});
          save();
          if (state.fail) { state.fail = false; save(); process.exit(1); }
        }
      } else if (args[0] === 'api' && args[2] === 'DELETE') {
        const id=Number(args[3].split('/').pop()); state.deletes=(state.deletes||[]).concat(id); save(); if(state.deleteFail===id)process.exit(1); state.assets = state.assets.filter(asset => asset.id !== id); save();
      } else process.exit(9);
    `);
    chmodSync(gh, 0o755);
    const run = () => spawnSync(process.execPath, [resolve('scripts/upload-linux-release-assets.mjs')], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH,
        APPIMAGE_SHA256: createHash('sha256').update('verified').digest('hex'), SIGNATURE_SHA256: createHash('sha256').update('verified').digest('hex'), FIXTURE_STATE: state, RELEASE_TAG: 'v1.2.3', GH_REPO: 'o8-run/o8' },
    });
    // Digests are checked before even inventorying the destination.
    writeFileSync(join(root, 'publish', name), 'tampered');
    expect(run().stderr).toContain('digest mismatch');
    writeFileSync(join(root, 'publish', name), 'verified');
    writeFileSync(state, JSON.stringify({assets:[],bothFail:true,deleteFail:1}));
    expect(run().status).toBe(1);
    const partial = JSON.parse(readFileSync(state,'utf8'));
    expect(partial.deletes).toEqual([1,2]);
    expect(partial.assets).toHaveLength(1);
    partial.bothFail=false; partial.deleteFail=undefined; partial.fail=false;
    writeFileSync(state,JSON.stringify(partial));
    const rerun = run();
    expect(rerun.status, rerun.stderr).toBe(0);
    const assets = JSON.parse(readFileSync(state, 'utf8')).assets;
    expect(assets.map((asset: { name: string }) => asset.name)).toEqual([name, name + '.sig']);
    expect(run().status).toBe(1);
    expect(JSON.parse(readFileSync(state, 'utf8')).assets).toEqual(assets);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('the explicit publish scanner path never spawns the AppImage runtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'linux-scan-'));
  try {
    const image = join(root, 'marker.AppImage');
    copyFileSync(resolve('tests/fixtures/linux-build-channel/beta.AppImage'), image);
    const marker = join(root, 'executed');
    writeFileSync(join(root, 'loader.mjs'), `export async function load(url,ctx,next) {
      if(url!=='node:child_process')return next(url,ctx);
      return {format:'module',shortCircuit:true,source:\`
        import {mkdirSync,writeFileSync} from 'node:fs';
        import {join} from 'node:path';
        export function execFileSync(){throw Error('unexpected execFileSync');}
        export function spawnSync(command,args){
          if(command==='unsquashfs') {
            if(args[args.indexOf('-o')+1]!=='256')throw Error('wrong offset');
            const dest=args[args.indexOf('-d')+1]; mkdirSync(dest);
            writeFileSync(join(dest,'binary'),Buffer.from([127,69,76,70]));
            return {status:0,stdout:''};
          }
          if(command==='objdump')return {status:0,stdout:'GLIBC_2.35'};
          writeFileSync(${JSON.stringify(marker)},'executed');
          return {status:1,stderr:'runtime executed'};
        }
      \`};
    }`);
    writeFileSync(join(root, 'register.mjs'), "import{register}from'node:module';register(new URL('./loader.mjs',import.meta.url));");
    const result = spawnSync(process.execPath, ['--import', join(root, 'register.mjs'), resolve('scripts/ci/check-linux-glibc.mjs'), '--no-execute', image], {encoding:'utf8'});
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('1 ELF files, highest GLIBC_2.35');
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(root, {recursive:true,force:true}); }
});
