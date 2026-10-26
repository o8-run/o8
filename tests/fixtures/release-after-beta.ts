import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, type SpawnSyncReturns } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';

interface PublicationFixture { root: string; bundle: string; dmgApp: string; log: string; version: string }

export function verifyStableAfterBeta(
  fixture: (version: string) => PublicationFixture,
  run: (f: PublicationFixture, channel: string, args?: string[], env?: Record<string, string>) => SpawnSyncReturns<string>,
  effects: (f: PublicationFixture) => Array<{ name: string; args: string[] }>,
) {
  const f = fixture('0.1.900');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const commit = (message: string) => git('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', message);
  commit('base'); git('tag', 'v0.1.800');
  commit('fix: beta report\n\nFixes-Report: BETA01'); git('tag', 'v0.1.900');
  const evidence = (tag_name: string, prerelease: boolean, published_at: string) => JSON.stringify({ tag_name, draft: false, prerelease, published_at });
  writeFileSync(join(f.root, 'release-evidence.jsonl'), [evidence('v0.1.900', true, '2026-10-25T00:00:00Z'),
    evidence('v0.1.800', false, '2026-10-24T00:00:00Z')].join('\n'));
  mkdirSync(join(f.root, 'data/feedback'), { recursive: true });
  writeFileSync(join(f.root, 'data/feedback/reports.jsonl'), ['BETA01', 'STBL02'].map(id => JSON.stringify({ id, title: `Report ${id}` })).join('\n') + '\n');
  const env = { O8_CHANNEL_TEST_REAL_REPORTS: '1', O8_FIXED_WEBHOOK_URL: 'https://fixture.invalid/fixed' };
  const beta = run(f, 'beta', [], env);
  expect(beta.status, beta.stderr).toBe(0);
  expect(existsSync(join(f.root, 'data/feedback/published.json'))).toBe(false);
  expect(existsSync(join(f.bundle, 'macos/fixed.json'))).toBe(false);
  commit('fix: stable report\n\nFixes-Report: STBL02'); git('tag', 'v0.1.901');
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ version: '0.1.901' }));
  // A fresh fixture supplies the rebuilt versioned bundle; Git history and ledger remain here.
  const stable = fixture('0.1.901');
  cpSync(stable.bundle, f.bundle, { recursive: true });
  cpSync(stable.dmgApp, f.dmgApp, { recursive: true });
  cpSync(join(stable.root, 'src-tauri/tauri.conf.json'), join(f.root, 'src-tauri/tauri.conf.json'));
  cpSync(join(stable.root, 'src-tauri/helpers'), join(f.root, 'src-tauri/helpers'), { recursive: true });
  writeFileSync(f.log, '');
  const result = run({ ...f, version: '0.1.901' }, 'stable', [], env);
  expect(result.status, result.stderr).toBe(0);
  const fixed = JSON.parse(readFileSync(join(f.bundle, 'macos/fixed.json'), 'utf8'));
  expect(fixed.fixed.map((row: { id: string }) => row.id).sort()).toEqual(['BETA01', 'STBL02']);
  const published = JSON.parse(readFileSync(join(f.root, 'data/feedback/published.json'), 'utf8'));
  expect(published.fixed.map((row: { id: string }) => row.id).sort()).toEqual(['BETA01', 'STBL02']);
  expect(effects(f).filter(c => c.name === 'fixedAnnouncement')).toHaveLength(2);
}

export function verifyBetaBuildWorkflow(
  f: PublicationFixture,
  run: Parameters<typeof verifyStableAfterBeta>[1],
  effects: Parameters<typeof verifyStableAfterBeta>[2],
  releaseScript: string,
) {
  const noop = { command: process.execPath, args: ['-e', ''] };
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'o8-beta-build-profile-')));
  try {
    const plan = join(f.root, 'ship-plan.json');
    writeFileSync(plan, JSON.stringify({ preflight: noop, build: noop, notarize: noop,
      publish: { command: process.execPath, args: ['--import', join(f.root, 'register.mjs'), releaseScript] } }));
    const result = run(f, 'beta', ['--ship'], {
      O8_RELEASE_TEST_MODE: '1', O8_RELEASE_TEST_PLAN: plan, O8_CHANNEL_TEST_SHIP: '1',
      O8_RELEASE_BUILD_DATA_DIR: profile,
      O8_RELEASE_LOCK_PATH: join(f.root, 'ship.lock'), O8_RELEASE_BROADCAST_CLI: join(f.root, 'absent-broadcast'),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(f.bundle, 'macos/beta.json'))).toBe(true);
    expect(existsSync(join(f.bundle, 'macos/latest.json'))).toBe(false);
    expect(effects(f).filter(c => c.name === 'gh' && c.args[1] === 'create')).toHaveLength(2);
  } finally { rmSync(profile, { recursive: true, force: true }); }
}
