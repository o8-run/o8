import { childEnvironment } from '@/lib/providers/spawn-environment';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { access, realpath } from 'node:fs/promises';
import { execFile } from '@/lib/providers/child-process';
import { isAbsolute, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import {
  addRepo,
  listRepos,
  touchRepo,
  updateRepo,
  validateRepo,
} from '@/lib/repos/registry';
import { cloneRepoToDefaultLocation, RepoCloneError } from '@/lib/repos/clone';
import { removeRepoPathFromProjects, repointRepoPathInProjects } from '@/lib/repos/project-path-mutations';
import { removeRepoFromPool } from '@/lib/repos/remove';
import { stopRepoBoundRuntimeSessions } from '@/lib/repos/runtime-removal';
import {
  enrichRepoReadiness,
  enrichRepoReadinessFromCache,
  enrichRepoReadinessFresh,
  invalidateRepoReadiness,
} from '@/lib/repos/readiness';
import { repointRepoPathReferences } from '@/lib/repos/path-repoint';
import { assertOrchestratorRepoPath } from '@/lib/lane/repo-preflight';
import { isOrchestratorHomePath } from '@/lib/orchestrator/repo-path';
import { clearRepo as clearSkeletonCache } from '@/lib/skeleton/store';
import { triggerScan, triggerScanIfStale, startChangePolling, stopChangePolling } from '@/lib/skeleton/autoscan';
import { invalidateAnswerCache } from '@/lib/cortex/qa/ask';
import { invalidateCommandCenterSnapshotCaches } from '@/lib/command-center/snapshot';
import { invalidateInboxCache } from '@/lib/mobile/inbox';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import type {
  RepoRegistryDeleteBody,
  RepoRegistryPostBody,
} from '@/lib/repos/types';
import { withRepoInventoryChange } from '@/lib/repos/inventory-change-publish';

const execFileAsync = promisify(execFile);

async function pathExists(localPath: string) {
  try {
    await access(localPath);
    return true;
  } catch {
    return false;
  }
}

async function appendExistence<T extends { localPath: string }>(repo: T): Promise<T & { exists: boolean }> {
  return { ...repo, exists: await pathExists(repo.localPath) };
}

function isWithinRealRoot(root: string, candidate: string) {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  );
}

async function realpathOrNull(localPath: string) {
  try {
    return await realpath(localPath);
  } catch {
    return null;
  }
}

async function validateRestorePaths(
  requestedPaths: string[],
  registeredRepos: Array<{ localPath: string }>,
) {
  const registeredPaths = Array.from(new Set(registeredRepos
    .map((repo) => repo.localPath.trim())
    .filter((localPath) => isAbsolute(localPath))));
  const uniqueRequestedPaths = Array.from(new Set(requestedPaths
    .map((requestedPath) => requestedPath.trim())
    .filter((requestedPath) => isAbsolute(requestedPath))));
  const [registeredRealPaths, requested] = await Promise.all([
    Promise.all(registeredPaths.map(realpathOrNull))
      .then((paths) => paths.filter((localPath): localPath is string => Boolean(localPath))),
    Promise.all(uniqueRequestedPaths.map(async (requestedPath) => ({
      requestedPath,
      canonicalPath: await realpathOrNull(requestedPath),
    }))),
  ]);

  // Fast path: a saved scope inside a registered root is authorized by the
  // registry alone, so no git subprocess runs for the common case (#2456).
  const settledByRegistry = new Set(requested
    .filter(({ canonicalPath }) => canonicalPath !== null
      && registeredRealPaths.some((root) => isWithinRealRoot(root, canonicalPath)))
    .map(({ requestedPath }) => requestedPath));
  const needsWorktreeList = requested.some(({ requestedPath, canonicalPath }) => (
    canonicalPath !== null && !settledByRegistry.has(requestedPath)
  ));

  let worktreeRealPaths: string[] = [];
  if (needsWorktreeList) {
    const listedWorktreePaths = (await Promise.all(registeredRealPaths.map(async (registeredRoot) => {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['-C', registeredRoot, 'worktree', 'list', '--porcelain', '-z'],
          { windowsHide: true, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
        );
        return stdout
          .split('\0')
          .filter((field) => field.startsWith('worktree '))
          .map((field) => field.slice('worktree '.length))
          .filter((localPath) => isAbsolute(localPath));
      } catch {
        return [];
      }
    }))).flat();
    worktreeRealPaths = (await Promise.all(listedWorktreePaths.map(realpathOrNull)))
      .filter((localPath): localPath is string => Boolean(localPath));
  }

  return requested.flatMap(({ requestedPath, canonicalPath }) => {
    if (canonicalPath === null) return [];
    if (settledByRegistry.has(requestedPath)
      || worktreeRealPaths.some((root) => isWithinRealRoot(root, canonicalPath))) {
      return [{ requestedPath, canonicalPath }];
    }
    return [];
  });
}

