import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const execFile = vi.fn((...args: unknown[]) => {
  const callback = args[args.length - 1] as (
    error: Error | null,
    stdout: string,
    stderr: string,
  ) => void;
  callback(null, '', '');
});
const listRepos = vi.fn<() => Promise<Array<{
  id: string;
  name: string;
  localPath: string;
}>>>(async () => []);
const syncOrchestratorControlPlaneState = vi.fn();

vi.mock('node:child_process', () => ({ execFile }));
vi.mock('@/lib/repos/registry', () => ({ listRepos }));
vi.mock('@/lib/lane/registry', () => ({
  findLaneByPacket: vi.fn(() => null),
  getLaneEvents: vi.fn(() => []),
}));
vi.mock('@/lib/orchestrator/control-plane', () => ({
  syncOrchestratorControlPlaneState,
}));

const { GET } = await import('@/app/api/mobile/activity/route');

describe('mobile activity route', () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((...args: unknown[]) => {
      const callback = args[args.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      callback(null, '', '');
    });
    listRepos.mockReset();
    listRepos.mockResolvedValue([]);
    syncOrchestratorControlPlaneState.mockReset();
    syncOrchestratorControlPlaneState.mockResolvedValue({ packets: [] });
  });

  it('observes bounded Git activity across all refs with source-neutral provenance', async () => {
    const recordSeparator = '\u001e';
    const fieldSeparator = '\u001f';
    const statSeparator = '\u001d';
    const featureSha = '1111111111111111111111111111111111111111';
    const remoteSha = '2222222222222222222222222222222222222222';
    const featureStats = [
      '3\t1\tsrc/one.ts',
      '-\t-\tassets/logo.png',
      '2\t2\tsrc/{old => new}.ts',
      '1\t0\tsrc/four.ts',
      '1\t0\tsrc/five.ts',
      '1\t0\tsrc/six.ts',
      '1\t0\tsrc/seven.ts',
      '1\t0\tsrc/eight.ts',
      '1\t0\tsrc/nine.ts',
      '1\t0\tsrc/ten.ts',
    ];
    listRepos.mockResolvedValue([{
      id: 'repo-o8',
      name: 'o8',
      localPath: '/tmp/o8',
    }]);
    execFile.mockImplementation((...args: unknown[]) => {
      const gitArgs = args[1] as string[];
      const callback = args[args.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      if (gitArgs.includes('log')) {
        callback(null, [
          `${recordSeparator}${featureSha}${fieldSeparator}refs/heads/feature/offline-work${fieldSeparator}parent-a${fieldSeparator}Sydney${fieldSeparator}Build outside o8${fieldSeparator}2026-07-30T18:30:00.000Z${statSeparator}\n${featureStats.join('\n')}\n`,
          `${recordSeparator}${remoteSha}${fieldSeparator}refs/remotes/origin/review${fieldSeparator}parent-b parent-c${fieldSeparator}Marquise${fieldSeparator}Merge reviewed work${fieldSeparator}2026-07-30T18:00:00.000Z${statSeparator}\n0\t0\tREADME.md`,
        ].join(''), '');
        return;
      }
      callback(null, '', '');
    });

    const response = await GET(new Request('http://localhost:3001/api/mobile/activity'));
    const payload = await response.json();
    const gitInvocation = execFile.mock.calls.find((call) =>
      Array.isArray(call[1]) && (call[1] as string[]).includes('log')
    );
    const gitArgs = gitInvocation?.[1] as string[];

    expect(gitArgs).toEqual(expect.arrayContaining([
      '-C',
      '/tmp/o8',
      'log',
      '--all',
      '--source',
      '--max-count=20',
      '--numstat',
      '--find-renames',
      '--diff-merges=first-parent',
    ]));
    expect(gitInvocation?.[2]).toEqual(expect.objectContaining({
      env: expect.objectContaining({ LC_ALL: 'C' }),
    }));
    expect(gitArgs).not.toContain('fetch');
    expect(gitArgs).not.toContain('pull');
    // One capped receipts query plus one dated day-count query (#2407).
    expect(execFile).toHaveBeenCalledTimes(2);
    const countArgs = execFile.mock.calls[1]?.[1] as string[];
    expect(countArgs).toEqual(expect.arrayContaining(['-C', '/tmp/o8', 'log', '--all', '--format=%cI']));
    expect(countArgs.some((arg) => arg.startsWith('--since='))).toBe(true);
    expect(countArgs.some((arg) => arg.startsWith('--max-count'))).toBe(false);
    expect(payload.events).toEqual([
      expect.objectContaining({
        id: `commit:${featureSha}`,
        source: 'git',
        repoId: 'repo-o8',
        commitSha: featureSha,
        author: 'Sydney',
        observedRef: 'feature/offline-work',
        detail: 'feature/offline-work · 1111111',
        kind: 'commit',
        filesChanged: 10,
        additions: 12,
        deletions: 3,
        relatedFiles: [
          'src/one.ts',
          'assets/logo.png',
          'src/{old => new}.ts',
          'src/four.ts',
          'src/five.ts',
          'src/six.ts',
          'src/seven.ts',
          'src/eight.ts',
        ],
        relatedFilesTruncated: true,
      }),
      expect.objectContaining({
        id: `commit:${remoteSha}`,
        source: 'git',
        commitSha: remoteSha,
        author: 'Marquise',
        observedRef: 'origin/review',
        detail: 'origin/review · 2222222',
        kind: 'merge',
        filesChanged: 1,
        additions: 0,
        deletions: 0,
        relatedFiles: ['README.md'],
        relatedFilesTruncated: false,
      }),
    ]);
  });

  it('surfaces archived recoverable packet work as an alert with its preserved ref', async () => {
    syncOrchestratorControlPlaneState.mockResolvedValue({
      packets: [{
        id: 'pkt-recoverable',
        title: 'Preserved review',
        workspaceTargetPath: '/tmp/o8',
        branchTarget: 'preserved/packet-pkt-recoverable',
        releaseState: 'pending',
        status: 'archived',
        archivedAt: '2026-07-23T12:00:00.000Z',
        recovery: {
          outcome: 'archived_recoverable',
          preservedRef: 'preserved/packet-pkt-recoverable',
          preservedHeadSha: 'abc123',
          message: 'Reviewed work preserved at preserved/packet-pkt-recoverable — retry/redispatch to resume.',
          recommendedAction: 'retry_packet',
        },
      } as OrchestratorPacket],
    });

    const response = await GET(new Request('http://localhost:3001/api/mobile/activity'));
    const payload = await response.json();

    expect(payload.events).toEqual([
      expect.objectContaining({
        id: 'packet:pkt-recoverable',
        source: 'orchestrator',
        kind: 'alert',
        detail: expect.stringContaining('preserved/packet-pkt-recoverable'),
      }),
    ]);
    expect(payload.events[0]).not.toHaveProperty('filesChanged');
    expect(payload.events[0]).not.toHaveProperty('relatedFiles');
  });

  it('bounds Git fanout and preserves successful repos when one fails', async () => {
    const recordSeparator = '\u001e';
    const fieldSeparator = '\u001f';
    const statSeparator = '\u001d';
    let activeGitCalls = 0;
    let maxActiveGitCalls = 0;
    const repos = Array.from({ length: 6 }, (_, index) => ({
      id: `repo-${index}`,
      name: `repo-${index}`,
      localPath: `/tmp/repo-${index}`,
    }));
    listRepos.mockResolvedValue(repos);
    execFile.mockImplementation((...args: unknown[]) => {
      const gitArgs = args[1] as string[];
      const callback = args[args.length - 1] as (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => void;
      const repoPath = gitArgs[1] ?? '';
      const index = Number.parseInt(repoPath.slice(repoPath.lastIndexOf('-') + 1), 10);
      activeGitCalls += 1;
      maxActiveGitCalls = Math.max(maxActiveGitCalls, activeGitCalls);
      setTimeout(() => {
        activeGitCalls -= 1;
        if (index === 2) {
          callback(new Error('repo unavailable'), '', '');
          return;
        }
        const sha = String(index).repeat(40);
        callback(null, `${recordSeparator}${sha}${fieldSeparator}refs/heads/main${fieldSeparator}parent${fieldSeparator}Author ${index}${fieldSeparator}Commit ${index}${fieldSeparator}2026-07-30T18:0${index}:00.000Z${statSeparator}\n1\t0\tfile-${index}.ts`,
          '');
      }, 5);
    });

    const response = await GET(new Request('http://localhost:3001/api/mobile/activity'));
    const payload = await response.json();

    // Receipts + day-count query per repo, still four repos at a time.
    expect(execFile).toHaveBeenCalledTimes(12);
    expect(maxActiveGitCalls).toBe(4);
    expect(payload.events).toHaveLength(5);
    expect(payload.events.map((event: { repoId?: string }) => event.repoId)).not.toContain('repo-2');
  });
});
