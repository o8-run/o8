import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { publishedLinuxAssetName } from '../scripts/lib/release-manifest.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('completes the beta Linux manifest through ship:linux-sig without changing rolling stable', () => {
  const root = mkdtempSync(join(tmpdir(), 'o8-beta-linux-'));
  roots.push(root);
  mkdirSync(join(root, 'bin'));
  const version = '0.1.900', tag = `v${version}`, asset = publishedLinuxAssetName(version);
  const manifest = { channel: 'beta', version, platforms: {
    'darwin-x86_64': { url: `https://github.com/o8-run/o8/releases/download/${tag}/o8.app.tar.gz`, signature: 'darwin-fixture' },
  } };
  for (const release of [tag, 'v0.1.800']) mkdirSync(join(root, release));
  for (const name of ['beta.json', 'latest.json']) writeFileSync(join(root, tag, name), JSON.stringify(manifest));
  const stable = JSON.stringify({ version: '0.1.800', platforms: {} });
  writeFileSync(join(root, 'v0.1.800/latest.json'), stable);
  writeFileSync(join(root, tag, asset), 'fixture artifact bytes');
  const gh = join(root, 'bin/gh');
  writeFileSync(gh, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2),root=process.env.O8_LINUX_FIXTURE;
fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify(a)+'\\n');
if(a[1]==='view')process.stdout.write(a.includes('--jq')?'v0.1.800':JSON.stringify({isDraft:false,assets:[{name:${JSON.stringify(asset)}}]}));
if(a[1]==='download'){const name=a[a.indexOf('--pattern')+1];fs.copyFileSync(path.join(root,a[2],name),path.join(a[a.indexOf('--dir')+1],name));}
if(a[1]==='upload')for(const file of a.slice(3)){if(file.startsWith('--'))break;fs.copyFileSync(file,path.join(root,a[2],path.basename(file)));}
`);
  const cargo = join(root, 'bin/cargo');
  writeFileSync(cargo, `#!${process.execPath}
const fs=require('node:fs');fs.writeFileSync(process.argv.at(-1)+'.sig','linux-fixture');
`);
  for (const executable of [gh, cargo]) chmodSync(executable, 0o700);
  const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts/sign-linux-appimage.mjs'), '--tag', tag, '--repo', 'o8-run/o8'], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, CI: '', TAURI_SIGNING_PRIVATE_KEY: 'fixture', PATH: `${join(root, 'bin')}:${process.env.PATH}`, O8_LINUX_FIXTURE: root },
  });
  expect(result.status, result.stderr).toBe(0);
  const beta = JSON.parse(readFileSync(join(root, tag, 'beta.json'), 'utf8'));
  expect(beta.platforms['linux-x86_64']).toMatchObject({ signature: 'linux-fixture' });
  expect(beta.platforms['darwin-x86_64']).toEqual(manifest.platforms['darwin-x86_64']);
  expect(JSON.parse(readFileSync(join(root, tag, 'latest.json'), 'utf8'))).toEqual(beta);
  expect(JSON.parse(readFileSync(join(root, 'v0.1.800/beta.json'), 'utf8'))).toEqual(beta);
  expect(readFileSync(join(root, 'v0.1.800/latest.json'), 'utf8')).toBe(stable);
});
