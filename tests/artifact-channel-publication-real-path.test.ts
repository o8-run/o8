import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
const roots: string[] = [];
const source = join(process.cwd(), 'tests/fixtures/build-channel');
function fixture(channel: 'stable' | 'beta') {
  const root = mkdtempSync(join(tmpdir(), 'o8-bound-channel-'));
  roots.push(root);
  const mac = join(
    root,
    'src-tauri/target/universal-apple-darwin/release/bundle/macos',
  );
  mkdirSync(mac, { recursive: true });
  const archive = join(mac, 'o8.app.tar.gz');
  copyFileSync(join(source, `${channel}.tar.gz`), archive);
  copyFileSync(join(source, `${channel}.tar.gz.sig`), archive + '.sig');
  const extract = spawnSync('tar', ['xzf', archive, '-C', mac]);
  expect(extract.status).toBe(0);
  mkdirSync(join(root, 'src-tauri/helpers'), { recursive: true });
  copyFileSync(
    join(mac, 'o8.app/Contents/Resources/o8-next-build.json'),
    join(root, 'src-tauri/helpers/o8-next-build.json'),
  );
  mkdirSync(join(mac, '../dmg'));
  writeFileSync(
    join(mac, '../dmg/o8_0.1.900_universal.dmg'),
    'fixture installer',
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ version: '0.1.900' }),
  );
  writeFileSync(
    join(root, 'src-tauri/tauri.conf.json'),
    JSON.stringify({
      plugins: {
        updater: {
          pubkey: readFileSync(join(source, 'public-key.txt'), 'utf8'),
        },
      },
    }),
  );
  const log = join(root, 'effects.jsonl');
  const loader = `export async function load(url,context,next){if(url.endsWith('/scripts/native-bundle.mjs'))return {format:'module',shortCircuit:true,source:'export function verifyNativeBundle(){}'};if(url!=='node:child_process')return next(url,context);return {format:'module',shortCircuit:true,source:${JSON.stringify(`
