import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
const source = join(process.cwd(), 'tests/fixtures/build-channel');
function fixture(options: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'o8-promote-test-'));
  const home = mkdtempSync(join(tmpdir(), 'o8-promote-home-'));
  roots.push(root, home);
  const profile = join(home, '.o8-release-build-profiles', createHash('sha256').update(realpathSync(root)).digest('hex'));
  const offerReceipt = join(profile, 'update-publication/v0.1.900.json');
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ plugins: { updater: {
    pubkey: readFileSync(join(source, 'public-key.txt'), 'utf8'), endpoints: [
      'https://fixture.invalid/primary/{{current_version}}', 'https://fixture.invalid/fallback/{{current_version}}',
    ],
  } } }));
  writeFileSync(join(root, 'package.json'), '{"version":"0.1.999"}');
  const assets = join(root, 'assets');
  mkdirSync(assets);
  copyFileSync(join(source, 'beta.tar.gz'), join(assets, 'o8.app.tar.gz'));
  copyFileSync(join(source, 'beta.tar.gz.sig'), join(assets, 'o8.app.tar.gz.sig'));
  const candidate = { version: '0.1.900', channel: 'beta', pub_date: '2026-10-01T00:00:00Z', platforms: {
    'darwin-aarch64': { url: 'https://github.com/hurttlocker/o8-releases/releases/download/v0.1.900/o8.app.tar.gz',
      signature: readFileSync(join(assets, 'o8.app.tar.gz.sig'), 'utf8').trim() },
  } };
  writeFileSync(join(assets, 'beta.json'), JSON.stringify(candidate));
  writeFileSync(join(assets, 'o8_0.1.900_universal.dmg'), 'fixture dmg');
  writeFileSync(join(root, 'options.json'), JSON.stringify(options));
  const log = join(root, 'effects.jsonl');
  const prelude = `import fs from 'node:fs'; import {join,basename} from 'node:path';
const root=${JSON.stringify(root)}, assets=join(root,'assets');
const opt=JSON.parse(fs.readFileSync(join(root,'options.json'),'utf8'));
const record=(name,args=[])=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({name,args})+'\\n');`;
  const child = `${prelude}
const real=process.getBuiltinModule('node:child_process');
export function execFileSync(command,args=[],options={}) {
 if(command==='tar')return real.execFileSync(command,args,options);
 if(command==='xcrun' && args.join(' ')==='stapler validate '+args.at(-1)){record('stapler',args);if(opt.badStaple)throw Error('invalid staple');return '';}
 if(command==='gh'&&args[0]==='release'){
  const action=args[1],tag=args[2],repo=args[args.indexOf('--repo')+1];
  if(action==='view'){
   if(args.includes('--jq'))return '2026-10-01T00:00:00Z';
   const stable=tag===undefined||tag==='--repo';
   return JSON.stringify({tagName:stable?'v'+(opt.stableVersion||'0.1.899'):tag,isDraft:false,isPrerelease:!stable,
    publishedAt:'2026-10-01T00:00:00Z',assets:fs.readdirSync(assets).map(name=>({name}))});
  }
  if(action==='download'){
   const dir=args[args.indexOf('--dir')+1],pattern=args.includes('--pattern')?args[args.indexOf('--pattern')+1]:null;
   fs.mkdirSync(dir,{recursive:true});
   if(tag==='beta'){fs.writeFileSync(join(dir,'beta.json'),JSON.stringify({channel:'beta',version:opt.betaVersion||'0.1.901'}));return '';}
   if(pattern==='latest.json'){
    const beta=JSON.parse(fs.readFileSync(join(assets,'beta.json'),'utf8'));
    fs.writeFileSync(join(dir,'latest.json'),JSON.stringify({...beta,channel:'stable',version:opt.stableVersion||'0.1.899'}));return '';
   }
   for(const name of pattern?[pattern]:fs.readdirSync(assets))fs.copyFileSync(join(assets,name),join(dir,name));
   if(opt.mismatch&&repo==='hurttlocker/o8-releases')fs.appendFileSync(join(dir,'o8.app.tar.gz'),'different');
   return '';
  }
  if(['upload','edit'].includes(action)){
   record(action,args);
   if(opt.failUpload&&action==='upload')throw Error('fixture interruption');
   if(action==='upload')for(const file of args.slice(3).filter(v=>v.endsWith('.json')))record(basename(file),JSON.parse(fs.readFileSync(file,'utf8')));
   return '';
  }
 }
 if(command==='git')return args[0]==='log'?'a'.repeat(40)+'\\tfeat: a useful change':'';
 if(command==='bash'){record('changelog',args);record('changelogSource',options.env?.O8_CHANGELOG_SOURCE_REF);return '';}
 throw Error('Unexpected command: '+command+' '+args.join(' '));
}
export function spawnSync(){throw Error('Tests cannot sign, notarize or build');}
`;
  const modules: Record<string, string> = {
    'node:child_process': child,
    '/scripts/lib/macos-release-artifacts.mjs': `${prelude}
export function verifyMacosDmgMatchesApp(){record('dmgMatches');}
export function resolveMacosReleaseArtifacts(){}; export const MACOS_REQUIRED_BINARIES=[];`,
    '/scripts/sync-reports.mjs': `${prelude} export async function syncReports(){record('syncReports');return {fresh:[],status:'disabled'};}`,
    '/scripts/publish-fixed.mjs': `${prelude} export async function publishFixed(args){record('publishFixed',args);}`,
    '/scripts/lib/fixed-reports.mjs': `${prelude}
export const dataDir=()=>join(root,'data');
export const releaseRange=()=> 'v0.1.899..v0.1.900';
export function resolveNewFixes(range,version){record('resolveNewFixes',[range,version]);return {entries:[{id:'A7F3K2',version,title:'Resolved problem'}],missing:[]};}
export const readPublished=()=>[];
export const buildManifest=(fixed)=>({fixed});`,
    '/scripts/lib/release-summary.mjs': 'export const prepareReleaseSummary=()=>({status:"ready",summary:"A useful change"});export const formatReleaseSummary=()=>"A useful change";',
  };
  writeFileSync(join(root, 'loader.mjs'), `const modules=${JSON.stringify(modules)};
export async function load(url,context,next){const key=Object.keys(modules).find(key=>url===key||url.endsWith(key));return key?{format:'module',shortCircuit:true,source:modules[key]}:next(url,context);}`);
  writeFileSync(join(root, 'register.mjs'), `${prelude}
import{register}from'node:module';register(new URL('./loader.mjs',import.meta.url));
globalThis.fetch=async(url,options)=>{
 record('fetch',[String(url),options?.method||'GET']);
 if(options?.method==='POST')return {ok:true};
 const receipt=JSON.parse(fs.readFileSync(${JSON.stringify(offerReceipt)},'utf8'));
 record('offerProbe',{status:receipt.status,lockHeld:fs.existsSync(join(root,'publication.lock'))});
 return String(url).endsWith('/0.1.900')?{status:204,body:{cancel:async()=>{}}}:{status:200,json:async()=>({version:'0.1.900'})};
};`);
  return { root, home, offerReceipt, assets, log };
}
function run(f: ReturnType<typeof fixture>, args: string[] = []) {
  return spawnSync(process.execPath, ['--import', join(f.root, 'register.mjs'), join(process.cwd(), 'scripts/promote.mjs'), 'v0.1.900', ...args], {
    cwd: f.root, encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, HOME: f.home, NODE_ENV: 'test', O8_DATA_DIR: join(f.root, 'data'),
      O8_RELEASE_FEED_LOCK: join(f.root, 'publication.lock'), O8_RELEASES_WEBHOOK_URL: 'https://fixture.invalid/webhook' },
  });
}
function effects(f: ReturnType<typeof fixture>): Array<{name: string; args: unknown}> {
  return existsSync(f.log) ? readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) : [];
}
function writes(f: ReturnType<typeof fixture>) { return effects(f).filter(v=>['upload','edit','changelog','publishFixed','fetch'].includes(v.name)); }
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

