// @vitest-environment jsdom
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Onboarding } from '@/components/desktop/Onboarding';
import { createOnboardingCompletionHandler } from '@/app/dashboard/hooks/onboarding-completion';
import { useSetupWizard } from '@/app/dashboard/hooks/useSetupWizard';
import { createOnboardingPreviewRequest } from '@/app/preview/first-run/FirstRunPreview';
import type { OnboardingRequest } from '@/components/desktop/onboarding/request';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sourceRoot = process.cwd();
const fixture = mkdtempSync(path.join(os.tmpdir(), 'o8-setup-project-hooks-'));
const dataDir = path.join(fixture, 'data');
const bundleServer = path.join(fixture, 'Installed.app', 'Contents', 'Resources', 'server');
const projectRoot = path.join(fixture, 'selected-project');
const setupPath = path.join(dataDir, 'setup.json');
const settingsPath = path.join(projectRoot, '.claude', 'settings.json');
const priorDataDir = process.env.O8_DATA_DIR;
const priorLegacyDataDir = process.env.CORTEX_IDE_DATA_DIR;
const priorRepoRoot = process.env.CORTEX_IDE_REPO_ROOT;
const priorPackagedApp = process.env.O8_PACKAGED_APP;
const priorNodeBin = process.env.O8_NODE_BIN;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
mkdirSync(dataDir, { recursive: true });
mkdirSync(bundleServer, { recursive: true });
mkdirSync(projectRoot, { recursive: true });
const route = await import('@/app/api/setup/config/route');
const { addRepo, listRepos } = await import('@/lib/repos/registry');

async function post(body: Record<string, unknown>) {
  return route.POST(new NextRequest('http://localhost/api/setup/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

let root: Root | null = null;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  localStorage.clear();
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(process, 'cwd').mockReturnValue(bundleServer);
  delete process.env.CORTEX_IDE_REPO_ROOT;
  process.env.O8_PACKAGED_APP = '1';
  process.env.O8_NODE_BIN = process.execPath;
  mkdirSync(path.join(bundleServer, 'hooks'), { recursive: true });
  for (const name of ['claude-code-pretool-hook.js', 'post-edit-typecheck.js', 'completion-gate.js']) {
    copyFileSync(path.join(sourceRoot, 'dist', 'hooks', name), path.join(bundleServer, 'hooks', name));
  }
  mkdirSync(projectRoot, { recursive: true });
  rmSync(path.join(bundleServer, '.claude'), { recursive: true, force: true });
  rmSync(path.join(projectRoot, '.claude'), { recursive: true, force: true });
  writeFileSync(setupPath, JSON.stringify({ setupComplete: false, skippedSteps: ['runtime'] }));
  writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({ version: 1, repos: [
    { id: 'selected-project', localPath: projectRoot, name: 'Selected project' },
  ] }));
});

