import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

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

const root = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'project-verification-dispatch-'));
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
  return repo;
}

function packet(repoPath: string, id: string): OrchestratorPacket {
  return {
    id,
    referenceLabel: id.toUpperCase(),
    title: `packet ${id}`,
    summary: `exercise declarative dispatch ${id}`,
    workspaceTargetPath: repoPath,
    branchTarget: `packet/${id}`,
    runtime: 'qoder',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    blockedReason: null,
    lane: null,
    review: null,
    workerRouting: {
      requestedRuntime: 'qoder',
    } as OrchestratorPacket['workerRouting'],
  };
}

function mission(repoPath: string, target: OrchestratorPacket): OrchestratorMissionState {
  return {
    missionId: `mission-${target.id}`,
    repoPath,
    packets: [target],
    updatedAt: new Date().toISOString(),
  } as OrchestratorMissionState;
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

describe('target-project verification dispatch', () => {
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

  it.each(['docs', 'typescript-missing-compiler', 'typescript-local-compiler'] as const)(
    'delivers target-project verification through dispatch for %s',
    async (kind) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
      const repoPath = createRemoteBackedRepo();
      writeFileSync(join(repoPath, 'AGENTS.md'), 'Required: validate documentation links and run the project test suite.\n');
      if (kind !== 'docs') {
        writeFileSync(join(repoPath, 'tsconfig.json'), '{"compilerOptions":{"noEmit":true}}\n');
        writeFileSync(join(repoPath, 'index.ts'), 'export const answer: number = 42;\n');
      }
      if (kind === 'typescript-local-compiler') {
        // Copy the installed compiler into the fixture; no registry or live inference.
        const binDir = join(repoPath, 'node_modules', '.bin');
        mkdirSync(binDir, { recursive: true });
        cpSync(join(process.cwd(), 'node_modules', 'typescript'), join(repoPath, 'node_modules', 'typescript'), { recursive: true });
        writeFileSync(join(binDir, 'tsc'), "#!/usr/bin/env node\nrequire('../typescript/lib/tsc.js');\n");
        chmodSync(join(binDir, 'tsc'), 0o755);
      }
      git(repoPath, 'add', '.');
      git(repoPath, '-c', 'user.name=o8 test', '-c', 'user.email=o8@test.invalid', 'commit', '-m', 'verification fixture');
      git(repoPath, 'push', 'origin', 'main');
      const registeredRepo = await import('@/lib/repos/registry').then(({ addRepo }) => addRepo(repoPath));
      const [{ runDispatchTick }, laneRegistry, controlPlane] = await Promise.all([
        import('@/lib/orchestrator/scheduling'),
        import('@/lib/lane/registry'),
        import('@/lib/orchestrator/control-plane'),
      ]);
      const id = `pkt-verification-${kind}`;
      const initial = mission(repoPath, packet(repoPath, id));
      let capturedProjectId: string | null = null;
      if (kind === 'docs') {
        const { createProject, addRepoToProject } = await import('@/lib/projects/store');
        const { setActiveProject } = await import('@/lib/repos/projects');
        const original = createProject({ name: 'Captured dispatch project' });
        const alternate = createProject({ name: 'Active dispatch project' });
        addRepoToProject(original.id, registeredRepo.id, null, 'manual');
        addRepoToProject(alternate.id, registeredRepo.id, null, 'manual');
        capturedProjectId = original.id;
        initial.packets[0].projectId = original.id;
        await setActiveProject(alternate.id);
      }
      controlPlane.writeOrchestratorControlPlaneState(initial);
      const dispatched = await runDispatchTick(initial, {
        launchBudget: { maxLaunches: 1 },
      });
      expect(dispatched.packets[0].status).toBe('launching');
      const lane = laneRegistry.findLaneByPacket(id)!;
      if (capturedProjectId) {
        expect(lane.projectId).toBe(capturedProjectId);
        const { getTaskPoolTask } = await import('@/lib/tasks/pool');
        expect((await getTaskPoolTask(id))?.project?.id).toBe(capturedProjectId);
      }
      const spawn = await waitFor(() => {
        if (!existsSync(capturePath)) return null;
        return readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean)
          .map((line) => JSON.parse(line) as { cwd: string; argv: string[] })
          .find((entry) => realpathSync(entry.cwd) === realpathSync(lane.worktreePath!)) ?? null;
      }, `delivered ${kind} worker prompt`);
      const prompt = spawn.argv.join('\n');
      expect(prompt).toContain('Follow the target repository verification rules');
      expect(readFileSync(join(spawn.cwd, 'AGENTS.md'), 'utf8')).toContain('validate documentation links');
      expect(prompt).not.toContain('the ONE blocking gate');
      expect(prompt).toContain('Do not download a compiler');
      if (kind === 'docs') {
        expect(prompt).toContain('No root tsconfig.json was found');
        expect(prompt).toContain('not an applicable generic gate');
        expect(existsSync(join(spawn.cwd, 'tsconfig.json'))).toBe(false);
      } else {
        expect(prompt).toContain('TypeScript verification remains required');
        expect(prompt).toContain('npx --no-install tsc --noEmit');
        expect(existsSync(join(spawn.cwd, 'tsconfig.json'))).toBe(true);
        if (kind === 'typescript-missing-compiler') {
          expect(prompt).toContain('local TypeScript compiler was not found');
          expect(prompt).toContain('report a verification blocker');
          expect(prompt).not.toContain('not a TypeScript project');
        } else {
          expect(prompt).toContain('local TypeScript compiler was found');
          expect(existsSync(join(spawn.cwd, 'node_modules', '.bin', 'tsc'))).toBe(true);
          execFileSync(join(spawn.cwd, 'node_modules', '.bin', 'tsc'), ['--noEmit'], {
            cwd: spawn.cwd,
            stdio: 'pipe',
          });
        }
      }
    },
    40_000,
  );

});
