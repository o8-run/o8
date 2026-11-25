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


vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => undefined),
}));

const root = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'mission-project-capture-'));
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

let lastCreationBody: Record<string, unknown>;

async function createThroughMcp(repoPath: string, extra: Record<string, unknown> = {}) {
  const route = await import('@/app/api/orchestrator/create-mission/route');
  vi.stubGlobal('fetch', vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    lastCreationBody = { clientMutationId: `capture-${crypto.randomUUID()}`, ...JSON.parse(String(init?.body ?? '{}')) };
    return route.POST(new NextRequest('http://localhost/api/orchestrator/create-mission', {
      method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify(lastCreationBody),
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

describe('mission project capture through creation and actual dispatch', () => {
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

  it('captures the creation project through MCP, reload and launch after the active project changes', async () => {
    const repoPath = createRemoteBackedRepo();
    const { addRepo } = await import('@/lib/repos/registry');
    const repo = await addRepo(repoPath);
    const { createProject, addRepoToProject } = await import('@/lib/projects/store');
    const { setActiveProject } = await import('@/lib/repos/projects');
    const original = createProject({ name: 'Mission original project' });
    const alternate = createProject({ name: 'Mission alternate project' });
    addRepoToProject(original.id, repo.id, null, 'manual');
    addRepoToProject(alternate.id, repo.id, null, 'manual');
    await setActiveProject(original.id);
    const created = await createThroughMcp(repoPath);
    const result = JSON.parse(created.content.find((block) => block.type === 'text')!.text) as { missionId: string; packets: { id: string }[] };
    expect(result.missionId, JSON.stringify(created)).toBeTruthy();
    const taskId = result.packets[0].id;
    const { closeDb } = await import('@/lib/db');
    closeDb();
    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    expect(readMissionRegistryEntry(result.missionId)?.mission.packets[0].projectId).toBe(original.id);
    await setActiveProject(alternate.id);
    closeDb();
    const route = await import('@/app/api/orchestrator/create-mission/route');
    const replay = await route.POST(new NextRequest('http://localhost/api/orchestrator/create-mission', {
      method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify(lastCreationBody),
    }));
    expect((await replay.json()).result.missionId).toBe(result.missionId);
    expect(readMissionRegistryEntry(result.missionId)?.mission.packets[0].projectId).toBe(original.id);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service');
    await dispatchMission({ missionId: result.missionId });
    const { findLaneByPacket } = await import('@/lib/lane/registry');
    const lane = findLaneByPacket(taskId)!;
    expect(lane?.projectId).toBe(original.id);
    const { getTaskPoolTask } = await import('@/lib/tasks/pool');
    expect((await getTaskPoolTask(taskId))?.project?.id).toBe(original.id);
    await waitFor(() => existsSync(capturePath) && readFileSync(capturePath, 'utf8').includes(lane.worktreePath!) ? true : null,
      'owned CLI launched from captured project');
  }, 40_000);

  it('explicit project identity wins over active selection and thread placement', async () => {
    const repoPath = createRemoteBackedRepo();
    const { addRepo } = await import('@/lib/repos/registry');
    const repo = await addRepo(repoPath);
    const { createProject, addRepoToProject } = await import('@/lib/projects/store');
    const { setActiveProject } = await import('@/lib/repos/projects');
    const selected = createProject({ name: 'Explicit mission project' });
    const active = createProject({ name: 'Other active mission project' });
    addRepoToProject(selected.id, repo.id, null, 'manual');
    addRepoToProject(active.id, repo.id, null, 'manual');
    await setActiveProject(active.id);
    const missionId = createdMissionId(await createThroughMcp(repoPath, {
      projectId: selected.id, orchestratorThreadId: 'placement-only-thread',
    }));
    const { closeDb } = await import('@/lib/db');
    closeDb();
    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    expect(readMissionRegistryEntry(missionId)?.mission.packets[0].projectId).toBe(selected.id);
  }, 40_000);

  it('refuses malformed, removed, out-of-scope and ambiguous identities before branch allocation', async () => {
    const repoPath = createRemoteBackedRepo();
    const { addRepo } = await import('@/lib/repos/registry');
    const repo = await addRepo(repoPath);
    const { createProject, addRepoToProject, deleteProject } = await import('@/lib/projects/store');
    const { setActiveProject } = await import('@/lib/repos/projects');
    const unrelated = createProject({ name: 'Unrelated mission project' });
    const removed = createProject({ name: 'Removed mission project' });
    deleteProject(removed.id);
    const one = createProject({ name: 'Ambiguous mission one' });
    const two = createProject({ name: 'Ambiguous mission two' });
    addRepoToProject(one.id, repo.id, null, 'manual');
    addRepoToProject(two.id, repo.id, null, 'manual');
    await setActiveProject(unrelated.id);
    const branches = () => execFileSync('git', ['for-each-ref', '--format=%(refname)', 'refs/heads'], { cwd: repoPath, encoding: 'utf8' });
    const before = branches();
    for (const projectId of [42, '', 'missing-project', removed.id, unrelated.id]) {
      const refusal = await createThroughMcp(repoPath, { projectId });
      expect(refusal.isError, JSON.stringify(refusal)).toBe(true);
      expect(branches()).toBe(before);
    }
    const ambiguous = await createThroughMcp(repoPath);
    expect(ambiguous.isError, JSON.stringify(ambiguous)).toBe(true);
    expect(branches()).toBe(before);
  }, 40_000);

  it('refuses dispatch after captured membership is removed without allocating a lane', async () => {
    const repoPath = createRemoteBackedRepo();
    const { addRepo } = await import('@/lib/repos/registry');
    const repo = await addRepo(repoPath);
    const { createProject, addRepoToProject, removeRepoFromProject } = await import('@/lib/projects/store');
    const project = createProject({ name: 'Removed membership mission' });
    addRepoToProject(project.id, repo.id, null, 'manual');
    const missionId = createdMissionId(await createThroughMcp(repoPath, { projectId: project.id }));
    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const packetId = readMissionRegistryEntry(missionId)!.mission.packets[0].id;
    removeRepoFromProject(project.id, repo.id);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service');
    await expect(dispatchMission({ missionId })).rejects.toThrow(/outside|project/i);
    const { findLaneByPacket } = await import('@/lib/lane/registry');
    expect(findLaneByPacket(packetId)).toBeNull();
    expect(readMissionRegistryEntry(missionId)?.mission.packets[0].queueState).toBe('held');
  }, 40_000);


  it('preserves default-panel, virtual and transient repository compatibility through saved missions', async () => {
    const { addRepo } = await import('@/lib/repos/registry');
    const { createProject, addRepoToProject } = await import('@/lib/projects/store');
    const { DEFAULT_PROJECT_ID, getProjectsLedger } = await import('@/lib/repos/projects');
    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const defaultPath = createRemoteBackedRepo();
    const defaultRepo = await addRepo(defaultPath);
    const workspace = createProject({ name: 'Workspace', slug: 'workspace' });
    addRepoToProject(workspace.id, defaultRepo.id, null, 'manual');
    const defaultId = createdMissionId(await createThroughMcp(defaultPath, { projectId: DEFAULT_PROJECT_ID }));
    expect(readMissionRegistryEntry(defaultId)?.mission.packets[0].projectId).toBe(workspace.id);
    const virtualPath = createRemoteBackedRepo();
    const virtualRepo = await addRepo(virtualPath);
    const virtualId = `repo:${virtualRepo.id}`;
    expect((await getProjectsLedger()).projects.some((project) => project.id === virtualId)).toBe(true);
    const virtualMission = createdMissionId(await createThroughMcp(virtualPath, { projectId: virtualId }));
    expect(readMissionRegistryEntry(virtualMission)?.mission.packets[0].projectId).toBe(virtualId);
    const transientPath = createRemoteBackedRepo();
    const transientMission = createdMissionId(await createThroughMcp(transientPath));
    expect(readMissionRegistryEntry(transientMission)?.mission.packets[0].projectId).toBeUndefined();
  }, 40_000);


  it('captures unique legacy panel aliases through MCP and saved reload', async () => {
    const repoPath = createRemoteBackedRepo();
    const { addRepo } = await import('@/lib/repos/registry');
    const repo = await addRepo(repoPath);
    const { createProject, addRepoToProject } = await import('@/lib/projects/store');
    const project = createProject({ name: 'Legacy mission project' });
    addRepoToProject(project.id, repo.id, null, 'manual');
    const alias = 'prj-legacy-mission';
    writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({
      projects: [{ id: alias, name: project.name, repoPaths: [repoPath], createdAt: new Date().toISOString() }],
      activeProjectId: alias,
    }));
    const { closeDb } = await import('@/lib/db');
    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    for (const extra of [{ projectId: alias }, {}]) {
      const missionId = createdMissionId(await createThroughMcp(repoPath, extra));
      closeDb();
      expect(readMissionRegistryEntry(missionId)?.mission.packets[0].projectId).toBe(project.id);
    }
  }, 40_000);

  it('does not reinterpret default panel identity as another project slug through MCP', async () => {
    const repoPath = createRemoteBackedRepo();
    const { addRepo } = await import('@/lib/repos/registry');
    const repo = await addRepo(repoPath);
    const { listProjects, createProject, addRepoToProject } = await import('@/lib/projects/store');
    const workspace = listProjects().find((project) => project.name === 'Workspace')!;
    const shadow = createProject({ name: 'Default' });
    addRepoToProject(workspace.id, repo.id, null, 'manual');
    addRepoToProject(shadow.id, repo.id, null, 'manual');
    writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({
      projects: [{ id: 'default', name: 'Workspace', repoPaths: [repoPath], createdAt: new Date().toISOString() }],
      activeProjectId: 'default',
    }));
    const missionId = createdMissionId(await createThroughMcp(repoPath, { projectId: 'default' }));
    const { closeDb } = await import('@/lib/db');
    closeDb();
    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    expect(readMissionRegistryEntry(missionId)?.mission.packets[0].projectId).toBe(workspace.id);
  }, 40_000);


  it('refuses a deleted captured project even when a replacement reuses its name and repository', async () => {
    const repoPath = createRemoteBackedRepo();
    const { addRepo } = await import('@/lib/repos/registry');
    const repo = await addRepo(repoPath);
    const { createProject, addRepoToProject, deleteProject } = await import('@/lib/projects/store');
    const { setActiveProject } = await import('@/lib/repos/projects');
    const original = createProject({ name: 'Replaced captured mission project' });
    addRepoToProject(original.id, repo.id, null, 'manual');
    await setActiveProject(original.id);
    const missionId = createdMissionId(await createThroughMcp(repoPath, { projectId: original.id }));
    const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
    const packetId = readMissionRegistryEntry(missionId)!.mission.packets[0].id;
    deleteProject(original.id);
    const replacement = createProject({ name: original.name });
    addRepoToProject(replacement.id, repo.id, null, 'manual');
    const { closeDb } = await import('@/lib/db');
    closeDb();
    const { getSqlite } = await import('@/lib/db');
    const persisted = () => getSqlite().prepare('SELECT mission_state_json, updated_at FROM missions WHERE id = ?').get(missionId);
    const before = persisted();
    const cliBefore = existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : null;
    const { dispatchMission } = await import('@/lib/orchestrator/operator-mission-service');
    await expect(dispatchMission({ missionId })).rejects.toThrow(/no longer exists|identity changed/i);
    expect(persisted()).toEqual(before);
    expect(existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : null).toBe(cliBefore);
    const { findLaneByPacket } = await import('@/lib/lane/registry');
    expect(findLaneByPacket(packetId)).toBeNull();
    expect((await createThroughMcp(repoPath, { projectId: original.id })).isError).toBe(true);
  }, 40_000);

});