const real=process.getBuiltinModule('node:child_process'),fs=process.getBuiltinModule('node:fs'),p=process.getBuiltinModule('node:path');
export function spawn(command,args,options){if(process.env.O8_BOUND_SHIP==='1'&&command===process.execPath)return real.spawn(command,args,options);throw Error('Tests cannot build or sign');}
export function execFileSync(command,args=[],options={}){
 if(command==='tar')return real.execFileSync(command,args,options);
 if(args.includes('--sign')||command==='cargo'||(command==='xcrun'&&!args.includes('validate')))throw Error('Tests cannot sign or notarize');
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({command,args})+'\\n');
 if(command.endsWith('hdiutil')&&args[0]==='attach')fs.cpSync(${JSON.stringify(join(mac, 'o8.app'))},p.join(args[args.indexOf('-mountpoint')+1],'o8.app'),{recursive:true});
 if(command.endsWith('plutil')){if(args[0]==='-convert')return JSON.stringify({'system-entities':[{'dev-entry':'/dev/disk99'}]});return '0.1.900\\n';}
 if(command==='gh'&&args[1]==='download'&&args[2]==='beta'){fs.writeFileSync(p.join(args[args.indexOf('--dir')+1],'beta.json'),JSON.stringify({channel:'beta',version:process.env.O8_BOUND_MIRROR_FEED_VERSION}));return '';}
 if(command==='gh'&&args[0]==='api')return JSON.stringify({tag_name:'v0.1.800',draft:false,prerelease:false,published_at:'2026-09-01T00:00:00Z'});
 if(command==='git')return args[0]==='rev-parse'?'a'.repeat(40):args[0]==='describe'?'v0.1.900':args[0]==='ls-remote'?'a'.repeat(40)+'\\trefs/tags/v0.1.900':'fix: fixture';
 if(command==='gh'&&args[1]==='view'){if(args[2]==='beta')return JSON.stringify({tagName:'beta',isDraft:false,isPrerelease:true,assets:process.env.O8_BOUND_MIRROR_FEED_VERSION&&args[args.indexOf('--repo')+1]!=='o8-run/o8'?[{name:'beta.json'}]:[]});if(args.includes('tagName'))return 'v0.1.800';if(args.includes('assets'))return '{"assets":[]}';throw Error('candidate absent');}
 return '';
}
export function spawnSync(command,args){if(!command.endsWith('codesign'))throw Error('Tests cannot execute platform commands');return {status:0,stdout:args.includes('-r')?'designated => identifier fixture':'',stderr:'Identifier=fixture\\nTeamIdentifier=fixture-team\\nCodeDirectory flags=0x10000(runtime)\\nRuntime Version=15.0.0'};}
`)}};}`;
  writeFileSync(join(root, 'loader.mjs'), loader);
  writeFileSync(
    join(root, 'register.mjs'),
    "import{register}from'node:module';register(new URL('./loader.mjs',import.meta.url));",
  );
  return { root, mac, log, archive };
}
function run(
  f: ReturnType<typeof fixture>,
  entry: string,
  env: Record<string, string> = {},
  args: string[] = [],
) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      join(f.root, 'register.mjs'),
      join(process.cwd(), 'scripts', entry),
      ...args,
    ],
    {
      cwd: f.root,
      encoding: 'utf8',
      timeout: 20000,
      env: {
        PATH: process.env.PATH,
        HOME: f.root,
        NODE_ENV: 'test',
        O8_RELEASE_FEED_LOCK: join(f.root, 'publication.lock'),
        O8_MACOS_CPU_PACKAGES: '',
        ...env,
      },
    },
  );
}
function writes(f: ReturnType<typeof fixture>) {
  return existsSync(f.log)
    ? readFileSync(f.log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter(
          (v) =>
            v.command === 'gh' &&
            ['create', 'upload', 'edit'].includes(v.args[1]),
        )
    : [];
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it.each<Record<string, string>>([{}, { O8_RELEASE_CHANNEL: 'stable' }])(
  'A1: an interrupted beta build cannot retry through the stable publisher (%j)',
  (env) => {
    const f = fixture('beta');
    const result = run(f, 'release.mjs', env);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/channel|identity/i);
    expect(writes(f)).toEqual([]);
    expect(existsSync(join(f.mac, 'latest.json'))).toBe(false);
    expect(existsSync(join(f.mac, 'fixed.json'))).toBe(false);
  },
);
it('A1: beta publication uses the signed build identity even with a stable environment', () => {
  const f = fixture('beta');
  const result = run(f, 'release-beta.mjs', { O8_RELEASE_CHANNEL: 'stable' });
  expect(result.status, result.stderr).toBe(0);
  expect(writes(f).length).toBeGreaterThan(0);
  expect(
    writes(f)
      .filter((v) => v.args[1] === 'create')
      .every(
        (v) =>
          v.args.includes('--prerelease') && v.args.includes('--latest=false'),
      ),
  ).toBe(true);
  const manifest = JSON.parse(readFileSync(join(f.mac, 'beta.json'), 'utf8'));
  expect(manifest.channel).toBe('beta');
  expect(existsSync(join(f.mac, 'latest.json'))).toBe(false);
  expect(existsSync(join(f.mac, 'fixed.json'))).toBe(false);
});
it('A4: a stable artifact still runs the stable archive guard regardless of beta environment', () => {
  const f = fixture('stable');
  rmSync(join(f.mac, 'o8.app/Contents/MacOS/o8-next'));
  const result = run(f, 'release.mjs', { O8_RELEASE_CHANNEL: 'beta' });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/archive|binary|o8-next/i);
  expect(writes(f)).toEqual([]);
});
it('A1: editing an unsigned sidecar cannot relabel the signed archive', () => {
  const f = fixture('beta');
  writeFileSync(
    join(f.mac, 'o8.app/Contents/Resources/server/o8-build-channel.json'),
    JSON.stringify({
      schema: 'o8/build-channel/v1',
      version: '0.1.900',
      channel: 'stable',
    }),
  );
  const result = run(f, 'release.mjs');
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/channel|identity/i);
  expect(writes(f)).toEqual([]);
});
it('A1: tampering with the archive channel invalidates its existing signature', () => {
  const f = fixture('beta');
  writeFileSync(
    f.archive,
    Buffer.concat([readFileSync(f.archive), Buffer.from('tampered')]),
  );
  const result = run(f, 'release-beta.mjs');
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/signature|identity/i);
  expect(writes(f)).toEqual([]);
});

