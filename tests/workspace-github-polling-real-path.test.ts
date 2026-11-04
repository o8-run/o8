import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const replay = vi.hoisted(() => ({
  commands: [] as { command: string; args: string[]; cwd: string }[],
  now: 1_800_000_000_000,
  branch: 'feature',
  changed: '',
  issueState: 'OPEN',
  mode: 'success' as 'success' | 'rate-limit' | 'offline' | 'empty' | 'malformed',
  credential: 'fixture-account-a',
  invalidTarget: '',
  invalidJson: '',
  caseId: 0,
  switchCredentialOnRead: false,
  authUnavailable: false,
  hold: null as Promise<void> | null,
}));

vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: async (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => {
      replay.commands.push({ command, args, cwd: options.cwd });
      if (command === 'git') {
        let stdout = '';
        if (args[0] === 'rev-parse') stdout = args.includes('--is-inside-work-tree') ? 'true' : args.includes('--show-toplevel') ? options.cwd : 'a'.repeat(40);
        if (args[0] === 'remote') stdout = 'https://github.com/example/widgets.git';
        if (args[0] === 'status') stdout = `# branch.oid ${'a'.repeat(40)}\n# branch.head ${replay.branch}\n`;
        if (args[0] === 'diff' && args.includes('--name-status')) stdout = replay.changed ? `M\t${replay.changed}\n` : '';
        if (args[0] === 'diff' && args.includes('--numstat')) stdout = replay.changed ? `1\t0\t${replay.changed}\n` : '';
        return { stdout, stderr: '' };
      }
      if (command !== 'gh') throw new Error(`Unexpected command: ${command}`);
      if (args[0] === 'auth') {
        if (replay.authUnavailable) throw new Error('local credential unavailable');
        return { stdout: options.env.GH_TOKEN || replay.credential, stderr: '' };
      }
      if (replay.switchCredentialOnRead) { replay.credential = 'fixture-account-b'; replay.switchCredentialOnRead = false; }
      if (replay.hold) await replay.hold;
      if (replay.mode === 'rate-limit') throw Object.assign(new Error('Command failed'), { stderr: 'GraphQL: API rate limit exceeded' });
      if (replay.mode === 'offline') throw new Error('network unavailable');
      if (replay.invalidTarget === args[0]) return { stdout: replay.invalidJson, stderr: '' };
      if (replay.mode === 'malformed') return { stdout: '<unavailable>', stderr: '' };
      if (args[0] === 'pr') return { stdout: JSON.stringify(replay.mode === 'empty' ? [] : [{
        number: 7, title: 'Fixture change', url: 'https://github.com/example/widgets/pull/7',
        headRefName: replay.branch, baseRefName: 'main', state: 'OPEN', body: 'Closes #41',
      }]), stderr: '' };
      if (args[0] === 'api') return { stdout: '[]', stderr: '' };
      if (args[0] === 'issue') return { stdout: JSON.stringify({
        number: 41, title: `Fixture issue ${options.env.GH_TOKEN}`, url: 'https://github.com/example/widgets/issues/41', state: replay.issueState,
      }), stderr: '' };
      throw new Error(`Unexpected GitHub read: ${args.join(' ')}`);
    },
  }),
}));
// The child-process store lock (#4280) and viewer redaction's ws-auth (#4773) need real fs in the isolated data dir.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: (target: Parameters<typeof actual.existsSync>[0]) => String(target).startsWith('/fixture/') || actual.existsSync(target) };
});
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readFile: async () => replay.credential,
  stat: async () => ({ mtimeMs: replay.now, size: 1, isFile: () => true, isDirectory: () => true }),
}));
vi.mock('@/lib/codex/owned', () => ({ invalidateOwnedCodexFleetCache: vi.fn() }));
vi.mock('@/lib/codex/sessions', () => ({ invalidateCodexDiscoveredFleetCache: vi.fn() }));
vi.mock('@/lib/runtime/inventory', () => ({
  getRuntimeInventorySnapshot: async () => ({ agents: [], meta: { mode: 'live' } }),
  invalidateRuntimeInventoryCache: vi.fn(),
}));
vi.mock('@/lib/render/bootstrap', () => ({ invalidateCommandCenterBootstrapBroker: vi.fn() }));
vi.mock('@/lib/browser/inventory', () => ({ getBrowserInventorySnapshot: async () => ({ surfaces: [] }) }));
vi.mock('@/lib/browser/attachment-state', () => ({ getAttachedBrowserSummary: () => null }));

