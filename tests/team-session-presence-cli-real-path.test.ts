import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'o8-team-session-cli-'));
const cli = join(root, 'o8.mjs');

function createRepo(name: string) {
  const repo = join(root, name);
  mkdirSync(repo);
  const result = spawnSync('git', ['init', '--quiet', repo], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return repo;
}

function presenceDir(repo: string) {
  return join(repo, '.git', 'agents', 'presence');
}

function presenceFile(repo: string, id: string) {
  return join(presenceDir(repo), `${encodeURIComponent(id)}.json`);
}

function runCommand(repo: string, args: string[], bindings: Partial<NodeJS.ProcessEnv>, input?: string) {
  return spawnSync(process.execPath, [cli, 'team', ...args], {
    cwd: repo,
    env: {
      ...process.env,
      O8_AGENT_ID: '',
      O8_WORKER_PACKET_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      CODEX_SESSION_ID: '',
      AI_AGENT: 'test-agent',
      TERM_SESSION_ID: 'shared-terminal',
      O8_DATA_DIR: root,
      ...bindings,
    },
    encoding: 'utf8',
    timeout: 10_000,
    input,
  });
}

function run(repo: string, status: string, bindings: Partial<NodeJS.ProcessEnv>) {
  return runCommand(repo, ['status', status], bindings);
}

beforeAll(async () => {
  await build({
    entryPoints: ['cli/src/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: cli,
    banner: { js: 'import { createRequire as __o8_createRequire } from "node:module"; globalThis.require = __o8_createRequire(import.meta.url);' },
    define: { __O8_CLI_VERSION__: '"test"' },
  });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('team status session identity through the CLI process and persisted presence', () => {
  it.each(['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID'])(
    'keeps distinct %s sessions separate under the same parent process', (key) => {
      const repo = createRepo(key);
      const first = run(repo, 'first session working', { [key]: 'session-one' });
      expect(first.status, first.stderr).toBe(0);
      expect(JSON.parse(first.stdout).sessionKey).toBe('session-one');
      const before = readFileSync(presenceFile(repo, 'session-one'), 'utf8');
      expect(JSON.parse(before).pid).toBe(process.pid);

      const second = run(repo, 'second session working', { [key]: 'session-two' });
      expect(second.status, second.stderr).toBe(0);
      expect(JSON.parse(second.stdout).sessionKey).toBe('session-two');
      expect(readFileSync(presenceFile(repo, 'session-one'), 'utf8')).toBe(before);
      expect(JSON.parse(readFileSync(presenceFile(repo, 'session-two'), 'utf8'))).toMatchObject({
        agentId: 'session-two', sessionKey: 'session-two', status: 'second session working', pid: process.pid,
      });
      expect(readdirSync(presenceDir(repo)).sort()).toEqual(['session-one.json', 'session-two.json']);

      const repeated = run(repo, 'second session updated', { [key]: 'session-two' });
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(JSON.parse(readFileSync(presenceFile(repo, 'session-two'), 'utf8')).status).toBe('second session updated');
      expect(readFileSync(presenceFile(repo, 'session-one'), 'utf8')).toBe(before);
    },
  );

  it('refuses ambiguous callers without altering a legacy host presence or creating another record', () => {
    const repo = createRepo('ambiguous');
    mkdirSync(presenceDir(repo), { recursive: true });
    const legacyFile = presenceFile(repo, `pid-${process.pid}`);
    const before = JSON.stringify({
      agentId: `pid-${process.pid}`, sessionKey: `pid-${process.pid}`,
      handle: 'Existing', runtime: 'cli', pid: process.pid, cwd: repo,
      status: 'existing work', startedAt: new Date().toISOString(), lastSeen: new Date().toISOString(),
    });
    writeFileSync(legacyFile, before);
    for (const status of ['first ambiguous session', 'second ambiguous session']) {
      const result = run(repo, status, {});
      expect(result.status, result.stderr).toBe(5);
      expect(JSON.parse(result.stderr).error).toMatchObject({ code: 'identity_unresolved' });
      expect(result.stderr).toContain('Set O8_AGENT_ID');
      expect(result.stdout).toBe('');
      expect(readFileSync(legacyFile, 'utf8')).toBe(before);
      expect(readdirSync(presenceDir(repo))).toEqual([`pid-${process.pid}.json`]);
    }
  });

  it('preserves explicit binding precedence and updates the same persisted record on retry', () => {
    const repo = createRepo('explicit');
    const bindings = {
      O8_AGENT_ID: ' explicit-session ', O8_WORKER_PACKET_ID: 'packet',
      CLAUDE_CODE_SESSION_ID: 'claude', CODEX_THREAD_ID: 'thread', CODEX_SESSION_ID: 'session',
    };
    for (const status of ['initial', 'updated']) {
      const result = run(repo, status, bindings);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ sessionKey: 'explicit-session', status });
      expect(JSON.parse(readFileSync(presenceFile(repo, 'explicit-session'), 'utf8'))).toMatchObject({
        sessionKey: 'explicit-session', status,
      });
      expect(readdirSync(presenceDir(repo))).toEqual(['explicit-session.json']);
    }
  });

  it('blocks an ambiguous guard caller with the hook exit code while preserving the owner lease', () => {
    const repo = createRepo('guard');
    const acquired = runCommand(repo, ['lease', 'acquire', 'ship'], { O8_AGENT_ID: 'lease-owner' });
    expect(acquired.status, acquired.stderr).toBe(0);
    const leaseFile = join(repo, '.git', 'agents', 'leases', 'ship.json');
    const before = readFileSync(leaseFile, 'utf8');
    const ownerBefore = readFileSync(presenceFile(repo, 'lease-owner'), 'utf8');
    const result = runCommand(repo, ['guard'], {}, JSON.stringify({ tool_input: { command: 'npm run ship' } }));
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('Set O8_AGENT_ID');
    expect(readFileSync(leaseFile, 'utf8')).toBe(before);
    expect(readFileSync(presenceFile(repo, 'lease-owner'), 'utf8')).toBe(ownerBefore);
    expect(readdirSync(presenceDir(repo))).toEqual(['lease-owner.json']);

    const input = JSON.stringify({ tool_input: { command: 'npm run ship' } });
    const owner = runCommand(repo, ['guard'], { O8_AGENT_ID: 'lease-owner' }, input);
    expect(owner.status, owner.stderr).toBe(0);
    const peer = runCommand(repo, ['guard'], { CODEX_THREAD_ID: 'peer-session' }, input);
    expect(peer.status, peer.stderr).toBe(2);
    expect(peer.stderr).toContain("holds the 'ship' lease");
    expect(readFileSync(leaseFile, 'utf8')).toBe(before);
  });
});