afterAll(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries({
    O8_DATA_DIR: priorDataDir,
    CORTEX_IDE_DATA_DIR: priorLegacyDataDir,
    CORTEX_IDE_REPO_ROOT: priorRepoRoot,
    O8_PACKAGED_APP: priorPackagedApp,
    O8_NODE_BIN: priorNodeBin,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(fixture, { recursive: true, force: true });
});

describe('setup POST project hook installation', () => {
  it.each([false, true])('persists projectless completion without modifying the bundle (legacy env=%s)', async (legacyEnv) => {
    if (legacyEnv) process.env.CORTEX_IDE_REPO_ROOT = bundleServer;
    const completedAt = '2026-10-01T12:00:00.000Z';
    const response = await post({ setupComplete: true, completedAt });
    expect(response.status).toBe(200);
    expect(JSON.parse(readFileSync(setupPath, 'utf8'))).toMatchObject({
      setupComplete: true, completedAt, skippedSteps: ['runtime'],
    });
    expect(existsSync(path.join(bundleServer, '.claude'))).toBe(false);
    expect(existsSync(settingsPath)).toBe(false);
    const laterResponse = await post({ skippedSteps: [] });
    expect(laterResponse.status).toBe(200);
    expect(existsSync(path.join(bundleServer, '.claude'))).toBe(false);
  });

  it('does not treat a registered environment root as an explicit project selection', async () => {
    process.env.CORTEX_IDE_REPO_ROOT = projectRoot;
    expect((await post({ completedAt: '2026-10-01T12:00:00.000Z' })).status).toBe(200);
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(path.join(bundleServer, '.claude'))).toBe(false);
  });

  it('installs into an explicitly selected registered project and preserves existing settings', async () => {
    process.env.CORTEX_IDE_REPO_ROOT = bundleServer;
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    const existing = { permissions: { allow: ['Read'] }, hooks: {
      PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'existing-read-hook' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'existing-stop-hook' }] }],
    } };
    writeFileSync(settingsPath, JSON.stringify(existing));
    const response = await post({ setupComplete: true, repoPath: projectRoot });
    expect(response.status).toBe(200);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.permissions).toEqual(existing.permissions);
    expect(settings.hooks.Stop).toEqual(existing.hooks.Stop);
    expect(settings.hooks.PreToolUse[0]).toEqual(existing.hooks.PreToolUse[0]);
    expect(settings.hooks.PreToolUse).toHaveLength(3);
    expect(settings.hooks.PreToolUse[1].hooks[0].command).toContain(path.join(bundleServer, 'hooks'));
    expect(existsSync(path.join(projectRoot, 'src'))).toBe(false);
    expect(existsSync(path.join(projectRoot, 'dist'))).toBe(false);
    expect(JSON.parse(execSync(settings.hooks.PreToolUse[1].hooks[0].command, {
      cwd: projectRoot, input: JSON.stringify({ session_id: 'fixture', tool_name: 'Read', tool_input: {}, tool_use_id: 'read' }),
      encoding: 'utf8', timeout: 5_000,
    })).hookSpecificOutput.permissionDecision).toBe('allow');
    expect(settings.hooks.PreToolUse[2].hooks[0].command).toBe('o8 team guard');
    const savedSettings = readFileSync(settingsPath, 'utf8');
    expect((await post({ setupComplete: true, repoPath: projectRoot })).status).toBe(200);
    expect(readFileSync(settingsPath, 'utf8')).toBe(savedSettings);
    expect(existsSync(path.join(bundleServer, '.claude'))).toBe(false);
    expect(JSON.parse(readFileSync(setupPath, 'utf8'))).not.toHaveProperty('repoPath');
  });

  it('rejects an unregistered explicit path before saving setup or installing hooks', async () => {
    const response = await post({ setupComplete: true, repoPath: bundleServer });
    expect(response.status).toBe(400);
    expect(JSON.parse(readFileSync(setupPath, 'utf8')).setupComplete).toBe(false);
    expect(existsSync(path.join(bundleServer, '.claude'))).toBe(false);
  });
});


it.each([false, true])('completes the real onboarding UI and setup hook (Open folder=%s)', async (openFolder) => {
  process.env.CORTEX_IDE_REPO_ROOT = bundleServer;
  writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({ version: 1, repos: [] }));
  const selected = vi.fn();
  const opened = vi.fn().mockReturnValue('lead-tab');
  const preview = createOnboardingPreviewRequest(localStorage);
  const request: OnboardingRequest = async (url, init) => {
    if (String(url) === '/api/setup/config') return init?.method === 'POST'
      ? post(JSON.parse(String(init.body))) : route.GET();
    if (String(url).startsWith('/api/panel/repos')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        return Response.json({ repo: await addRepo(body.localPath) }, { status: 201 });
      }
      return Response.json({ repos: await listRepos() });
    }
    return preview(url, init);
  };
  vi.stubGlobal('fetch', request);
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  function Harness() {
    const { handleSetupComplete } = useSetupWizard();
    const onComplete = createOnboardingCompletionHandler({
      loadRegisteredRepos: listRepos, handleSelectRegisteredRepo: selected,
      waitForWorkspaceTerminalTarget: async () => ({ tileId: 'tile-root', handle: {
        focusTab: () => true, openOrchestratorTab: opened, injectIntoOrchestrator: () => true,
      } }), onboardingTargetRef: { current: null }, setActiveTileId: vi.fn(), flashWorkspaceTab: vi.fn(), handleSetupComplete,
    });
    return createElement(Onboarding, { request, storage: localStorage, pickFolder: async () => projectRoot, onComplete });
  }
  await act(async () => root!.render(createElement(Harness)));
  async function click(label: string) {
    const button = await vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      const found = Array.from(document.querySelectorAll('button')).find((item) => item.textContent === label);
      expect(found, label).toBeDefined();
      return found!;
    }, { timeout: 5_000 });
    await act(async () => button.click());
  }
  await click(openFolder ? 'Open a folder' : 'Start without a project');
  await click('Keep crash reports off');
  await click('Turn off');
  await click('Save privacy choices');
  await act(async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (JSON.parse(readFileSync(setupPath, 'utf8')).setupComplete) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });
  expect(JSON.parse(readFileSync(setupPath, 'utf8')).setupComplete).toBe(true);
  expect(existsSync(settingsPath)).toBe(openFolder);
  if (openFolder) {
    const repos = JSON.parse(readFileSync(path.join(dataDir, 'repos.json'), 'utf8')).repos;
    expect(repos).toHaveLength(1);
    expect(selected).toHaveBeenCalledWith(repos[0].id);
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ localPath: repos[0].localPath }));
  } else {
    expect(selected).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  }
  expect(existsSync(path.join(bundleServer, '.claude'))).toBe(false);
});