it('case 1: rejects forged manifest-only signatures before any publication or receipt', ()=>{
  const f=fixture();
  const manifest=JSON.parse(readFileSync(join(f.assets,'beta.json'),'utf8'));
  manifest.platforms['darwin-aarch64'].signature='invalid signature';
  writeFileSync(join(f.assets,'beta.json'),JSON.stringify(manifest));
  const result=run(f);
  expect(result.status,result.stderr).toBe(1);
  expect(result.stderr).toMatch(/signature/);
  expect(writes(f)).toEqual([]);
  expect(existsSync(join(f.root,'data/release-verification/v0.1.900.json'))).toBe(false);
});
it.each(['offered', 'completed'])('case 2: retry of a %s version keeps its receipt and never probes 204 with the same current version', status=>{
  const f=fixture({stableVersion:'0.1.900'});
  mkdirSync(join(f.offerReceipt, '..'),{recursive:true});
  const offered=JSON.stringify({schema:'o8/update-publication-receipt/v1',version:'0.1.900',status});
  writeFileSync(f.offerReceipt,offered);
  const result=run(f);
  expect(readFileSync(f.offerReceipt,'utf8'),JSON.stringify(effects(f).filter(v=>v.name==='offerProbe'))).toBe(offered);
  expect(result.status,result.stderr).toBe(0);
  expect(effects(f).filter(v=>v.name==='fetch'&&JSON.stringify(v.args).includes('GET'))).toEqual([]);
  expect(existsSync(join(f.root,'publication.lock'))).toBe(false);
});
it('fresh promotion probes both updater endpoints as the previous stable and records an offered receipt', ()=>{
  const f=fixture();
  const started=Date.now();
  const result=run(f);
  expect(result.status,result.stderr).toBe(0);
  const gets=effects(f).filter(v=>v.name==='fetch'&&JSON.stringify(v.args).includes('GET'));
  expect(gets.map(v=>v.args)).toEqual([
    ['https://fixture.invalid/primary/0.1.899','GET'], ['https://fixture.invalid/primary/0.1.899','GET'],
    ['https://fixture.invalid/fallback/0.1.899','GET'], ['https://fixture.invalid/fallback/0.1.899','GET'],
  ]);
  expect(JSON.parse(readFileSync(f.offerReceipt,'utf8'))).toMatchObject({
    schema:'o8/update-publication-receipt/v1',version:'0.1.900',previousVersion:'0.1.899',status:'offered',attempts:1,
  });
  expect(effects(f).filter(v=>v.name==='offerProbe').map(v=>v.args)).toEqual(
    Array.from({length:4},()=>({status:'pending',lockHeld:true})));
  expect(existsSync(join(f.root,'publication.lock'))).toBe(false);
  // The beta was published on 2026-10-01; offer timing starts at this promotion.
  const offer=JSON.parse(readFileSync(f.offerReceipt,'utf8'));
  expect(offer.publishToOfferMs).toBeLessThan(60_000);
  expect(offer.withinPublishToOfferBudget).toBe(true);
  const { promotedAt }=JSON.parse(readFileSync(join(f.root,'data/release-verification/v0.1.900.json'),'utf8'));
  expect(Date.parse(promotedAt)).toBeGreaterThanOrEqual(started);
  expect(offer.publishedAt).toBe(promotedAt);
  // A retry after the offer evidence was lost probes again from the same promotion time.
  rmSync(f.offerReceipt);
  expect(run(f).status).toBe(0);
  expect(JSON.parse(readFileSync(f.offerReceipt,'utf8')).publishedAt).toBe(promotedAt);
});
it('case 3: completes stable manifests, report reconciliation, fixed receipts, changelog and announcements through shared release code', ()=>{
  const f=fixture({stableVersion:'0.1.900'});
  const result=run(f);
  expect(result.status,result.stderr).toBe(0);
  const calls=effects(f);
  expect(calls.map(v=>v.name)).toEqual(expect.arrayContaining(['syncReports','resolveNewFixes','fixed.json','latest.json','publishFixed','changelog','fetch']));
  const latest=calls.filter(v=>v.name==='latest.json');
  expect(latest).toHaveLength(2);
  for(const entry of latest)expect(entry.args).toMatchObject({channel:'stable',version:'0.1.900'});
  expect(calls.find(v=>v.name==='publishFixed')?.args).toMatchObject({version:'0.1.900',range:'v0.1.899..v0.1.900'});
  expect(calls.find(v=>v.name==='changelogSource')?.args).toBe('v0.1.900');
  const edits=calls.filter(v=>v.name==='edit');
  expect(edits).toHaveLength(2);
  for(const entry of edits)expect(entry.args).toEqual(expect.arrayContaining(['v0.1.900','--prerelease=false','--latest=true']));
  expect(JSON.stringify(writes(f))).not.toMatch(/"beta"|beta.json/);
});
it.each([{mismatch:true},{badStaple:true},{betaVersion:'0.1.899'},{stableVersion:'0.1.901'}])('refuses %j before mutations and releases its lock', options=>{
  const f=fixture(options);const result=run(f);
  expect(result.status,result.stderr).toBe(1);expect(writes(f)).toEqual([]);
  expect(existsSync(join(f.root,'publication.lock'))).toBe(false);
});
it('dry-run verifies signatures and identity, writes a hash-bound receipt and only prints planned effects', ()=>{
  const f=fixture();const result=run(f,['--dry-run']);
  expect(result.status,result.stderr).toBe(0);expect(writes(f)).toEqual([]);
  expect(existsSync(f.offerReceipt)).toBe(false);
  expect(result.stdout).toMatch(/verified/);expect(result.stdout).toMatch(/fixed.json/);
  const receipt=JSON.parse(readFileSync(join(f.root,'data/release-verification/v0.1.900.json'),'utf8'));
  expect(receipt).toMatchObject({version:'0.1.900',channel:'beta',status:'verified',installedSmoke:null});
  expect(Object.keys(receipt.assets)).toHaveLength(4);
});
it('a failed upload releases the lock and a fresh retry completes', ()=>{
  const f=fixture({failUpload:true,stableVersion:'0.1.900'});expect(run(f).status).toBe(1);
  expect(existsSync(join(f.root,'publication.lock'))).toBe(false);
  writeFileSync(join(f.root,'options.json'),JSON.stringify({stableVersion:'0.1.900'}));
  const result=run(f);expect(result.status,result.stderr).toBe(0);
});

