import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureSharedCheckoutTeam, finishSharedCheckoutTeam, inspectSharedCheckoutTeam, readSharedCheckoutTeam, recordSharedCheckoutMember, reconcileSharedCheckoutTeam, reserveSharedCheckoutMember } from './shared-checkout-team';
import { findOwnedLaunchByMutationId, ownedRoots } from '@/lib/runtimes/shared/owned-session-index';

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-shared-team-'));
  roots.push(root);
  const repoPath = join(root, 'repo');
  mkdirSync(repoPath);
  git(repoPath, 'init', '-b', 'main');
  writeFileSync(join(repoPath, 'README.md'), '# fixture\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, '-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'fixture');
  return { root, repoPath };
}

afterEach(() => {
  vi.unstubAllEnvs();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('shared checkout team', () => {
  it('gives two workers from one orchestrator one durable checkout and distinct members', async () => {
    const { root, repoPath } = fixture();
    const input = { repoPath, parentThreadId: 'thoughts-team-a', dataDir: join(root, 'state') };
    const teams = await Promise.all(Array.from({ length: 10 }, () => ensureSharedCheckoutTeam(input)));
    const first = teams[0]!;
    expect(first.path).toBe(realpathSync(repoPath));
    expect(teams.every((team) => team.path === first.path && team.baseHead === first.baseHead)).toBe(true);
    expect(first.branch).toBe('main');
    expect(git(first.path, 'rev-parse', '--show-toplevel')).toBe(first.path);
    expect(git(first.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(first.branch);

    await reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'A', clientMutationId: 'a', paths: ['src/a'] });
    await reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'B', clientMutationId: 'b', paths: ['src/b'] });
    await recordSharedCheckoutMember({ ...input, surfaceId: 'codex-owned:a', runtime: 'codex', taskName: 'A', clientMutationId: 'a' });
    await recordSharedCheckoutMember({ ...input, surfaceId: 'codex-owned:b', runtime: 'codex', taskName: 'B', clientMutationId: 'b' });
    const restored = readSharedCheckoutTeam(input);
    expect(restored?.members.map((member) => member.surfaceId)).toEqual(['codex-owned:a', 'codex-owned:b']);
    await expect(reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'C', clientMutationId: 'c', paths: ['src/a/file.ts'] }))
      .rejects.toThrow(/overlaps worker A/);
    mkdirSync(join(repoPath, 'src'));
    writeFileSync(join(repoPath, 'src', 'a'), 'A\n');
    writeFileSync(join(repoPath, 'src', 'outside'), 'outside\n');
    expect(inspectSharedCheckoutTeam(input)).toMatchObject({
      newPaths: ['src/a', 'src/outside'],
      outsideClaims: ['src/outside'],
      scopeClean: false,
      baselineClean: true,
    });
  });

  it('holds another orchestrator from the same checkout and fails if ownership drifts', async () => {
    const { root, repoPath } = fixture();
    const dataDir = join(root, 'state');
    const first = await ensureSharedCheckoutTeam({ repoPath, parentThreadId: 'thoughts-a', dataDir });
    await reserveSharedCheckoutMember({ repoPath, parentThreadId: 'thoughts-a', dataDir,
      runtime: 'codex', taskName: 'Unconfirmed launch', clientMutationId: 'unconfirmed', paths: ['src/a'] });
    await expect(ensureSharedCheckoutTeam({ repoPath, parentThreadId: 'thoughts-b', dataDir }))
      .rejects.toThrow(/owned by orchestrator thoughts-a/);
    git(first.path, 'checkout', '--detach');
    await expect(ensureSharedCheckoutTeam({ repoPath, parentThreadId: 'thoughts-a', dataDir }))
      .rejects.toThrow(/branch changed/);
  });

  it('protects existing dirty files and notices commits outside assigned worker paths', async () => {
    const { root, repoPath } = fixture();
    mkdirSync(join(repoPath, 'src'));
    writeFileSync(join(repoPath, 'src', 'existing'), 'operator edit\n');
    const input = { repoPath, parentThreadId: 'thoughts-team-a', dataDir: join(root, 'state') };
    await ensureSharedCheckoutTeam(input);
    await expect(reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'A', clientMutationId: 'a', paths: ['src'] }))
      .rejects.toThrow(/dirty before the team/);
    await reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'A', clientMutationId: 'a', paths: ['docs/a'] });
    writeFileSync(join(repoPath, 'outside.md'), 'outside\n');
    git(repoPath, 'add', 'outside.md');
    git(repoPath, '-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'Outside');
    expect(inspectSharedCheckoutTeam(input)?.outsideClaims).toEqual(['outside.md']);
  });

  it('rejects dirty and committed renames from outside a worker claim', async () => {
    const { root, repoPath } = fixture();
    const input = { repoPath, parentThreadId: 'thoughts-rename', dataDir: join(root, 'state') };
    const ownedRoot = join(root, 'owned-codex');
    vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', ownedRoot);
    await reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'Rename', clientMutationId: 'rename', paths: ['inside.txt'] });
    await recordSharedCheckoutMember({ ...input, surfaceId: 'codex-owned:rename', runtime: 'codex', taskName: 'Rename', clientMutationId: 'rename' });
    mkdirSync(join(ownedRoot, 'rename'), { recursive: true });
    writeFileSync(join(ownedRoot, 'rename', 'session.json'), JSON.stringify({
      surfaceId: 'codex-owned:rename', cwd: realpathSync(repoPath), repoPath: realpathSync(repoPath),
      launchMutationId: 'rename', recentRuns: [{ outcome: 'finished' }],
    }));
    git(repoPath, 'config', 'diff.renames', 'true');
    git(repoPath, 'mv', 'README.md', 'inside.txt');
    expect(inspectSharedCheckoutTeam(input)).toMatchObject({
      newPaths: ['README.md', 'inside.txt'], outsideClaims: ['README.md'], scopeClean: false,
    });
    git(repoPath, '-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'Rename into claimed scope');
    expect(inspectSharedCheckoutTeam(input)).toMatchObject({
      committedPaths: ['README.md', 'inside.txt'], outsideClaims: ['README.md'], scopeClean: false,
    });
    await expect(finishSharedCheckoutTeam({ ...input, reviewSummary: 'Reviewed rename.', verification: 'Fixture inspected.' }))
      .rejects.toThrow(/outside worker scopes.*README.md/);
    expect(readSharedCheckoutTeam(input)?.members).toHaveLength(1);
  });

  it('rejects a path scope that resolves outside the checkout', async () => {
    const { root, repoPath } = fixture();
    const input = { repoPath, parentThreadId: 'thoughts-team-a', dataDir: join(root, 'state') };
    symlinkSync(root, join(repoPath, 'elsewhere'));
    await ensureSharedCheckoutTeam(input);
    await expect(reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'A', clientMutationId: 'a', paths: ['elsewhere/output'] }))
      .rejects.toThrow(/escapes the checkout/);
  });

  it('does not claim the checkout when the first reservation is invalid', async () => {
    const { root, repoPath } = fixture();
    const input = { repoPath, parentThreadId: 'thoughts-team-a', dataDir: join(root, 'state') };
    mkdirSync(join(repoPath, 'src'));
    writeFileSync(join(repoPath, 'src', 'existing'), 'operator edit\n');
    await expect(reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'A', clientMutationId: 'a', paths: ['src'] }))
      .rejects.toThrow(/dirty before the team/);
    expect(readSharedCheckoutTeam(input)).toBeNull();
    symlinkSync(root, join(repoPath, 'elsewhere'));
    await expect(reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'B', clientMutationId: 'b', paths: ['elsewhere/output'] }))
      .rejects.toThrow(/escapes the checkout/);
    expect(readSharedCheckoutTeam(input)).toBeNull();
  });

  it('detects changes to pre-existing operator edits even when their paths remain dirty', async () => {
    const { root, repoPath } = fixture();
    writeFileSync(join(repoPath, 'operator.txt'), 'original edit\n');
    const input = { repoPath, parentThreadId: 'thoughts-team-a', dataDir: join(root, 'state') };
    await reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'A', clientMutationId: 'a', paths: ['src/a'] });
    expect(inspectSharedCheckoutTeam(input)?.baselineDrift).toEqual([]);
    writeFileSync(join(repoPath, 'operator.txt'), 'worker changed operator edit\n');
    expect(inspectSharedCheckoutTeam(input)).toMatchObject({ baselineDrift: ['operator.txt'], scopeClean: false });
  });

  it('detects an index-only change to a persisted dirty baseline with unchanged status and working bytes', async () => {
    const { root, repoPath } = fixture();
    const path = join(repoPath, 'README.md');
    writeFileSync(path, '# first staged snapshot\n');
    git(repoPath, 'add', 'README.md');
    writeFileSync(path, '# unchanged working snapshot\n');
    const input = { repoPath, parentThreadId: 'thoughts-index-baseline', dataDir: join(root, 'state') };
    const initial = await ensureSharedCheckoutTeam(input);
    const persisted = readSharedCheckoutTeam(input);
    expect(persisted?.initialChangedPaths).toEqual(['README.md']);
    expect(persisted?.initialChangedFingerprints['README.md']).toMatch(/^index-v2:[0-9a-f]{64}$/);
    expect(persisted?.initialChangedFingerprints).toEqual(initial.initialChangedFingerprints);
    expect((await ensureSharedCheckoutTeam(input)).initialChangedFingerprints).toEqual(initial.initialChangedFingerprints);
    expect(inspectSharedCheckoutTeam(input)).toMatchObject({ baselineDrift: [], baselineUnverifiable: [], scopeClean: true });

    const status = git(repoPath, 'status', '--porcelain', '--', 'README.md');
    const workingDiff = git(repoPath, 'diff', '--binary', 'HEAD', '--', 'README.md');
    const head = git(repoPath, 'rev-parse', 'HEAD');
    const working = readFileSync(path);
    const mode = lstatSync(path).mode;
    const staged = git(repoPath, 'show', ':README.md');
    const indexMode = git(repoPath, 'ls-files', '--stage', '--', 'README.md').split(' ')[0]!;
    expect(status).toBe('MM README.md');
    const replacement = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: repoPath, encoding: 'utf8', input: '# second staged snapshot\n',
    }).trim();
    git(repoPath, 'update-index', '--cacheinfo', indexMode, replacement, 'README.md');

    expect(git(repoPath, 'show', ':README.md')).not.toBe(staged);
    expect(git(repoPath, 'status', '--porcelain', '--', 'README.md')).toBe(status);
    expect(git(repoPath, 'diff', '--binary', 'HEAD', '--', 'README.md')).toBe(workingDiff);
    expect(git(repoPath, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(path)).toEqual(working);
    expect(lstatSync(path).mode).toBe(mode);
    expect((await ensureSharedCheckoutTeam(input)).initialChangedFingerprints).toEqual(initial.initialChangedFingerprints);
    expect(readSharedCheckoutTeam(input)?.initialChangedFingerprints).toEqual(initial.initialChangedFingerprints);
    expect(inspectSharedCheckoutTeam(input)).toMatchObject({ baselineDrift: ['README.md'], baselineUnverifiable: [], scopeClean: false });
    const indexPath = git(repoPath, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const index = readFileSync(indexPath);
    const receiptPath = join(input.dataDir, 'shared-checkout-teams', `${initial.id}.json`);
    const receipt = readFileSync(receiptPath);
    await expect(finishSharedCheckoutTeam({
      ...input, reviewSummary: 'Review detected a staged baseline change.', verification: 'Index-only fixture inspected.',
    })).rejects.toThrow(/Pre-existing operator edits changed.*README.md/);
    expect(readSharedCheckoutTeam(input)).toEqual(persisted);
    expect(readFileSync(receiptPath)).toEqual(receipt);
    expect(readFileSync(indexPath)).toEqual(index);
    expect(readFileSync(path)).toEqual(working);
    expect(git(repoPath, 'rev-parse', 'HEAD')).toBe(head);
  });

  it.each(['unversioned', 'missing', 'unknown', 'malformed', 'trailing-newline', 'wrong-type'] as const)('holds a %s persisted fingerprint as unverifiable without rewriting the receipt', async (format) => {
    const { root, repoPath } = fixture();
    writeFileSync(join(repoPath, 'README.md'), '# operator edit\n');
    const input = { repoPath, parentThreadId: 'thoughts-legacy-baseline', dataDir: join(root, 'state') };
    const initial = await ensureSharedCheckoutTeam(input);
    const legacy = {
      ...initial,
      initialChangedFingerprints: format === 'missing' ? {} : {
        'README.md': format === 'unversioned' ? '0'.repeat(64)
          : format === 'unknown' ? `index-v3:${'0'.repeat(64)}`
            : format === 'trailing-newline' ? `index-v2:${'0'.repeat(64)}\n`
              : format === 'wrong-type' ? [`index-v2:${'0'.repeat(64)}`] : 'index-v2:not-a-digest',
      },
    };
    const receiptPath = join(input.dataDir, 'shared-checkout-teams', `${initial.id}.json`);
    const receipt = `${JSON.stringify(legacy, null, 2)}\n`;
    writeFileSync(receiptPath, receipt);
    const indexPath = git(repoPath, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const index = readFileSync(indexPath);
    const working = readFileSync(join(repoPath, 'README.md'));
    const head = git(repoPath, 'rev-parse', 'HEAD');
    expect(await ensureSharedCheckoutTeam(input)).toEqual(legacy);
    expect(inspectSharedCheckoutTeam(input)).toMatchObject({
      baselineUnverifiable: ['README.md'], baselineDrift: [], scopeClean: false,
    });
    await expect(finishSharedCheckoutTeam({
      ...input, reviewSummary: 'Legacy baseline needs review.', verification: 'Persisted receipt inspected.',
    })).rejects.toThrow(/cannot be verified.*README.md/i);
    expect(readFileSync(receiptPath, 'utf8')).toBe(receipt);
    expect(readSharedCheckoutTeam(input)).toEqual(legacy);
    expect(readFileSync(indexPath)).toEqual(index);
    expect(readFileSync(join(repoPath, 'README.md'))).toEqual(working);
    expect(git(repoPath, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('finishes an unverifiable legacy baseline only after an explicit reconciliation', async () => {
    const { root, repoPath } = fixture();
    writeFileSync(join(repoPath, 'README.md'), '# operator edit\n');
    const input = { repoPath, parentThreadId: 'thoughts-legacy-reconcile', dataDir: join(root, 'state') };
    const initial = await ensureSharedCheckoutTeam(input);
    const receiptPath = join(input.dataDir, 'shared-checkout-teams', `${initial.id}.json`);
    writeFileSync(receiptPath, `${JSON.stringify({ ...initial, initialChangedFingerprints: { 'README.md': '0'.repeat(64) } }, null, 2)}\n`);
    const finish = () => finishSharedCheckoutTeam({
      ...input, reviewSummary: 'Legacy baseline reviewed.', verification: 'Receipt and working file inspected.',
    });
    await expect(finish()).rejects.toThrow(/cannot be verified.*README.md/i);
    const status = inspectSharedCheckoutTeam(input)!;
    expect(status.baselineUnverifiable).toEqual(['README.md']);
    const receipt = await reconcileSharedCheckoutTeam({ ...input, reviewId: status.review.id, reviewedHead: status.review.head,
      acknowledgedPaths: status.review.paths, reviewSummary: 'Operator reviewed the legacy README edit.' });
    expect(receipt.paths).toContain('README.md');
    await expect(finish()).resolves.toBeDefined();
  });

  it('can finish an unchanged versioned dirty baseline', async () => {
    const { root, repoPath } = fixture();
    const path = join(repoPath, 'README.md');
    writeFileSync(path, '# staged edit\n');
    git(repoPath, 'add', 'README.md');
    writeFileSync(path, '# working edit\n');
    const input = { repoPath, parentThreadId: 'thoughts-unchanged-baseline', dataDir: join(root, 'state') };
    const initial = await ensureSharedCheckoutTeam(input);
    expect(initial.initialChangedFingerprints['README.md']).toMatch(/^index-v2:[0-9a-f]{64}$/);
    expect(inspectSharedCheckoutTeam(input)).toMatchObject({ baselineUnverifiable: [], baselineDrift: [], scopeClean: true });
    const indexPath = git(repoPath, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
    const index = readFileSync(indexPath);
    const working = readFileSync(path);
    const result = await finishSharedCheckoutTeam({
      ...input, reviewSummary: 'Unchanged baseline reviewed.', verification: 'Index and working snapshot unchanged.',
    });
    expect(result.team).toEqual(initial);
    expect(readSharedCheckoutTeam(input)).toBeNull();
    expect(readFileSync(indexPath)).toEqual(index);
    expect(readFileSync(path)).toEqual(working);
    expect(git(repoPath, 'rev-parse', 'HEAD')).toBe(initial.baseHead);
  });

  it('can finish an unchanged legacy receipt with no dirty baseline paths', async () => {
    const { root, repoPath } = fixture();
    const input = { repoPath, parentThreadId: 'thoughts-empty-baseline', dataDir: join(root, 'state') };
    const initial = await ensureSharedCheckoutTeam(input);
    expect(initial.initialChangedPaths).toEqual([]);
    expect(initial.initialChangedFingerprints).toEqual({});
    expect(inspectSharedCheckoutTeam(input)).toMatchObject({
      baselineUnverifiable: [], baselineDrift: [], scopeClean: true,
    });
    const result = await finishSharedCheckoutTeam({
      ...input, reviewSummary: 'No baseline edits or workers.', verification: 'Empty baseline inspected.',
    });
    expect(result.team).toEqual(initial);
    expect(readSharedCheckoutTeam(input)).toBeNull();
  });

  it('releases ownership only after the owned worker settles and its scoped edits are reviewed and committed', async () => {
    const { root, repoPath } = fixture();
    const input = { repoPath, parentThreadId: 'thoughts-team-a', dataDir: join(root, 'state') };
    const ownedRoot = join(root, 'owned-codex');
    vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', ownedRoot);
    await ensureSharedCheckoutTeam(input);
    await reserveSharedCheckoutMember({ ...input, runtime: 'codex', taskName: 'A', clientMutationId: 'a', paths: ['src/a'] });
    await recordSharedCheckoutMember({ ...input, surfaceId: 'codex-owned:a', runtime: 'codex', taskName: 'A', clientMutationId: 'a' });
    mkdirSync(join(ownedRoot, 'a'), { recursive: true });
    const sessionPath = join(ownedRoot, 'a', 'session.json');
    const session = { surfaceId: 'codex-owned:a', cwd: realpathSync(repoPath), repoPath: realpathSync(repoPath), launchMutationId: 'a' };
    writeFileSync(sessionPath, JSON.stringify({ ...session, activeRun: { pid: 123, outcome: 'running' } }));
    expect(ownedRoots()[0]?.root).toBe(ownedRoot);
    expect(await findOwnedLaunchByMutationId('a')).toMatchObject({ surfaceId: 'codex-owned:a', outcome: 'running' });
    const finish = { ...input, reviewSummary: 'Reviewed worker A diff.', verification: 'Focused test passed.' };
    await expect(finishSharedCheckoutTeam(finish)).rejects.toThrow(/still active/);
    writeFileSync(sessionPath, JSON.stringify({ ...session, recentRuns: [{ outcome: 'finished' }] }));
    mkdirSync(join(repoPath, 'src'));
    writeFileSync(join(repoPath, 'src', 'a'), 'A\n');
    await expect(finishSharedCheckoutTeam(finish)).rejects.toThrow(/uncommitted/);
    git(repoPath, 'add', 'src/a');
    git(repoPath, '-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-m', 'Add A');
    expect(inspectSharedCheckoutTeam(input)?.committedPaths).toEqual(['src/a']);
    const archiveRoot = `${ownedRoot}-archive`;
    mkdirSync(archiveRoot);
    renameSync(join(ownedRoot, 'a'), join(archiveRoot, 'a'));
    expect(await findOwnedLaunchByMutationId('a')).toMatchObject({ surfaceId: 'codex-owned:a', outcome: 'finished' });
    const result = await finishSharedCheckoutTeam(finish);
    expect(result.committedPaths).toEqual(['src/a']);
    expect(readSharedCheckoutTeam(input)).toBeNull();
    expect((await ensureSharedCheckoutTeam({ ...input, parentThreadId: 'thoughts-team-b' })).parentThreadId)
      .toBe('thoughts-team-b');
  });
});