async function routeRead() {
  const { GET } = await import('@/app/api/command-center/snapshot/route');
  const response = await GET(new NextRequest('http://localhost/api/command-center/snapshot?fresh=1'));
  expect(response.status).toBe(200);
  return response.json();
}
function ghReads(kind?: string) {
  return replay.commands.filter((entry) => entry.command === 'gh' && entry.args[0] !== 'auth' && (!kind || entry.args[0] === kind));
}

beforeEach(() => {
  vi.resetModules();
  // New process identity isolates each case without exposing or changing a real credential.
  vi.stubEnv('GH_TOKEN', `fixture-${++replay.caseId}`);
  vi.stubEnv('CORTEX_IDE_REVIEW_REPO_ROOT', '/fixture/review');
  vi.stubEnv('CORTEX_IDE_REVIEW_REPO', 'example/widgets');
  vi.stubEnv('CORTEX_IDE_ACTIVE_REVIEW_ISSUE', '');
  replay.commands = [];
  replay.now = 1_800_000_000_000;
  replay.branch = 'feature';
  replay.changed = '';
  replay.issueState = 'OPEN';
  replay.mode = 'success';
  replay.credential = 'fixture-account-a';
  replay.hold = null;
  replay.invalidTarget = '';
  replay.invalidJson = '';
  replay.switchCredentialOnRead = false;
  replay.authUnavailable = false;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockImplementation(() => replay.now);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('fresh command-center reads through the real workspace review and command boundary', () => {
  it('reads one linked issue during sixty one-second refreshes while local edits remain current', async () => {
    for (let i = 0; i < 60; i += 1) {
      replay.now += 1_000;
      replay.changed = `edit-${i}.ts`;
      const result = await routeRead();
      expect(result.review.changedFiles[0].path).toBe(replay.changed);
      expect(result.review.activeIssue.state).toBe('OPEN');
    }
    expect(ghReads('issue')).toHaveLength(1);
    expect(ghReads('pr')).toHaveLength(2);
    expect(ghReads('api')).toHaveLength(1);
    expect(replay.commands.filter((entry) => entry.command === 'git' && entry.args[0] === 'status')).toHaveLength(60);
    replay.now += 120_001;
    replay.issueState = 'CLOSED';
    expect((await routeRead()).review.activeIssue.state).toBe('CLOSED');
    expect(ghReads('issue')).toHaveLength(2);
  });

  it('shares in-flight remote reads even when every caller requests fresh local state', async () => {
    let release!: () => void;
    replay.hold = new Promise<void>((resolve) => { release = resolve; });
    const reads = Array.from({ length: 8 }, () => routeRead());
    try { await vi.waitFor(() => expect(ghReads('pr')).toHaveLength(2)); }
    finally { replay.hold = null; release(); }
    await Promise.all(reads);
    expect(ghReads('issue')).toHaveLength(1);
    expect(ghReads('api')).toHaveLength(1);
  });

  it('shares the remote cache across module reloads and local snapshot invalidation', async () => {
    await routeRead();
    const before = ghReads().length;
    const { invalidateReviewSnapshotCache } = await import('@/lib/review/workspace');
    invalidateReviewSnapshotCache();
    vi.resetModules();
    await routeRead();
    expect(ghReads()).toHaveLength(before);
  });

  it('pauses all further remote reads after a rate limit, then recovers on demand', async () => {
    replay.mode = 'rate-limit';
    for (let i = 0; i < 30; i += 1) { replay.now += 1_000; await routeRead(); }
    expect(ghReads()).toHaveLength(2);
    expect(ghReads('issue')).toHaveLength(0);
    replay.now += 60_001;
    replay.mode = 'success';
    expect((await routeRead()).review.activeIssue.state).toBe('OPEN');
    expect(ghReads('issue')).toHaveLength(1);
  });

  it('retains the last known result with its age during failure and does not retry on every poll', async () => {
    await routeRead();
    replay.now += 120_001;
    replay.mode = 'offline';
    const failed = await routeRead();
    expect(failed.review.activeIssue.state).toBe('OPEN');
    expect(failed.review.warnings.join(' ')).toMatch(/cached.*last read/i);
    const afterFailure = ghReads().length;
    for (let i = 0; i < 15; i += 1) { replay.now += 1_000; await routeRead(); }
    expect(ghReads()).toHaveLength(afterFailure);
    replay.mode = 'success';
    replay.issueState = 'CLOSED';
    replay.now += 60_001;
    expect((await routeRead()).review.activeIssue.state).toBe('CLOSED');
  });

  it('caches empty results and malformed-answer failures rather than busy looping', async () => {
    replay.mode = 'empty';
    await routeRead();
    await routeRead();
    expect(ghReads('pr')).toHaveLength(2);
    replay.now += 120_001;
    replay.mode = 'malformed';
    await routeRead();
    const afterFailure = ghReads().length;
    await routeRead();
    expect(ghReads()).toHaveLength(afterFailure);
  });

  it.each([
    ['pr', '{}'], ['pr', 'null'], ['pr', '[null]'], ['pr', '[{}]'],
    ['issue', 'null'], ['issue', '[]'], ['issue', '{}'], ['api', '{}'],
    ['pr', '[{"number":7,"title":"x","url":"x","state":"OPEN","body":42}]'],
    ['pr', '[{"number":7,"title":"x","url":"x","state":"OPEN","reviewDecision":true}]'],
    ['api', '[{"filename":"x.ts","status":42}]'],
    ['api', '[{"filename":"x.ts","additions":"2"}]'],
    ['api', '[{"filename":"x.ts","deletions":{}}]'],
  ])('rejects a valid JSON answer with the wrong %s shape: %s', async (target, raw) => {
    await routeRead();
    replay.now += 120_001;
    replay.invalidTarget = target;
    replay.invalidJson = raw;
    const result = await routeRead();
    expect(result.review.activeIssue.state).toBe('OPEN');
    expect(result.review.warnings.join(' ')).toMatch(/cached.*last read/i);
    const count = ghReads().length;
    await routeRead();
    expect(ghReads()).toHaveLength(count);
  });

  it('isolates repository, workspace, branch and credential scopes', async () => {
    const { getWorkspaceReviewSnapshot } = await import('@/lib/review/workspace');
    const read = (workspacePath: string, repoSlug: string) => getWorkspaceReviewSnapshot({ fresh: true, workspacePath, repoSlug });
    await read('/fixture/a', 'example/one');
    await read('/fixture/b', 'example/one');
    await read('/fixture/a', 'example/two');
    expect(ghReads('issue')).toHaveLength(3);
    replay.branch = 'second';
    await read('/fixture/a', 'example/one');
    expect(ghReads('pr').filter((entry) => entry.args.includes('second'))).toHaveLength(1);
    replay.credential = 'fixture-account-b';
    await read('/fixture/a', 'example/one');
    expect(ghReads('issue')).toHaveLength(3); // The explicit token still identifies the same account.
    vi.stubEnv('GH_TOKEN', 'another-fixture-token');
    await read('/fixture/a', 'example/one');
    expect(ghReads('issue')).toHaveLength(4);
  });

  it('isolates keychain-only changes and pins reads across an in-flight account switch', async () => {
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', '');
    replay.switchCredentialOnRead = true;
    const first = await routeRead();
    expect(first.review.activeIssue.title).toContain('fixture-account-a');
    const second = await routeRead();
    expect(second.review.activeIssue.title).toContain('fixture-account-b');
    replay.credential = 'fixture-account-a';
    expect((await routeRead()).review.activeIssue.title).toContain('fixture-account-a');
    expect(ghReads('issue')).toHaveLength(2);
  });

  it('makes no remote read when the effective credential cannot be resolved locally', async () => {
    replay.authUnavailable = true;
    const result = await routeRead();
    expect(result.review.warnings.join(' ')).toContain('GitHub CLI connection');
    expect(ghReads()).toHaveLength(0);
  });

  it('keeps changes-only snapshots entirely offline and starts no idle work', async () => {
    const { getWorkspaceReviewSnapshot } = await import('@/lib/review/workspace');
    await getWorkspaceReviewSnapshot({ fresh: true, workspacePath: '/fixture/review', changesOnly: true });
    expect(ghReads()).toHaveLength(0);
    replay.now += 24 * 60 * 60 * 1_000;
    await Promise.resolve();
    expect(ghReads()).toHaveLength(0);
  });
});
