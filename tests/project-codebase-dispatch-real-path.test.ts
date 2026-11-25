import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: vi.fn(async () => ({
    ready: true,
    reason: 'test',
    waitedMs: 0,
    attempts: 1,
    lastCheck: {
      ready: true,
      reason: 'test',
      apiBase: 'http://127.0.0.1:1',
      portSource: 'default',
      apiPortFilePresent: false,
    },
  })),
}));

vi.mock('@/lib/analytics/server', () => ({
  emitProductEvent: vi.fn(async () => undefined),
}));

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => undefined),
}));

const root = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'project-codebase-'));
const dataDir = join(root, 'data');
const ownedRoot = join(root, 'owned-qoder');
const capturePath = join(root, 'qoder-spawns.jsonl');
const fakeQoderPath = join(root, 'qodercli');
const priorEnv = new Map<string, string | undefined>();
const envKeys = [
  'CORTEX_IDE_DATA_DIR',
  'O8_DATA_DIR',
  'O8_OWNED_QODER_ROOT',
  'O8_QODER_BIN',
  'O8_FAKE_QODER_CAPTURE',
  'O8_CRASH_SURVIVABLE_WORKERS',
  'O8_PACKAGED_APP',
  'O8_APFS_DEPENDENCY_IMAGES',
  'O8_SKIP_PRELAUNCH_TYPECHECK',
] as const;

for (const key of envKeys) priorEnv.set(key, process.env[key]);
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_OWNED_QODER_ROOT = ownedRoot;
process.env.O8_QODER_BIN = fakeQoderPath;
process.env.O8_FAKE_QODER_CAPTURE = capturePath;
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
process.env.O8_PACKAGED_APP = '0';
process.env.O8_APFS_DEPENDENCY_IMAGES = '0';
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

writeFileSync(
  fakeQoderPath,
  [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "if (process.argv.includes('--version')) {",
    "  process.stdout.write('qodercli 1.0.0\\n');",
    '  process.exit(0);',
    '}',
    'fs.appendFileSync(',
    '  process.env.O8_FAKE_QODER_CAPTURE,',
    "  `${JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) })}\\n`,",
    ');',
    "process.stderr.write('fake qoder fatal exit\\n');",
    'setTimeout(() => process.exit(23), 25);',
  ].join('\n'),
  'utf8',
);
chmodSync(fakeQoderPath, 0o755);

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function gitHead(cwd: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
}

function createRemoteBackedRepo(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  const origin = join(root, `origin-${suffix}.git`);
  const seed = join(root, `seed-${suffix}`);
  const repo = join(root, `repo-${suffix}`);
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, seed], { stdio: 'pipe' });
  git(seed, 'checkout', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), 'declarative dispatch test\n', 'utf8');
  git(seed, 'add', 'README.md');
  git(seed, '-c', 'user.name=o8 test', '-c', 'user.email=o8@test.invalid', 'commit', '-m', 'init');
  git(seed, 'push', '-u', 'origin', 'main');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  return realpathSync(repo);
}

async function waitFor<T>(
  read: () => T | null,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function createThroughMcp(repoPath: string, extra: Record<string, unknown> = {}) {
  const route = await import('@/app/api/orchestrator/create-mission/route');
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = { clientMutationId: `capture-${crypto.randomUUID()}`, ...JSON.parse(String(init?.body ?? '{}')) };
    return route.POST(new NextRequest('http://localhost/api/orchestrator/create-mission', {
      method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify(body),
    }));
  }));
  const { MISSION_TOOLS, handleCreateMission } = await import('@/lib/mcp/operator-handlers/mission');
  expect(MISSION_TOOLS.some((tool) => tool.name === 'create_mission')).toBe(true);
  return handleCreateMission({ repoPath, runtime: 'qoder', dispatch: false,
    issues_inline: [{ title: 'Capture creation project', body: 'Owned local CLI fixture; no inference.' }], ...extra });
}

function createdMissionId(created: Awaited<ReturnType<typeof createThroughMcp>>): string {
  const result = JSON.parse(created.content.find((block) => block.type === 'text')!.text) as { missionId: string };
  expect(result.missionId, JSON.stringify(created)).toBeTruthy();
  return result.missionId;
}

