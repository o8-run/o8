import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectPersistedTmuxSessions } from '@/lib/terminal/state-store';
import { DASH_PROFILE_OWNER_OPTION, dashProfileOwnerId } from '@/lib/terminal/dash-session-owner';
import { listDashTmuxSessionsWithAge, reapOrphanDashTmuxSessions } from '@/lib/ws-server/dash-terminal-gc';
import { createDashTmuxSessionSync, dashTmuxArgs } from '@/lib/ws-server/dash-terminal-persistence';
import { tmuxIntegrationAvailable } from './helpers/tmux-prerequisite';

const root = mkdtempSync(join(tmpdir(), 'o8-profile-gc-'));
const profileA = join(root, 'a');
const profileB = join(root, 'b');
const server = `o8-profile-gc-${process.pid}-${randomUUID().slice(0, 8)}`;
const tmuxAvailable = tmuxIntegrationAvailable();

function create(profile: string, name: string) {
  vi.stubEnv('O8_DATA_DIR', profile);
  expect(createDashTmuxSessionSync({
    enabled: true, sessionName: name, cols: 80, rows: 24, cwd: root, shell: '/bin/sh',
    env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: root, TERM: 'xterm-256color' },
  })).toBe(true);
}

function save(profile: string, names: string[]) {
  writeFileSync(join(profile, 'terminal-state.json'), JSON.stringify({ tabs: names.map((tmuxSession) => ({ tmuxSession })) }));
}

function sweep(dataDir = profileA, liveSessionNames: string[] = []) {
  return reapOrphanDashTmuxSessions({
    dataDir, liveSessionNames, collectAdditionalReferences: () => [], beforeKill: () => {},
    nowMs: Date.now() + 600_000, minAgeMs: 300_000, maxSessions: 1,
  });
}

function stopServer() {
  try { execFileSync('tmux', ['-L', server, 'kill-server'], { stdio: 'ignore', timeout: 3000 }); } catch { /* absent */ }
}

