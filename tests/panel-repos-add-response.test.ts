import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';

// A stalled readiness probe must not hold the already-persisted add response.
const readinessGate = vi.hoisted(() => ({
  hold: false,
  release: null as (() => void) | null,
}));
vi.mock('@/lib/repos/readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repos/readiness')>();
  return {
    ...actual,
    enrichRepoReadiness: async (repo: Parameters<typeof actual.enrichRepoReadiness>[0]) => {
      if (readinessGate.hold) {
        await new Promise<void>((resolve) => { readinessGate.release = resolve; });
      }
      return actual.enrichRepoReadiness(repo);
    },
  };
});

const previousHome = process.env.HOME;
const previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
const previousO8DataDir = process.env.O8_DATA_DIR;
const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-repo-add-response-')));
const dataDir = path.join(home, '.o8-data');
const repoPath = path.join(home, 'repo');
process.env.HOME = home;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
mkdirSync(dataDir, { recursive: true });
mkdirSync(repoPath, { recursive: true });
writeFileSync(path.join(repoPath, 'README.md'), 'fixture\n');
execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);

const reposRoute = await import('@/app/api/panel/repos/route');
const projectRoute = await import('@/app/api/panel/projects/[id]/route');

afterAll(() => {
  readinessGate.release?.();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
  if (previousO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = previousO8DataDir;
});

function postAdd() {
  return reposRoute.POST(new Request('http://localhost/api/panel/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add', localPath: repoPath }),
  }));
}

it('explains a missing folder and a file selection through the real add route', async () => {
  const filePath = path.join(home, 'selected-file');
  writeFileSync(filePath, 'fixture');
  for (const [localPath, expected] of [
    [path.join(home, 'missing'), 'Choose an existing folder'],
    [filePath, 'Choose the folder containing your project'],
  ]) {
    const response = await reposRoute.POST(new Request('http://localhost/api/panel/repos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', localPath }),
    }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(expected);
  }
});

it('returns after persistence without waiting for readiness, then retries and links the same repo', async () => {
  readinessGate.hold = true;
  const firstPending = postAdd();
  let firstResponse: Awaited<ReturnType<typeof postAdd>> | undefined;
  try {
    firstResponse = await Promise.race([
      firstPending,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 8_000)),
    ]);
    expect(firstResponse, 'add must respond before a stalled readiness probe finishes').toBeDefined();
  } finally {
    readinessGate.hold = false;
    readinessGate.release?.();
    firstResponse ??= await firstPending;
  }

  if (!firstResponse) throw new Error('Repository add did not return a response.');
  expect(firstResponse.status).toBe(201);
  const first = await firstResponse.json() as { repo: { id: string; localPath: string } };
  const registryPath = path.join(dataDir, 'repos.json');
  const persisted = JSON.parse(readFileSync(registryPath, 'utf8')) as { repos: Array<{ id: string; localPath: string }> };
  expect(persisted.repos).toEqual([expect.objectContaining({ id: first.repo.id, localPath: repoPath })]);

  // The UI can retry a timed-out add and still finish the separate project link.
  const retryResponse = await postAdd();
  expect(retryResponse.status).toBe(201);
  const retry = await retryResponse.json() as { repo: { id: string; localPath: string } };
  expect(retry.repo.id).toBe(first.repo.id);
  const patchResponse = await projectRoute.PATCH(new NextRequest('http://localhost/api/panel/projects/default', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPaths: [retry.repo.localPath] }),
  }), { params: Promise.resolve({ id: 'default' }) });
  expect(patchResponse.status).toBe(200);
  const ledger = await patchResponse.json() as { projects: Array<{ id: string; repoPaths: string[] }> };
  expect(ledger.projects.find((project) => project.id === 'default')?.repoPaths).toContain(repoPath);
  const persistedAfterRetry = JSON.parse(readFileSync(registryPath, 'utf8')) as { repos: Array<{ id: string }> };
  expect(persistedAfterRetry.repos).toHaveLength(1);
}, 30_000);

it('persists a native onboarding selection through the repository route and leaves cancel unchanged', async () => {
  const selectedPath = path.join(home, 'onboarding-project');
  mkdirSync(selectedPath);
  execFileSync('git', ['init', '-q', '-b', 'main', selectedPath]);
  const invoke = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(selectedPath);
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
  try {
    const { chooseOnboardingProject } = await import('@/components/desktop/onboarding/onboarding-projects');
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/panel/repos');
      return reposRoute.POST(new Request(`http://localhost${String(input)}`, init));
    });
    await expect(chooseOnboardingProject(request)).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
    const project = await chooseOnboardingProject(request);
    expect(project?.localPath).toBe(selectedPath);
    expect(invoke).toHaveBeenCalledWith('plugin:dialog|open', { options: { directory: true, title: 'Select project folder' } }, undefined);
    const persisted = JSON.parse(readFileSync(path.join(dataDir, 'repos.json'), 'utf8')) as { repos: Array<{ id: string; localPath: string }> };
    expect(persisted.repos).toContainEqual(expect.objectContaining({ id: project?.id, localPath: selectedPath }));
  } finally {
    vi.unstubAllGlobals();
  }
}, 30_000);
