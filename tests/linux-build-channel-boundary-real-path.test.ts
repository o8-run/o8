import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const source = join(process.cwd(), 'tests/fixtures/linux-build-channel');
const entry = join(process.cwd(), 'scripts/sign-linux-appimage.mjs');
const helper = pathToFileURL(join(process.cwd(), 'scripts/lib/linux-build-channel.mjs')).href;
const version = '0.1.900';
const tag = `v${version}`;
const asset = `o8_${version}_linux_amd64_preview.AppImage`;
const repos = ['fixture/source', 'fixture/mirror'];
type Channel = 'stable' | 'beta' | 'preview';

function manifest(repo: string, channel: Channel, value = version) {
  return {
    version: value, channel, notes: `${repo} notes`, pub_date: '2026-09-01T00:00:00Z', custom: { repo },
    platforms: {
      'darwin-x86_64': { signature: `${repo}-intel`, url: `https://github.com/${repo}/releases/download/${tag}/o8_x86_64.app.tar.gz` },
      'darwin-aarch64': { signature: `${repo}-arm`, url: `https://github.com/${repo}/releases/download/${tag}/o8_arm64.app.tar.gz` },
      'windows-x86_64': { signature: `${repo}-windows`, url: `${repo}/windows.zip` },
    },
  };
}

function fixture(channel: Channel | 'invalid-elf' | 'invalid-squashfs' | 'invalid-schema' | 'wrong-version' = 'beta', manifestChannel: Channel = 'beta', rollingVersion = version) {
  const root = mkdtempSync(join(tmpdir(), 'o8-linux-channel-')); roots.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  mkdirSync(join(root, 'src-tauri'));
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ plugins: { updater: { pubkey: readFileSync(join(source, 'public-key.txt'), 'utf8') } } }));
  const artifact = join(root, asset);
  copyFileSync(join(source, `${channel}.AppImage`), artifact);
  copyFileSync(join(source, `${channel}.AppImage.sig`), `${artifact}.sig`);
  const state: Record<string, unknown> = {};
  for (const repo of repos) {
    for (const name of ['latest.json', 'beta.json', 'preview.json']) state[`${repo}/${tag}/${name}`] = manifest(repo, manifestChannel);
    state[`${repo}/beta/beta.json`] = manifest(repo, 'beta', rollingVersion);
  }
  writeFileSync(join(root, 'state.json'), JSON.stringify(state));
  const provider = `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path');
const root=process.env.O8_LINUX_FIXTURE_ROOT,args=process.argv.slice(2),name=p.basename(process.argv[1]);
const state=JSON.parse(fs.readFileSync(p.join(root,'state.json'),'utf8'));
const value=flag=>args[args.indexOf(flag)+1];
const record=event=>fs.appendFileSync(p.join(root,'effects.jsonl'),JSON.stringify({name,args,...event})+'\\n');
if(name==='cargo'){
 if(JSON.stringify(args.slice(0,3))!==JSON.stringify(['tauri','signer','sign']))throw Error('unexpected signer invocation');
 if(!fs.statSync(p.join(root,'publication.lock')).isFile())throw Error('signer must hold publication lock');
 record({});fs.copyFileSync(p.join(root,${JSON.stringify(asset + '.sig')}),args[3]+'.sig');process.exit(0);
}
if(name==='unsquashfs'){
 record({});if(args[0]!=='-cat'||args[1]!=='-o'||args[2]!=='256'||args[4]!=='usr/lib/o8/server/o8-build-channel.json')throw Error('unsafe extraction arguments');
 process.stdout.write(fs.readFileSync(args[3]).subarray(352));process.exit(0);
}
if(name!=='gh')throw Error('unexpected provider');
if(args[0]!=='release')throw Error('unexpected gh operation');
if(args[1]==='view'){
 record({});if(args[2]==='beta'&&process.env.O8_LINUX_MISSING_ANCHOR==='1')process.exit(1);
 process.stdout.write(JSON.stringify({isDraft:false,assets:[{name:${JSON.stringify(asset)}}]}));process.exit(0);
}
if(args[1]==='download'){
 record({});const file=value('--pattern'),dest=p.join(value('--dir'),file);fs.mkdirSync(p.dirname(dest),{recursive:true});
 if(file.endsWith('.AppImage'))fs.copyFileSync(p.join(root,${JSON.stringify(asset)}),dest);
 else{const data=state[value('--repo')+'/'+args[2]+'/'+file];if(!data)process.exit(1);fs.writeFileSync(dest,JSON.stringify(data));}
 process.exit(0);
}
if(args[1]==='upload'){
 const files=args.slice(3,args.indexOf('--clobber'));const manifests=files.filter(file=>file.endsWith('.json')).map(file=>({file:p.basename(file),data:JSON.parse(fs.readFileSync(file,'utf8'))}));
 record({manifests});for(const item of manifests)state[value('--repo')+'/'+args[2]+'/'+item.file]=item.data;
 fs.writeFileSync(p.join(root,'state.json'),JSON.stringify(state));process.exit(0);
}
throw Error('Tests forbid release creation, edits, or unexpected gh operations');
`;
  for (const name of ['gh', 'cargo', 'unsquashfs']) writeFileSync(join(bin, name), provider, { mode: 0o755 });
  // Keep the real CLI and real subprocess boundary on every host, including
  // Windows where a shebang executable cannot be launched directly.
  writeFileSync(join(root, 'loader.mjs'), `export async function load(url,context,next){
    if(url!=='node:child_process')return next(url,context);
    return {format:'module',shortCircuit:true,source:${JSON.stringify(`
      const real=process.getBuiltinModule('node:child_process'),p=process.getBuiltinModule('node:path');
      export function execFileSync(command,args,options){
        if(!['gh','cargo','unsquashfs'].includes(command))throw Error('Unexpected executable in publication fixture: '+command);
        return real.execFileSync(process.execPath,[p.join(${JSON.stringify(bin)},command),...args],options);
      }
    `)}};
  }`);
  writeFileSync(join(root, 'register.mjs'), "import{register}from'node:module';register(new URL('./loader.mjs',import.meta.url));");
  return { root, bin, artifact };
}