beforeEach(() => {
  vi.stubEnv('O8_DASH_TMUX_SERVER_NAME', server);
  for (const profile of [profileA, profileB]) mkdirSync(profile, { recursive: true });
});
afterEach(() => {
  stopServer();
  vi.unstubAllEnvs();
  for (const profile of [profileA, profileB]) rmSync(profile, { recursive: true, force: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe.runIf(tmuxAvailable)('profile-owned terminal cleanup through real tmux and saved state', () => {
  it('retires only its own orphan, preserving referenced, live, foreign and legacy sessions even over the cap', () => {
    create(profileA, 'cortex-dash-referenced');
    create(profileA, 'cortex-dash-live');
    create(profileA, 'cortex-dash-orphan');
    create(profileB, 'cortex-dash-foreign');
    execFileSync('tmux', dashTmuxArgs('new-session', '-d', '-s', 'cortex-dash-legacy', '/bin/sh'), { cwd: root });
    save(profileA, ['cortex-dash-referenced']);
    save(profileB, ['cortex-dash-foreign']);
    expect(listDashTmuxSessionsWithAge().find(({ name }) => name === 'cortex-dash-foreign')?.profileOwner)
      .toBe(dashProfileOwnerId(profileB));

    expect(sweep(profileA, ['cortex-dash-live'])).toBe(1);
    expect(listDashTmuxSessionsWithAge().map(({ name }) => name).sort()).toEqual([
      'cortex-dash-foreign', 'cortex-dash-legacy', 'cortex-dash-live', 'cortex-dash-referenced',
    ]);
    // Shared restoration/snapshot inventory must still include the legacy row.
    expect(collectPersistedTmuxSessions(profileB)).toEqual(new Set(['cortex-dash-foreign']));
  });

  it.each(['malformed', 'unreadable', 'invalid-shape', 'dangling'])('skips the entire sweep when a saved scope is %s', (kind) => {
    create(profileA, 'cortex-dash-detached');
    create(profileA, 'cortex-dash-unreferenced');
    save(profileA, ['cortex-dash-detached']);
    const scopes = join(profileA, 'terminal-states');
    mkdirSync(scopes);
    const invalid = join(scopes, 'incomplete.json');
    if (kind === 'unreadable') mkdirSync(invalid);
    else if (kind === 'dangling') symlinkSync(join(root, 'absent-state'), invalid);
    else writeFileSync(invalid, kind === 'malformed' ? '{' : '{"tabs":[{"tmuxSession":42}]}');
    expect(sweep()).toBe(0);
    expect(listDashTmuxSessionsWithAge().map(({ name }) => name)).toContain('cortex-dash-detached');
    expect(listDashTmuxSessionsWithAge().map(({ name }) => name)).toContain('cortex-dash-unreferenced');
    expect(() => collectPersistedTmuxSessions(profileA)).toThrow();
  });

  it('uses canonical profile paths and never claims a reused foreign or legacy session', () => {
    const alias = join(root, 'profile-alias');
    symlinkSync(profileA, alias, 'dir');
    try {
      expect(dashProfileOwnerId(alias)).toBe(dashProfileOwnerId(profileA));
      create(alias, 'cortex-dash-alias');
      create(profileB, 'cortex-dash-foreign');
      create(profileA, 'cortex-dash-foreign');
      execFileSync('tmux', dashTmuxArgs('new-session', '-d', '-s', 'cortex-dash-legacy', '/bin/sh'), { cwd: root });
      create(profileA, 'cortex-dash-legacy');
      const rows = listDashTmuxSessionsWithAge();
      expect(rows.find(({ name }) => name === 'cortex-dash-alias')?.profileOwner).toBe(dashProfileOwnerId(profileA));
      expect(rows.find(({ name }) => name === 'cortex-dash-foreign')?.profileOwner).toBe(dashProfileOwnerId(profileB));
      expect(rows.find(({ name }) => name === 'cortex-dash-legacy')?.profileOwner).toBe('');
      expect(execFileSync('tmux', dashTmuxArgs('show-options', '-v', '-t', 'cortex-dash-alias', DASH_PROFILE_OWNER_OPTION), { encoding: 'utf8' }).trim())
        .toMatch(/^[a-f0-9]{32}$/u);
      expect(sweep(alias)).toBe(1);
      expect(listDashTmuxSessionsWithAge().map(({ name }) => name).sort()).toEqual(['cortex-dash-foreign', 'cortex-dash-legacy']);
    } finally {
      rmSync(alias, { force: true });
    }
  });

  it('does not retire anything without a resolvable profile or complete additional references', () => {
    create(profileA, 'cortex-dash-orphan');
    expect(sweep(join(root, 'absent'))).toBe(0);
    expect(reapOrphanDashTmuxSessions({
      dataDir: profileA, liveSessionNames: [], beforeKill: () => { throw new Error('must not reach kill'); },
      collectAdditionalReferences: () => { throw new Error('references unavailable'); },
      nowMs: Date.now() + 600_000, minAgeMs: 300_000, maxSessions: 1,
    })).toBe(0);
    expect(listDashTmuxSessionsWithAge().map(({ name }) => name)).toEqual(['cortex-dash-orphan']);
  });

  it('never follows a vanished candidate prefix into a foreign session', () => {
    create(profileA, 'cortex-dash-candidate');
    create(profileB, 'cortex-dash-candidate-foreign');
    expect(reapOrphanDashTmuxSessions({
      dataDir: profileA, liveSessionNames: [], collectAdditionalReferences: () => [],
      nowMs: Date.now() + 600_000, minAgeMs: 300_000, maxSessions: 1,
      beforeKill(name) {
        execFileSync('tmux', dashTmuxArgs('kill-session', '-t', `=${name}`), { stdio: 'ignore' });
      },
    })).toBe(0);
    expect(listDashTmuxSessionsWithAge().map(({ name }) => name)).toEqual(['cortex-dash-candidate-foreign']);
  });

  it('preserves a foreign replacement which reuses the exact candidate name', () => {
    create(profileA, 'cortex-dash-candidate');
    // Keep the same tmux server alive, so session ids remain from one epoch.
    create(profileB, 'cortex-dash-retained');
    expect(reapOrphanDashTmuxSessions({
      dataDir: profileA, liveSessionNames: [], collectAdditionalReferences: () => [],
      nowMs: Date.now() + 600_000, minAgeMs: 300_000, maxSessions: 1,
      beforeKill(name) {
        execFileSync('tmux', dashTmuxArgs('kill-session', '-t', `=${name}`), { stdio: 'ignore' });
        create(profileB, name);
      },
    })).toBe(0);
    expect(listDashTmuxSessionsWithAge().find(({ name }) => name === 'cortex-dash-candidate')?.profileOwner)
      .toBe(dashProfileOwnerId(profileB));
  });

  it.each(['same-profile', 'foreign-profile'])('preserves a %s replacement after the tmux server restarts', (kind) => {
    create(profileA, 'cortex-dash-candidate');
    const replacementProfile = kind === 'same-profile' ? profileA : profileB;
    expect(reapOrphanDashTmuxSessions({
      dataDir: profileA, liveSessionNames: [], collectAdditionalReferences: () => [],
      nowMs: Date.now() + 600_000, minAgeMs: 300_000, maxSessions: 1,
      beforeKill(name) {
        stopServer();
        create(replacementProfile, name);
        save(replacementProfile, [name]);
      },
    })).toBe(0);
    expect(listDashTmuxSessionsWithAge().find(({ name }) => name === 'cortex-dash-candidate')?.profileOwner)
      .toBe(dashProfileOwnerId(replacementProfile));
  });

  it('reports retirement when its last owned orphan closes the tmux server', () => {
    create(profileA, 'cortex-dash-last-orphan');
    expect(sweep()).toBe(1);
    expect(listDashTmuxSessionsWithAge()).toEqual([]);
  });

  it('creates an exact identity instead of adopting a longer foreign prefix', () => {
    create(profileB, 'cortex-dash-new-foreign');
    create(profileA, 'cortex-dash-new');
    expect(listDashTmuxSessionsWithAge().find(({ name }) => name === 'cortex-dash-new')?.profileOwner)
      .toBe(dashProfileOwnerId(profileA));
    expect(listDashTmuxSessionsWithAge().find(({ name }) => name === 'cortex-dash-new-foreign')?.profileOwner)
      .toBe(dashProfileOwnerId(profileB));
  });

  it.each(['null', '[]', '{}', '{"tabs":null}', '{"tabs":[null]}', '{"tabs":[[]]}'])('rejects invalid legacy state %s', (contents) => {
    writeFileSync(join(profileA, 'terminal-state.json'), contents);
    expect(() => collectPersistedTmuxSessions(profileA)).toThrow();
  });
});