/** List the authenticated user's GitHub repositories via the `gh` CLI — the
 *  app's GitHub auth source (see /api/panel/github-status, which reads
 *  `gh auth status`). Returns the raw GitHub API shape (full_name, clone_url,
 *  description, language, private, default_branch, …) that the onboarding repo
 *  picker (OnboardingReposStep) renders + clones from. Without this, the route
 *  fell through to the LOCAL registry (no `full_name`), so the picker rendered
 *  blank rows. */
async function listGithubRepos(limit: number): Promise<unknown[]> {
  const perPage = Math.min(100, Math.max(1, Math.trunc(limit) || 50));
  const { stdout } = await execFileAsync(
    'gh',
    ['api', `/user/repos?per_page=${perPage}&sort=updated&affiliation=owner,collaborator,organization_member`],
    { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024, env: childEnvironment({ env: { GH_NO_UPDATE_NOTIFIER: '1' } }) },
  );
  const parsed = JSON.parse(stdout) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

export async function GET(request: Request) {
  const startedAt = performance.now();
  const params = new URL(request.url).searchParams;

  // Onboarding repo picker asks for the user's GitHub repos (source=github);
  // everything else wants the local repo registry.
  if (params.get('source') === 'github') {
    try {
      const repos = await listGithubRepos(Number(params.get('limit')) || 50);
      return NextResponse.json({ repos }, { headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } });
    } catch (error) {
      console.error('[repos] github list failed', error);
      return NextResponse.json(
        { error: 'Couldn’t list your GitHub repositories. Make sure GitHub is connected on this machine, then retry.' },
        { status: 502, headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } },
      );
    }
  }

  try {
    const registryStartedAt = performance.now();
    const registeredRepos = await listRepos();
    const registryDurationMs = performance.now() - registryStartedAt;
    const requestedRestorePaths = params.getAll('restorePath');
    if (params.get('restoreValidationOnly') === '1') {
      const validationStartedAt = performance.now();
      const validatedRestorePaths = await validateRestorePaths(requestedRestorePaths, registeredRepos);
      const validationDurationMs = performance.now() - validationStartedAt;
      return NextResponse.json(
        { validatedRestorePaths },
        {
          headers: {
            'Server-Timing': [
              `registry;dur=${registryDurationMs.toFixed(1)}`,
              `validation;dur=${validationDurationMs.toFixed(1)}`,
              `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}`,
            ].join(', '),
          },
        },
      );
    }
    const readinessStartedAt = performance.now();
    const readinessSelector = params.get('readiness');
    let repos;

    if (readinessSelector) {
      if (!registeredRepos.some((repo) => repo.id === readinessSelector)) {
        return NextResponse.json(
          { error: 'Registered repository not found.' },
          { status: 404, headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } },
        );
      }
      repos = await Promise.all(registeredRepos.map((repo) => (
        repo.id === readinessSelector
          ? enrichRepoReadinessFresh(repo)
          : Promise.resolve(enrichRepoReadinessFromCache(repo))
      )));
    } else {
      // Discovery is fleet-sized and runs on dashboard startup. Surface any
      // readiness already known in this server process, but do not launch Git
      // subprocesses for every registered repo. Exact checks are opt-in above.
      repos = registeredRepos.map(enrichRepoReadinessFromCache);
    }
    const readinessDurationMs = performance.now() - readinessStartedAt;
    const existenceStartedAt = performance.now();
    const [responseRepos, validatedRestorePaths] = await Promise.all([
      Promise.all(repos.map(appendExistence)),
      requestedRestorePaths.length > 0
        ? validateRestorePaths(requestedRestorePaths, registeredRepos)
        : Promise.resolve([]),
    ]);
    const existenceDurationMs = performance.now() - existenceStartedAt;
    return NextResponse.json(
      { repos: responseRepos, validatedRestorePaths },
      {
        headers: {
          'Server-Timing': [
            `registry;dur=${registryDurationMs.toFixed(1)}`,
            `readiness;dur=${readinessDurationMs.toFixed(1)}`,
            `existence;dur=${existenceDurationMs.toFixed(1)}`,
            `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}`,
          ].join(', '),
        },
      },
    );
  } catch (error) {
    console.error('[api] panel/repos failed:', error);
    return NextResponse.json(
      { error: 'Unable to load repository registry.' },
      { status: 500, headers: { 'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}` } },
    );
  }
}

async function handlePOST(request: Request) {
  let body: RepoRegistryPostBody;
  try {
    body = (await request.json()) as RepoRegistryPostBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  try {
    const action = body.action ?? 'add';

    switch (action) {
      case 'validate': {
        if (!('localPath' in body) || !body.localPath?.trim()) {
          return NextResponse.json({ error: 'localPath is required.' }, { status: 400 });
        }
        const repo = await enrichRepoReadiness(await validateRepo(body.localPath));
        return NextResponse.json({ repo });
      }
      case 'add': {
        if (!('localPath' in body) || !body.localPath?.trim()) {
          return NextResponse.json({ error: 'localPath is required.' }, { status: 400 });
        }
        if (isOrchestratorHomePath(body.localPath)) {
          return NextResponse.json({ error: 'Home mode is not a registered repository.' }, { status: 400 });
        }
        // Registration is durable once addRepo resolves. A cold readiness probe
        // can spawn several Git checks, so leave it to the explicit selected-repo
        // GET rather than holding this POST (and the subsequent project link).
        const registered = await addRepo(body.localPath);
        const repo = { ...enrichRepoReadinessFromCache(registered), exists: true };
        // Auto-scan skeleton for newly added repo + start change polling
        triggerScan(repo.localPath);
        startChangePolling(repo.localPath);
        return NextResponse.json({ repo }, { status: 201 });
      }
      case 'clone': {
        // #1339 — onboarding GitHub selections used to POST { cloneUrl } into a
        // handler with no clone case (400 localPath required, swallowed client-side).
        if (!('cloneUrl' in body) || !body.cloneUrl?.trim()) {
          return NextResponse.json({ error: 'cloneUrl is required.' }, { status: 400 });
        }
        try {
          const { localPath } = await cloneRepoToDefaultLocation(body.cloneUrl, 'name' in body ? body.name : undefined);
          const repo = await enrichRepoReadiness(await addRepo(localPath));
          triggerScan(repo.localPath);
          startChangePolling(repo.localPath);
          return NextResponse.json({ repo }, { status: 201 });
        } catch (error) {
          if (error instanceof RepoCloneError) {
            return NextResponse.json({ error: error.message }, { status: error.statusCode });
          }
          throw error;
        }
      }
      case 'update': {
        if (!('id' in body) || !body.id) {
          return NextResponse.json({ error: 'id is required.' }, { status: 400 });
        }
        if ('localPath' in body && body.localPath !== undefined && (typeof body.localPath !== 'string' || !body.localPath.trim())) {
          return NextResponse.json({ error: 'localPath must be a Git repository folder.' }, { status: 400 });
        }
        if ('localPath' in body && body.localPath !== undefined) {
          if (isOrchestratorHomePath(body.localPath)) {
            return NextResponse.json({ error: 'Home mode is not a registered repository.' }, { status: 400 });
          }
          try {
            assertOrchestratorRepoPath(body.localPath);
          } catch (error) {
            return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid repository folder.' }, { status: 400 });
          }
        }
        const previous = (await listRepos()).find((repo) => repo.id === body.id);
        if ('storagePressureParkingDisabled' in body
          && body.storagePressureParkingDisabled !== undefined
          && typeof body.storagePressureParkingDisabled !== 'boolean') {
          return NextResponse.json({ error: 'storagePressureParkingDisabled must be a boolean.' }, { status: 400 });
        }
        const repo = await updateRepo(body.id, {
          localPath: 'localPath' in body ? body.localPath : undefined,
          setup: 'setup' in body ? body.setup : undefined,
          lastOpenedAt: 'lastOpenedAt' in body ? body.lastOpenedAt : undefined,
          storagePressureParkingDisabled: 'storagePressureParkingDisabled' in body
            ? body.storagePressureParkingDisabled
            : undefined,
        });
        if (previous && previous.localPath !== repo.localPath) {
          await repointRepoPathInProjects(previous.localPath, repo.localPath);
          repointRepoPathReferences(previous.localPath, repo.localPath);
          invalidateRepoReadiness(previous.localPath, repo.localPath);
          invalidateAnswerCache();
          clearSkeletonCache(previous.localPath);
          stopChangePolling(previous.localPath);
          triggerScan(repo.localPath);
          startChangePolling(repo.localPath);
        }
        return NextResponse.json({ repo: await enrichRepoReadiness(repo) });
      }
      case 'touch': {
        if (!('id' in body) || !body.id) {
          return NextResponse.json({ error: 'id is required.' }, { status: 400 });
        }
        const repo = await touchRepo(
          body.id,
          'lastOpenedAt' in body ? body.lastOpenedAt ?? undefined : undefined,
        );
        // Rescan skeleton if stale when repo is opened
        triggerScanIfStale(repo.localPath);
        return NextResponse.json({ repo: await enrichRepoReadiness(repo) });
      }
      default:
        return NextResponse.json({ error: 'Unsupported action.' }, { status: 400 });
    }
  } catch (error) {
    console.error('[api] panel/repos failed:', error);
    return NextResponse.json(
      { error: 'Unable to update repository registry.' },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  let body: RepoRegistryDeleteBody;
  try {
    body = (await request.json()) as RepoRegistryDeleteBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (!body.id) {
    return NextResponse.json({ error: 'id is required.' }, { status: 400 });
  }

  try {
    // Look up localPath before removal so the realtime note + runtime cleanup
    // below can reference the repo record.
    const repos = await listRepos();
    const toRemove = repos.find(r => r.id === body.id);

    const cleanup = toRemove
      ? await stopRepoBoundRuntimeSessions(toRemove)
      : {
          ok: true,
          targetedSessionCount: 0,
          stoppedSessionCount: 0,
          removedTerminalBindings: 0,
          note: 'No registered repository was found.',
        };
    if (!cleanup.ok) {
      return NextResponse.json({
        ok: false,
        error: 'repo_runtime_stop_unconfirmed',
        note: cleanup.note,
        stoppedSessions: cleanup,
      }, { status: 409 });
    }

    // Registry + SQLite links + lifecycle + terminal state + skeleton cache +
    // polling all go through the shared removal flow (also used by project
    // deletion). Ledger cleanup stays here.
    const removed = await removeRepoFromPool(body.id);
    if (toRemove?.localPath) {
      await removeRepoPathFromProjects(toRemove.localPath);
    }

    invalidateCommandCenterSnapshotCaches();
    invalidateInboxCache();
    await publishRealtimeMutation({
      mutation: {
        mutationId: `repo-remove-${body.id}-${Date.now()}`,
        source: 'desktop',
        action: 'stop',
        runtime: 'repo-registry',
        surfaceId: body.id,
        sessionKey: toRemove?.localPath,
        status: 'completed',
        note: toRemove
          ? `Stopped ${cleanup.stoppedSessionCount} repo-bound runtime session(s) and removed ${toRemove.name} from Cortex.`
          : 'Repository removed from Cortex.',
        createdAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      },
      refreshTargets: ['global', 'mobileInbox', 'sessionHistory'],
      fresh: true,
    });

    return NextResponse.json({
      ok: true,
      removedId: body.id,
      stoppedSessions: {
        targetedSessionCount: cleanup.targetedSessionCount,
        stoppedSessionCount: cleanup.stoppedSessionCount,
        removedTerminalBindings: removed.removedTerminalBindings + cleanup.removedTerminalBindings,
        cleanupPending: false,
      },
    });
  } catch (error) {
    console.error('[api] panel/repos failed:', error);
    return NextResponse.json(
      { error: 'Unable to remove repository.' },
      { status: 500 },
    );
  }
}

export const POST = withRepoInventoryChange('repo-register', handlePOST);