it('validates the archive bytes with the existing verifier, not just signature text', ()=>{
  const f=fixture();writeFileSync(join(f.assets,'o8.app.tar.gz'),'corrupted artifact');
  const result=run(f);expect(result.status,result.stderr).toBe(1);expect(result.stderr).toMatch(/signature does not verify/);expect(writes(f)).toEqual([]);
});
it('rejects a signed stable identity masquerading as a beta', ()=>{
  const f=fixture();copyFileSync(join(source,'stable.tar.gz'),join(f.assets,'o8.app.tar.gz'));
  copyFileSync(join(source,'stable.tar.gz.sig'),join(f.assets,'o8.app.tar.gz.sig'));
  const beta=JSON.parse(readFileSync(join(f.assets,'beta.json'),'utf8'));
  beta.platforms['darwin-aarch64'].signature=readFileSync(join(f.assets,'o8.app.tar.gz.sig'),'utf8').trim();
  writeFileSync(join(f.assets,'beta.json'),JSON.stringify(beta));
  const result=run(f);expect(result.status,result.stderr).toBe(1);expect(result.stderr).toMatch(/identity/);expect(writes(f)).toEqual([]);
});
it('a completed retry preserves checkpoints and never repeats stable announcements', ()=>{
  const f=fixture({stableVersion:'0.1.900'});let result=run(f);expect(result.status,result.stderr).toBe(0);
  const offer=readFileSync(f.offerReceipt,'utf8');
  result=run(f);expect(result.status,result.stderr).toBe(0);
  expect(readFileSync(f.offerReceipt,'utf8')).toBe(offer);
  expect(effects(f).filter(v=>v.name==='changelog')).toHaveLength(1);
  expect(effects(f).filter(v=>v.name==='publishFixed')).toHaveLength(1);
  expect(effects(f).filter(v=>v.name==='fetch'&&JSON.stringify(v.args).includes('POST'))).toHaveLength(1);
  expect(effects(f).filter(v=>v.name==='fetch'&&JSON.stringify(v.args).includes('GET'))).toHaveLength(4);
  expect(existsSync(join(f.root,'publication.lock'))).toBe(false);
});

