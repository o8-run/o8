import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { publishedLinuxAssetName } from '../scripts/lib/release-manifest.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-beta-linux-'));
  roots.push(root);
  mkdirSync(join(root, 'bin'));
  const version = '0.1.900', tag = `v${version}`, asset = publishedLinuxAssetName(version);
  const manifest = { channel: 'beta', version, platforms: {
    'darwin-x86_64': { url: `https://github.com/o8-run/o8/releases/download/${tag}/o8.app.tar.gz`, signature: 'darwin-fixture' },
  } };
  for (const release of [tag, 'v0.1.800']) mkdirSync(join(root, release));
  writeFileSync(join(root, tag, 'beta.json'), JSON.stringify(manifest));
  const stable = JSON.stringify({ version: '0.1.800', platforms: {} });
  writeFileSync(join(root, 'v0.1.800/latest.json'), stable);
  writeFileSync(join(root, 'v0.1.800/beta.json'), JSON.stringify(manifest));
  writeFileSync(join(root, tag, asset), 'fixture artifact bytes');
  const gh = join(root, 'bin/gh');
  writeFileSync(gh, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2),root=process.env.O8_LINUX_FIXTURE;
fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify(a)+'\\n');
if(a[1]==='view')process.stdout.write(a.includes('--jq')?'v0.1.800':JSON.stringify({isDraft:false,assets:fs.readdirSync(path.join(root,a[2])).map(name=>({name})).concat(a[2]==='v0.1.800'?[{name:'beta.json'}]:[])}));
if(a[1]==='download'){const name=a[a.indexOf('--pattern')+1];fs.copyFileSync(path.join(root,a[2],name),path.join(a[a.indexOf('--dir')+1],name));if(name==='beta.json'&&process.env.O8_LINUX_PAUSE){fs.writeFileSync(path.join(root,'paused'),'');const start=Date.now();while(!fs.existsSync(path.join(root,'resume'))&&Date.now()-start<8000)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
if(a[1]==='upload')for(const file of a.slice(3)){if(file.startsWith('--'))break;fs.copyFileSync(file,path.join(root,a[2],path.basename(file)));}
`);
  const cargo = join(root, 'bin/cargo');
  writeFileSync(cargo, `#!${process.execPath}
const fs=require('node:fs');fs.writeFileSync(process.env.O8_LINUX_FIXTURE+'/signed','');fs.writeFileSync(process.argv.at(-1)+'.sig','linux-fixture');
`);
  for (const executable of [gh, cargo]) chmodSync(executable, 0o700);
  return { root, tag, manifest, stable };
}
function run(f: ReturnType<typeof fixture>, extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [join(process.cwd(), 'scripts/sign-linux-appimage.mjs'), '--tag', f.tag, '--repo', 'o8-run/o8'], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, CI: '', TAURI_SIGNING_PRIVATE_KEY: 'fixture', PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, O8_LINUX_FIXTURE: f.root, O8_UPDATE_FEED_LOCK_PATH: join(f.root, 'feeds.lock'), ...extra },
  });
}
it('completes the beta Linux manifest through ship:linux-sig without changing rolling stable', () => {
  const f = fixture();
  const { root, tag, manifest, stable } = f;
  const result = run(f);
  expect(result.status, result.stderr).toBe(0);
  const beta = JSON.parse(readFileSync(join(root, tag, 'beta.json'), 'utf8'));
  expect(beta.platforms['linux-x86_64']).toMatchObject({ signature: 'linux-fixture' });
  expect(beta.platforms['darwin-x86_64']).toEqual(manifest.platforms['darwin-x86_64']);
  expect(existsSync(join(root, tag, 'latest.json'))).toBe(false);
  expect(JSON.parse(readFileSync(join(root, 'v0.1.800/beta.json'), 'utf8'))).toEqual(beta);
  expect(readFileSync(join(root, 'v0.1.800/latest.json'), 'utf8')).toBe(stable);
});

it.each(['0.1.902', '0.1.899'])('completes the candidate without moving rolling beta %s', version => {
  const f = fixture();
  const rolling = JSON.stringify(JSON.parse(JSON.stringify(f.manifest).replaceAll('0.1.900', version)));
  const stable = JSON.stringify({ version: '0.1.901', platforms: {} });
  writeFileSync(join(f.root, 'v0.1.800/beta.json'), rolling);
  writeFileSync(join(f.root, 'v0.1.800/latest.json'), stable);
  const result = run(f);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(f.root, 'v0.1.800/beta.json'), 'utf8')).toBe(rolling);
  expect(readFileSync(join(f.root, 'v0.1.800/latest.json'), 'utf8')).toBe(stable);
  expect(JSON.parse(readFileSync(join(f.root, f.tag, 'beta.json'), 'utf8')).platforms['linux-x86_64']).toBeDefined();
});
it('patches only Linux in the matching rolling beta, retaining other entries and metadata', () => {
  const f = fixture();
  const rolling = { ...f.manifest, notes: 'retained', platforms: { ...f.manifest.platforms,
    'darwin-aarch64': { url: new URL('o8_arm64.app.tar.gz', f.manifest.platforms['darwin-x86_64'].url).href, signature: 'retained' },
  } };
  writeFileSync(join(f.root, 'v0.1.800/beta.json'), JSON.stringify(rolling));
  expect(run(f).status).toBe(0);
  const result = JSON.parse(readFileSync(join(f.root, 'v0.1.800/beta.json'), 'utf8'));
  const { ['linux-x86_64']: linux, ...retained } = result.platforms;
  expect(linux.signature).toBe('linux-fixture');
  expect({ ...result, platforms: retained }).toEqual(rolling);
});
it('refuses a conflicting channel lock before signing or publication', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'feeds.lock'), 'held');
  const result = run(f);
  expect(result.status).toBe(1);
  expect(existsSync(join(f.root, 'signed'))).toBe(false);
  expect(readFileSync(join(f.root, 'feeds.lock'), 'utf8')).toBe('held');
});
it('serializes overlapping Linux completion commands', async () => {
  const f = fixture();
  const child = spawn(process.execPath, [join(process.cwd(), 'scripts/sign-linux-appimage.mjs'), '--tag', f.tag, '--repo', 'o8-run/o8'], {
    stdio: 'pipe', env: { ...process.env, CI: '', TAURI_SIGNING_PRIVATE_KEY: 'fixture', PATH: `${join(f.root, 'bin')}:${process.env.PATH}`,
      O8_LINUX_FIXTURE: f.root, O8_UPDATE_FEED_LOCK_PATH: join(f.root, 'feeds.lock'), O8_LINUX_PAUSE: '1' },
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const completed = new Promise<number | null>(resolve => child.on('close', resolve));
  try {
    const deadline = Date.now() + 8000;
    while (!existsSync(join(f.root, 'paused')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(join(f.root, 'paused')), errors).toBe(true);
    const overlap = spawnSync(process.execPath, [join(process.cwd(), 'scripts/sign-linux-appimage.mjs'), '--tag', f.tag, '--repo', 'o8-run/o8'], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, PATH: `${join(f.root, 'bin')}:${process.env.PATH}`,
        O8_LINUX_FIXTURE: f.root, O8_UPDATE_FEED_LOCK_PATH: join(f.root, 'feeds.lock') },
    });
    writeFileSync(join(f.root, 'resume'), '');
    expect(await completed, errors).toBe(0);
    expect(overlap.status, overlap.stderr).toBe(1);
    expect(readFileSync(join(f.root, 'v0.1.800/latest.json'), 'utf8')).toBe(f.stable);
  } finally { writeFileSync(join(f.root, 'resume'), ''); await completed; }
}, 20000);

it('patches only Linux in a matching stable tag and leaves beta unchanged', () => {
  const f = fixture();
  const stable = { version: '0.1.900', notes: 'retained stable metadata', platforms: f.manifest.platforms };
  const taggedBeta = JSON.stringify({ ...f.manifest, version: '0.1.902' });
  writeFileSync(join(f.root, f.tag, 'beta.json'), taggedBeta);
  writeFileSync(join(f.root, f.tag, 'latest.json'), JSON.stringify(stable));
  const beta = readFileSync(join(f.root, 'v0.1.800/beta.json'), 'utf8');
  const result = run(f);
  expect(result.status, result.stderr).toBe(0);
  const completed = JSON.parse(readFileSync(join(f.root, f.tag, 'latest.json'), 'utf8'));
  const { ['linux-x86_64']: linux, ...retained } = completed.platforms;
  expect(linux.signature).toBe('linux-fixture');
  expect({ ...completed, platforms: retained }).toEqual(stable);
  expect(readFileSync(join(f.root, f.tag, 'beta.json'), 'utf8')).toBe(taggedBeta);
  expect(readFileSync(join(f.root, 'v0.1.800/beta.json'), 'utf8')).toBe(beta);
});
it('refuses a tag manifest whose stable version has already advanced', () => {
  const f = fixture();
  const stable = JSON.stringify({ version: '0.1.901', platforms: f.manifest.platforms });
  rmSync(join(f.root, f.tag, 'beta.json'));
  writeFileSync(join(f.root, f.tag, 'latest.json'), stable);
  expect(run(f).status).toBe(1);
  expect(readFileSync(join(f.root, f.tag, 'latest.json'), 'utf8')).toBe(stable);
  expect(readFileSync(join(f.root, 'calls.jsonl'), 'utf8').split('\n').some(line => line && JSON.parse(line)[1] === 'upload')).toBe(false);
});
it('fails closed on a beta download error instead of creating a replacement feed', () => {
  const f = fixture();
  rmSync(join(f.root, 'v0.1.800/beta.json'));
  expect(run(f).status).toBe(1);
  expect(existsSync(join(f.root, 'v0.1.800/beta.json'))).toBe(false);
  expect(readFileSync(join(f.root, 'v0.1.800/latest.json'), 'utf8')).toBe(f.stable);
});
