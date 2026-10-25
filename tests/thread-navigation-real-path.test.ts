// @vitest-environment jsdom
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, expect, it, vi } from 'vitest';
import { readThreadPages } from '@/components/desktop/o8-panel/readThreadPages';
import { O8ThreadsPane } from '@/components/desktop/o8-panel/O8ThreadsPane';
import { useThreadWorkspaceNavigation } from '@/components/desktop/o8-panel/useThreadNavigation';
import { openCurrentThread, threadPanelAvailability } from '@/components/desktop/o8-panel/thread-navigation';
import { createO8WebviewToolHandlers } from '@/lib/mcp/o8-webview-tools';
import type { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import type { RepoRegistryEntry } from '@/lib/repos/types';

const state = vi.hoisted(() => ({ projectId: '', repoPath: '' }));
vi.mock('@/components/desktop/orchestrator-data-context', () => ({ useOrchestratorData: () => ({ agents: [], missionState: { packets: [] } }) }));
vi.mock('@/components/desktop/repo-registry/useProjects', () => ({ useProjects: () => ({
  activeProject: { id: state.projectId, name: 'Project', repoPaths: [state.repoPath] },
  ledger: { projects: [{ id: state.projectId, name: 'Project', repoPaths: [state.repoPath] }] }, loading: false,
}) }));
vi.mock('@/lib/tauri/ipc-fetch', () => ({ ipcFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const dataDir = mkdtempSync(join(tmpdir(), 'o8-thread-navigation-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: [] }) }));
const threadsRoute = await import('@/app/api/panel/threads/route');
const route = await import('@/app/api/tasks/route');
const panelRoute = await import('@/app/api/panel/projects/route');
const { addRepo } = await import('@/lib/repos/registry');
const { createProject, addRepoToProject } = await import('@/lib/projects/store');
const { closeDb } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
afterAll(() => { closeDb(); rmSync(dataDir, { recursive: true, force: true }); vi.unstubAllGlobals(); });

it('MCP product navigation mounts the persisted task without synthetic input or dispatch', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.repoPath = join(dataDir, 'repo');
  mkdirSync(state.repoPath);
  execFileSync('git', ['init', '-q', state.repoPath]);
  const repo = await addRepo(state.repoPath);
  state.repoPath = repo.localPath;
  const project = createProject({ name: 'Workspace', slug: 'workspace' });
  addRepoToProject(project.id, repo.id, null, 'manual');
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [{
    id: 'default', name: 'Workspace', repoPaths: [], createdAt: new Date().toISOString(), color: '#fff',
  }], activeProjectId: 'default' }));
  const ledger = await (await panelRoute.GET()).json();
  state.projectId = ledger.activeProjectId;
  expect(state.projectId).toBe('default');
  expect(state.projectId).not.toBe(project.id);
  const created = await route.POST(new NextRequest('http://localhost/api/tasks', {
    method: 'POST', headers: { Authorization: `Bearer ${getOrCreateWsToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Navigation fixture', repoPath: state.repoPath, requestedRuntime: 'codex', model: 'gpt-6.1-sol', requestedEffort: 'medium' }),
  }));
  expect(created.status).toBe(201);
  const { taskId } = await created.json();
  const { currentMissionState } = await import('@/lib/orchestrator/operator-mission-service/shared');
  const historical = { ...currentMissionState(), missionId: 'historical-navigation-fixture' };
  (await import('@/lib/db/missions-store')).recordMission({ id: historical.missionId, repoPath: state.repoPath, runtime: 'codex', prompt: historical.prompt, summary: historical.summary, constraints: '', packetMeta: [], totalWaves: 1, missionState: historical });
  (await import('@/lib/orchestrator/control-plane')).writeOrchestratorControlPlaneState((await import('@/lib/orchestrator/store')).createEmptyOrchestratorMissionState());
  closeDb();
  const readTasks = async () => {
    const response = await threadsRoute.GET(new NextRequest('http://localhost/api/panel/threads?repoPath=' + encodeURIComponent(state.repoPath), {
      headers: { Authorization: `Bearer ${getOrCreateWsToken()}` },
    }));
    expect(response.status).toBe(200);
    return (await response.json()).tasks;
  };
  const alternate = createProject({ name: 'Alternate project', slug: 'alternate-project' });
  addRepoToProject(alternate.id, repo.id, null, 'manual');
  writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ projects: [...ledger.projects, {
    id: alternate.id, name: alternate.name, repoPaths: [state.repoPath], createdAt: new Date().toISOString(), color: '#fff',
  }], activeProjectId: alternate.id }));
  closeDb();
  expect((await readTasks()).find((task: { id: string }) => task.id === taskId)).toMatchObject({
    project: { id: project.id, panelProjectId: 'default' },
  });
  const fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith('/api/panel/threads?')) return threadsRoute.GET(new NextRequest(`http://localhost${url}`, { headers: { Authorization: `Bearer ${getOrCreateWsToken()}` } }));
    return new Response(JSON.stringify({ repos: [], logs: [], files: [] }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let viewportWidth = 800;
  let narrowDuringRead = false;
  const selection = { workspace: 'other', tile: 'original', commit: 'original-commit', repo: '/original', panel: 'activity' };
  const originalSelection = { ...selection };
  const readNavigationTasks = vi.fn(async () => {
    const tasks = await readThreadPages({ projectId: null, repoPaths: [state.repoPath] }, AbortSignal.timeout(5000));
    if (narrowDuringRead) viewportWidth = 800;
    return tasks;
  });
  function Harness() {
    const [workspace, setWorkspace] = useState('other');
    useThreadWorkspaceNavigation({
      currentWorkspaceId: () => 'workspace',
      availability: () => threadPanelAvailability(viewportWidth, 1180),
      resolve: (target) => target.workspaceId === 'workspace' && target.repoPath === state.repoPath ? {
        projectId: state.projectId, activate: () => {
          Object.assign(selection, { workspace: 'workspace', tile: 'selected', commit: null, repo: state.repoPath, panel: 'threads' });
          setWorkspace('workspace');
        }, isActive: () => workspace === 'workspace',
      } : null,
      readTasks: readNavigationTasks,
    });
    return createElement(O8ThreadsPane, { active: workspace === 'workspace', repoPath: state.repoPath,
      repos: [{ id: 'repo', localPath: state.repoPath, name: 'Repo' } as RepoRegistryEntry] });
  }
  try {
    await act(async () => root.render(createElement(Harness)));
    const client = { evalJs: async (code: string) => ({ result: await new Function(`return ${code}`)() }) } as O8WebviewClient;
    const handlers = createO8WebviewToolHandlers(() => client);
    const target = { workspaceId: 'workspace', repoPath: state.repoPath, taskId };
    const narrow = await handlers.o8_view_open_thread(target);
    expect(JSON.parse((narrow.content[0] as { text: string }).text)).toMatchObject({
      ok: false, reason: 'panel_viewport_unavailable', viewportWidth: 800, minimumWidth: 1180,
      recovery: { tool: 'o8_view_manage_window', operation: 'maximize' },
    });
    expect(readNavigationTasks).not.toHaveBeenCalled();
    expect(selection).toEqual(originalSelection);
    expect(container.querySelector('[aria-label="Steer this thread"]')).toBeNull();
    viewportWidth = 1600;
    narrowDuringRead = true;
    const resized = await handlers.o8_view_open_thread(target);
    expect(JSON.parse((resized.content[0] as { text: string }).text)).toMatchObject({ reason: 'panel_viewport_unavailable' });
    expect(selection).toEqual(originalSelection);
    expect(container.querySelector('[aria-label="Steer this thread"]')).toBeNull();
    viewportWidth = 1600;
    narrowDuringRead = false;
    let result!: ReturnType<typeof handlers.o8_view_open_thread>;
    await act(async () => {
      result = handlers.o8_view_open_thread({ workspaceId: 'workspace', repoPath: state.repoPath, taskId });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const receipt = await result;
    expect(receipt.isError, JSON.stringify({ receipt, tasks: await readTasks() })).toBe(false);
    expect(JSON.parse((receipt.content[0] as { text: string }).text)).toMatchObject({ ok: true, status: 'mounted', taskId, repoPath: state.repoPath });
    expect(container.querySelector('[aria-label="Steer this thread"]')).not.toBeNull();
    let cardResult!: ReturnType<typeof openCurrentThread>;
    await act(async () => { cardResult = openCurrentThread(state.repoPath, taskId); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(await cardResult).toMatchObject({ ok: true, status: 'mounted', taskId, repoPath: state.repoPath });
    expect((await readTasks()).find((task: { id: string }) => task.id === taskId)).toMatchObject({ queueState: 'queued', lane: null, execution: null });
    expect((fetchMock.mock.calls as unknown[][]).every((call) => !call[1] || !(call[1] as RequestInit).method || (call[1] as RequestInit).method === 'GET')).toBe(true);
    const refused = await handlers.o8_view_open_thread({ workspaceId: 'workspace', repoPath: state.repoPath, taskId: 'missing' });
    expect(refused.isError).toBe(true);
    expect(container.querySelector('[aria-label="Steer this thread"]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});