it('A1: beta dry run never writes release or rolling manifests', () => {
  const f = fixture('beta');
  const result = run(f, 'release-beta.mjs', {}, ['--dry-run']);
  expect(result.status, result.stderr).toBe(0);
  expect(writes(f)).toEqual([]);
});

it('A1: beta uses an independent feed anchor that stable publication cannot move', () => {
  const f = fixture('beta');
  const result = run(f, 'release-beta.mjs');
  expect(result.status, result.stderr).toBe(0);
  expect(
    writes(f)
      .filter((v) => v.args[1] === 'upload')
      .every((v) => v.args[2] === 'beta'),
  ).toBe(true);
});

it('A4: preview clobber is refused before any artifact or publication work', () => {
  const f = fixture('beta');
  writeFileSync(
    join(f.root, 'package.json'),
    JSON.stringify({ version: '0.1.900-preview.1' }),
  );
  const result = run(f, 'release.mjs', { O8_RELEASE_CLOBBER: '1' });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Preview artifacts are immutable/);
  expect(writes(f)).toEqual([]);
});

it.each(['stable', 'beta'] as const)(
  'A1: %s publisher refuses an unauthenticated Linux installer',
  (channel) => {
    const f = fixture(channel);
    const directory = join(f.root, 'src-tauri/target/release/bundle/deb');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'o8_0.1.900_amd64.deb'),
      'unbound beta installer',
    );
    const result = run(
      f,
      channel === 'stable' ? 'release.mjs' : 'release-beta.mjs',
    );
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/authenticated.*channel|channel.*identity/i);
    expect(writes(f)).toEqual([]);
  },
);

it('A1: the ship command publishes only beta from build intent even with a stable environment', () => {
  const f = fixture('beta');
  writeFileSync(
    join(f.root, 'release-build.json'),
    JSON.stringify({ channel: 'beta' }),
  );
  symlinkSync(join(process.cwd(), 'scripts'), join(f.root, 'scripts'), 'dir');
  const profile = mkdtempSync(join(tmpdir(), 'o8-ship-build-profile-'));
  roots.push(profile);
  const plan = join(f.root, 'plan.json');
  const noop = { command: process.execPath, args: ['-e', ''] };
  writeFileSync(
    plan,
    JSON.stringify({
      preflight: noop,
      build: noop,
      notarize: noop,
      publish: noop,
    }),
  );
  const result = run(f, 'ship.mjs', {
    O8_RELEASE_CHANNEL: 'stable',
    O8_BOUND_SHIP: '1',
    O8_RELEASE_TEST_MODE: '1',
    O8_RELEASE_TEST_PLAN: plan,
    O8_RELEASE_LOCK_PATH: join(f.root, 'ship.lock'),
    O8_RELEASE_BUILD_DATA_DIR: profile,
    NODE_OPTIONS: '--import=' + join(f.root, 'register.mjs'),
  });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(writes(f).length).toBeGreaterThan(0);
  expect(existsSync(join(f.mac, 'beta.json'))).toBe(true);
  expect(existsSync(join(f.mac, 'latest.json'))).toBe(false);
});

it('A1: a newer mirror beta feed refuses before any remote publication mutation', () => {
  const f = fixture('beta');
  const result = run(f, 'release-beta.mjs', {
    O8_BOUND_MIRROR_FEED_VERSION: '0.1.901',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/replace or downgrade beta/);
  expect(writes(f)).toEqual([]);
});
