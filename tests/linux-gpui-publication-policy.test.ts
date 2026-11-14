import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
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

type Asset = { id: number; name: string; label: string | null; size: number; state: string; digest?: string };
const imageName = 'o8-1.2.3-x86_64.AppImage';
const ownership = 'o8-linux-upload-00000000-0000-0000-0000-000000000001';
const otherOwnership = 'o8-linux-upload-00000000-0000-0000-0000-000000000002';
const digest = createHash('sha256').update('verified').digest('hex');
const uploadRoots: string[] = [];
afterEach(() => { for (const root of uploadRoots.splice(0)) rmSync(root, {recursive:true,force:true}); });
function asset(id: number, name: string, label: string | null = ownership): Asset {
  return {id,name,label,state:'uploaded',size:8};
}
function uploadFixture(assets: Asset[] = [], options: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'linux-upload-')); uploadRoots.push(root);
  mkdirSync(join(root,'publish')); mkdirSync(join(root,'bin'));
  for (const file of [imageName, imageName+'.sig']) writeFileSync(join(root,'publish',file),'verified');
  const stateFile = join(root,'state.json');
  writeFileSync(stateFile,JSON.stringify({assets,calls:[],...options}));
  const gh = join(root,'bin/gh');
  writeFileSync(gh, `#!${process.execPath}
    const fs=require('node:fs');
    const state=JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE));
    const args=process.argv.slice(2);
    state.calls.push(args);
    const save=()=>fs.writeFileSync(process.env.FIXTURE_STATE,JSON.stringify(state));
    save();
    if(args[0]==='api'&&args.length===2) {
      if(state.listFailures>0) {state.listFailures--;save();process.exit(1);}
      console.log(JSON.stringify({assets:state.assets}));
    } else if(args[1]==='upload') {
      let id=100;
      for(const arg of args.filter(arg=>arg.includes('#'))) {
        const [file,label]=arg.split('#');
        state.assets.push({id:++id,name:file.split('/').pop(),label,size:fs.statSync(file).size,state:state.uploadState||'uploaded'});save();
        if(state.partialFail) {state.partialFail=false;save();process.exit(1);}
      }
      if(state.bothFail)process.exit(1);
    } else if(args[0]==='api'&&args[2]==='DELETE') {
      const id=Number(args[3].split('/').pop());
      if(state.deleteFail===id)process.exit(1);
      state.assets=state.assets.filter(asset=>asset.id!==id);save();
    } else if(args[0]==='api'&&args[2]==='PATCH') {
      const id=Number(args[3].split('/').pop());
      if(state.patchFail===id)process.exit(1);
      if(!args.includes('label='))process.exit(8);
      state.assets.find(asset=>asset.id===id).label='';save();
    } else process.exit(9);
  `, {mode:0o755});
  const read = () => JSON.parse(readFileSync(stateFile,'utf8')) as {assets:Asset[];calls:string[][]} & Record<string,unknown>;
  return {root,read,write:(state:unknown)=>writeFileSync(stateFile,JSON.stringify(state)),
    run:()=>spawnSync(process.execPath,[resolve('scripts/upload-linux-release-assets.mjs')],{
      cwd:root,encoding:'utf8',env:{...process.env,PATH:join(root,'bin')+':'+process.env.PATH,
        APPIMAGE_SHA256:digest,SIGNATURE_SHA256:digest,FIXTURE_STATE:stateFile,RELEASE_TAG:'v1.2.3',GH_REPO:'o8-run/o8'},
    }),
    deletes:()=>read().calls.filter(args=>args.includes('DELETE')),
  };
}

it.each([
  ['completed signature replacement', [asset(1,imageName),asset(2,imageName+'.sig','')]],
  ['previous labelled success', [asset(1,imageName),asset(2,imageName+'.sig')]],
  ['mixed ownership', [asset(1,imageName),asset(2,imageName+'.sig',otherOwnership)]],
  ['settled pair with a different size', [{...asset(1,imageName),size:1},asset(2,imageName+'.sig')]],
  ['settled pair with a different digest', [{...asset(1,imageName),digest:'sha256:'+'0'.repeat(64)},asset(2,imageName+'.sig')]],
  ['unlabelled lone file', [asset(1,imageName,null)]],
] as const)('refuses %s before any deletion', (_case, assets) => {
  const f=uploadFixture([...assets]); const result=f.run();
  expect(result.status,result.stderr).toBe(1);
  expect(f.deletes()).toEqual([]);
  expect(f.read().assets).toEqual(assets);
});

it('recovers a labelled lone AppImage and clears both successful upload labels', () => {
  const f=uploadFixture([asset(1,imageName)]); const result=f.run();
  expect(result.status,result.stderr).toBe(0);
  expect(f.deletes()).toHaveLength(1);
  expect(f.read().assets.map(a=>({name:a.name,label:a.label,state:a.state}))).toEqual([
    {name:imageName,label:'',state:'uploaded'}, {name:imageName+'.sig',label:'',state:'uploaded'},
  ]);
});

it.each(['starter','new'])('recovers a unanimous pair with an unfinished upload: %s', state => {
  const image=asset(1,imageName);
  image.state=state;
  const f=uploadFixture([image,asset(2,imageName+'.sig')]); const result=f.run();
  expect(result.status,result.stderr).toBe(0);
  expect(f.deletes()).toHaveLength(2);
  expect(f.read().assets.every(a=>a.label==='')).toBe(true);
});

it('reports label clearing failure without deleting either completed asset', () => {
  const f=uploadFixture([], {patchFail:101}); const result=f.run();
  expect(result.status,result.stderr).toBe(1);
  expect(result.stderr).toMatch(/label/i);
  expect(f.deletes()).toEqual([]);
  expect(f.read().calls.filter(args=>args.includes('PATCH'))).toHaveLength(2);
  expect(f.read().assets).toHaveLength(2);
  expect(f.run().status).toBe(1);
  expect(f.deletes()).toEqual([]);
});

it('rejects a still-uploading new pair and rolls back only owned assets', () => {
  const f=uploadFixture([], {uploadState:'starter'}); const result=f.run();
  expect(result.status,result.stderr).toBe(1);
  expect(f.deletes()).toHaveLength(2);
  expect(f.read().assets).toEqual([]);
});

it('attempts every cleanup deletion and recovers the leftover on rerun', () => {
  const f=uploadFixture([], {bothFail:true,deleteFail:101});
  expect(f.run().status).toBe(1);
  expect(f.deletes()).toHaveLength(2);
  const state=f.read(); expect(state.assets).toHaveLength(1);
  state.bothFail=false; state.deleteFail=undefined; f.write(state);
  const result=f.run(); expect(result.status,result.stderr).toBe(0);
  expect(f.read().assets.every(a=>a.label==='')).toBe(true);
  expect(f.run().status).toBe(1);
});

it('checks digests before any release API operation', () => {
  const f=uploadFixture(); writeFileSync(join(f.root,'publish',imageName),'tampered');
  expect(f.run().stderr).toContain('digest mismatch'); expect(f.read().calls).toEqual([]);
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