describe('project codebase brief through creation and actual dispatch', () => {
  afterAll(async () => {
    const { closeDb } = await import('@/lib/db');
    closeDb();
    vi.unstubAllGlobals();
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  // Quarantined (#6761): on main the non-main repository worker never launches within the wait.
  it.skip('briefs one codebase and dispatches into a non-main project repository [quarantined #6761]', async () => {
    const anchorPath = createRemoteBackedRepo();
    const targetPath = createRemoteBackedRepo();
    const siblingPath = createRemoteBackedRepo();
    const unrelatedPath = createRemoteBackedRepo();
    const { addRepo } = await import('@/lib/repos/registry');
    const anchor = await addRepo(anchorPath);
    const target = await addRepo(targetPath);
    const sibling = await addRepo(siblingPath);
    const unrelated = await addRepo(unrelatedPath);
    const { createProject, addRepoToProject, updateProject } = await import('@/lib/projects/store');
    const { setActiveProject } = await import('@/lib/repos/projects');
    const project = createProject({ name: 'One product across repositories' });
    addRepoToProject(project.id, anchor.id, 'fullstack', 'manual');
    addRepoToProject(project.id, target.id, 'site', 'manual');
    addRepoToProject(project.id, sibling.id, 'library', 'manual');
    updateProject(project.id, { mainRepoId: anchor.id });
    await setActiveProject(project.id);

    const { getProjectContext, buildProjectTaskBrief } = await import('@/lib/projects/context');
    const context = await getProjectContext({ projectId: project.id, repoPath: targetPath });
    expect(context.primaryRepo?.id).toBe(anchor.id);
    expect(context.currentRepo?.id).toBe(target.id);
    expect([...context.repoPaths].sort()).toEqual([anchorPath, targetPath, siblingPath].sort());
    const brief = buildProjectTaskBrief(context);
    const cloudBrief = buildProjectTaskBrief(context, { includeLocalPaths: false });
    const { GET: searchFiles } = await import('@/app/api/panel/files/route');
    const { GET: readFile } = await import('@/app/api/panel/file-content/route');
    for (const repoPath of context.repoPaths) {
      const query = new URLSearchParams({ workspace: repoPath, search: 'README' });
      const search = await searchFiles(new Request(`http://localhost/api/panel/files?${query}`));
      expect(search.status).toBe(200);
      expect((await search.json()).entries).toEqual([
        expect.objectContaining({ path: 'README.md' }),
      ]);
      const fileQuery = new URLSearchParams({ workspace: repoPath, path: 'README.md' });
      const file = await readFile(new Request(`http://localhost/api/panel/file-content?${fileQuery}`));
      expect(file.status).toBe(200);
      expect((await file.json()).content).toBe(readFileSync(join(repoPath, 'README.md'), 'utf8'));
    }
    const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
    const { recordLaneEvent } = await import('@/lib/lane/events');
    for (const [index, repoPath] of [anchorPath, targetPath, siblingPath, unrelatedPath].entries()) {
      const lane = createLane({ repoPath, branch: `context-${index}`, runtime: 'qoder' });
      recordLaneEvent(lane.id, 'steered_packet', 'user', {
        source: 'operator', message: `Project feedback from repository ${index}`,
      });
      setLaneStatus(lane.id, 'completed', 'system');
    }
    const { retrieveAll, unionMerge } = await import('@/lib/cortex/qa/retrieve');
    const retrieved = unionMerge(await retrieveAll({
      question: 'What project feedback did the operator give?', repoPath: targetPath, projectId: project.id,
    }));
    const feedback = retrieved.filter(row => row.citation.kind === 'correction').map(row => row.fields.body);
    expect(feedback).toContain('Project feedback from repository 0');
    expect(feedback).toContain('Project feedback from repository 1');
    expect(feedback).toContain('Project feedback from repository 2');
    expect(feedback).not.toContain('Project feedback from repository 3');
    const { buildContextBlock } = await import('@/lib/cortex/context-block');
    const brainContext = await buildContextBlock({ repoPath: targetPath, projectId: project.id, packetBody: 'Update the product site.' });

    const created = await createThroughMcp(targetPath, { projectId: project.id });
    const missionId = createdMissionId(created);
    const { closeDb } = await import('@/lib/db');
    closeDb();
    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const persisted = readMissionRegistryEntry(missionId)!.mission;
    expect(persisted.packets[0]).toMatchObject({ projectId: project.id, workspaceTargetPath: targetPath });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service');
    await dispatchMission({ missionId });
    const { findLaneByPacket } = await import('@/lib/lane/registry');
    const lane = findLaneByPacket(persisted.packets[0].id)!;
    expect(lane).toMatchObject({ projectId: project.id, repoPath: targetPath });
    const spawn = await waitFor(() => {
      if (!existsSync(capturePath)) return null;
      return readFileSync(capturePath, 'utf8').trim().split('\n')
        .map(line => JSON.parse(line) as { cwd: string; argv: string[] })
        .find(entry => entry.cwd === lane.worktreePath) ?? null;
    }, 'non-main repository worker launch');
    expect(gitHead(spawn.cwd)).toBe(gitHead(targetPath));
    expect(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: spawn.cwd, encoding: 'utf8',
    }).trim()).toBe(join(targetPath, '.git'));
    const prompt = spawn.argv.join('\n');
    for (const text of [brief, brainContext, prompt]) {
      expect(text).toContain('one codebase');
      expect(text).toContain(anchor.name);
      expect(text).toContain(target.name);
      expect(text).toContain(sibling.name);
      expect(text).not.toContain(unrelatedPath);
      expect(text).not.toContain(unrelated.name);
      expect(text).not.toContain('edit sibling repos only when');
      expect(text).not.toContain('edit siblings only when');
      expect(text).toContain('Each packet stays within its assigned repository');
    }
    expect(brief).toContain(anchorPath);
    expect(brief).toContain(targetPath);
    expect(brief).toContain(siblingPath);
    expect(prompt).toContain(anchorPath);
    expect(prompt).toContain(targetPath);
    expect(prompt).toContain(siblingPath);
    expect(brainContext).not.toContain(anchorPath);
    expect(brainContext).not.toContain(targetPath);
    expect(brainContext).not.toContain(siblingPath);
    expect(cloudBrief).toContain(anchor.name);
    expect(cloudBrief).toContain(target.name);
    expect(cloudBrief).toContain(sibling.name);
    expect(cloudBrief).not.toContain(anchorPath);
    expect(cloudBrief).not.toContain(targetPath);
    expect(cloudBrief).not.toContain(siblingPath);
  }, 40_000);
});