it('authenticates the retained universal archive when both feed platforms use CPU archives', ()=>{
  const f=fixture();
  const beta=JSON.parse(readFileSync(join(f.assets,'beta.json'),'utf8'));
  for(const [arch,platform] of [['arm64','aarch64'],['x86_64','x86_64']]){
    const name=`o8_${arch}.app.tar.gz`;
    copyFileSync(join(source,'beta.tar.gz'),join(f.assets,name));
    copyFileSync(join(source,'beta.tar.gz.sig'),join(f.assets,name+'.sig'));
    writeFileSync(join(f.assets,`o8_0.1.900_${arch}.dmg`),'fixture cpu dmg');
    beta.platforms['darwin-'+platform]={...beta.platforms['darwin-aarch64'],url:`https://github.com/hurttlocker/o8-releases/releases/download/v0.1.900/${name}`};
  }
  writeFileSync(join(f.assets,'beta.json'),JSON.stringify(beta));
  let result=run(f,['--dry-run']);expect(result.status,result.stderr).toBe(0);
  expect(effects(f).filter(v=>v.name==='dmgMatches')).toHaveLength(6);
  [beta.platforms['darwin-aarch64'],beta.platforms['darwin-x86_64']]=[beta.platforms['darwin-x86_64'],beta.platforms['darwin-aarch64']];
  writeFileSync(join(f.assets,'beta.json'),JSON.stringify(beta));
  result=run(f,['--dry-run']);expect(result.status,result.stderr).toBe(1);
  expect(result.stderr).toMatch(/architecture/);
  [beta.platforms['darwin-aarch64'],beta.platforms['darwin-x86_64']]=[beta.platforms['darwin-x86_64'],beta.platforms['darwin-aarch64']];
  writeFileSync(join(f.assets,'beta.json'),JSON.stringify(beta));
  writeFileSync(join(f.assets,'o8.app.tar.gz'),'corrupt retained archive');
  result=run(f,['--dry-run']);expect(result.status,result.stderr).toBe(1);
  expect(result.stderr).toMatch(/signature does not verify/);expect(writes(f)).toEqual([]);
});