function run(f: ReturnType<typeof fixture>, env: Record<string, string> = {}, code?: string) {
  return spawnSync(process.execPath, ['--import', join(f.root, 'register.mjs'), ...(code ? ['--input-type=module', '-e', code] : [entry, '--tag', tag, ...repos.flatMap(repo => ['--repo', repo])])], {
    cwd: f.root, encoding: 'utf8', timeout: 20000,
    env: { PATH: `${f.bin}${delimiter}${process.env.PATH}`, SystemRoot: process.env.SystemRoot, HOME: f.root, NODE_ENV: 'test', TAURI_SIGNING_PRIVATE_KEY: 'public-fixture-only-not-a-key', O8_LINUX_FIXTURE_ROOT: f.root, O8_RELEASE_FEED_LOCK: join(f.root, 'publication.lock'), ...env },
  });
}
function effects(f: ReturnType<typeof fixture>) {
  const log = join(f.root, 'effects.jsonl');
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
function uploads(f: ReturnType<typeof fixture>) { return effects(f).filter(event => event.name === 'gh' && event.args[1] === 'upload'); }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('signed Linux build channel through the operator CLI', () => {
  it.each([['beta', 'stable'], ['stable', 'beta']] as const)('refuses a %s AppImage against a %s manifest before upload', (channel, feed) => {
    const f = fixture(channel, feed); const result = run(f);
    expect(result.status, result.stderr).toBe(1); expect(result.stderr).toMatch(/channel|identity/i); expect(uploads(f)).toEqual([]);
  });

  it('preflights mirror channel and version before uploading any repository manifest', () => {
    const f = fixture(); const path = join(f.root, 'state.json'); const state = JSON.parse(readFileSync(path, 'utf8'));
    state[`${repos[1]}/${tag}/beta.json`].channel = 'stable'; writeFileSync(path, JSON.stringify(state));
    const result = run(f); expect(result.status).toBe(1); expect(result.stderr).toMatch(/channel/i); expect(uploads(f)).toEqual([]);
  });

  it.each([undefined, '0.1.899'])('requires explicit manifest channel and exact version (%s)', value => {
    const f = fixture('stable', 'stable'); const path = join(f.root, 'state.json'); const state = JSON.parse(readFileSync(path, 'utf8'));
    const current = state[`${repos[0]}/${tag}/latest.json`];
    if (value === undefined) delete current.channel; else current.version = value;
    writeFileSync(path, JSON.stringify(state)); const result = run(f);
    expect(result.status).toBe(1); expect(result.stderr).toMatch(/channel|version/i); expect(uploads(f)).toEqual([]);
  });

  it('completes beta on each repository and the matching independent anchor, preserving all other metadata', () => {
    const f = fixture(); const result = run(f);
    expect(result.status, result.stderr).toBe(0);
    const writes = uploads(f); expect(writes).toHaveLength(4);
    expect(writes.map(event => event.args[2])).toEqual([tag, tag, 'beta', 'beta']);
    for (const event of writes) {
      expect(event.manifests).toHaveLength(1); const item = event.manifests[0]; expect(item.file).toBe('beta.json');
      const repo = event.args[event.args.indexOf('--repo') + 1]; const original = manifest(repo, 'beta');
      expect(item.data).toEqual({ ...original, platforms: { ...original.platforms, 'linux-x86_64': {
        signature: readFileSync(join(source, 'beta.AppImage.sig'), 'utf8').trim(),
        url: `https://github.com/${repo}/releases/download/${tag}/${asset}`,
      } } });
    }
    expect(effects(f).filter(event => event.name === 'unsquashfs')).toHaveLength(1);
    expect(existsSync(join(f.root, 'publication.lock'))).toBe(false);
  });

  it.each(['0.1.901', '0.1.899'])('cannot move an independent beta anchor on version %s', rollingVersion => {
    const f = fixture('beta', 'beta', rollingVersion); const result = run(f);
    expect(result.status, result.stderr).toBe(0); expect(uploads(f)).toHaveLength(2);
    expect(uploads(f).every(event => event.args[2] === tag)).toBe(true);
  });

  it('cannot relabel beta through an environment channel override', () => {
    const f = fixture(); const result = run(f, { O8_RELEASE_CHANNEL: 'stable' });
    expect(result.status, result.stderr).toBe(0); expect(uploads(f).every(event => event.manifests.every((item: { file: string }) => item.file === 'beta.json'))).toBe(true);
  });

  it('refuses tampering before extraction or any upload and releases the lock', () => {
    const f = fixture(); writeFileSync(f.artifact, Buffer.concat([readFileSync(f.artifact), Buffer.from('tampered')]));
    const result = run(f); expect(result.status).toBe(1); expect(result.stderr).toMatch(/signature/i);
    expect(effects(f).some(event => event.name === 'unsquashfs')).toBe(false); expect(uploads(f)).toEqual([]);
    expect(existsSync(join(f.root, 'publication.lock'))).toBe(false);
  });

  it('refuses an invalid signature before extraction or upload', () => {
    const f = fixture(); const path = f.artifact + '.sig'; const standard = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64').toString('utf8').trim().split('\n');
    const packet = Buffer.from(standard[1], 'base64'); packet[10] ^= 1; standard[1] = packet.toString('base64');
    writeFileSync(path, Buffer.from(standard.join('\n')).toString('base64'));
    const result = run(f); expect(result.status).toBe(1); expect(result.stderr).toMatch(/signature/i);
    expect(effects(f).some(event => event.name === 'unsquashfs')).toBe(false); expect(uploads(f)).toEqual([]);
  });

  it.each(['invalid-elf', 'invalid-squashfs', 'invalid-schema', 'wrong-version'] as const)('refuses a signed %s artifact', channel => {
    const f = fixture(channel); const result = run(f); expect(result.status).toBe(1); expect(uploads(f)).toEqual([]);
    expect(result.stderr).toMatch(/ELF|Squashfs|channel|identity|version/i);
  });

  it('uses preview.json only for an artifact built as preview', () => {
    const f = fixture('preview', 'preview'); const result = run(f);
    expect(result.status, result.stderr).toBe(0); expect(uploads(f)).toHaveLength(2);
    expect(uploads(f).every(event => event.manifests[0].file === 'preview.json')).toBe(true);
  });

  it('retains stable latest.json completion for signed stable builds', () => {
    const f = fixture('stable', 'stable'); const result = run(f);
    expect(result.status, result.stderr).toBe(0); expect(uploads(f)).toHaveLength(2);
    expect(uploads(f).every(event => event.manifests[0].file === 'latest.json')).toBe(true);
  });

  it('requires an operator-provisioned beta anchor without creating or moving tags', () => {
    const f = fixture(); const result = run(f, { O8_LINUX_MISSING_ANCHOR: '1' });
    expect(result.status).toBe(1); expect(result.stderr).toMatch(/anchor|provision/i);
    expect(effects(f).some(event => event.name === 'gh' && ['create', 'edit'].includes(event.args[1]))).toBe(false);
  });

  it('rejects a second publisher while the shared publication lock is owned', () => {
    const f = fixture(); mkdirSync(join(f.root, 'publication.lock'));
    const result = run(f); expect(result.status).toBe(1); expect(effects(f)).toEqual([]);
  });

  it('guards every uploaded AppImage against the requested channel', () => {
    const f = fixture(); const stable = join(f.root, 'stable.AppImage');
    copyFileSync(join(source, 'stable.AppImage'), stable); copyFileSync(join(source, 'stable.AppImage.sig'), stable + '.sig');
    const code = `import {assertLinuxArtifactChannels} from ${JSON.stringify(helper)}; assertLinuxArtifactChannels(process.cwd(),${JSON.stringify(version)},'beta',${JSON.stringify([f.artifact, f.artifact + '.sig', stable, stable + '.sig'])});`;
    const result = run(f, {}, code); expect(result.status).toBe(1); expect(result.stderr).toMatch(/channel|identity/i);
    expect(effects(f).filter(event => event.name === 'unsquashfs')).toHaveLength(2);
  });
});
