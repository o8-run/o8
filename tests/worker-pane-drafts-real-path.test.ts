import path from 'node:path';
import esbuild from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

const executablePath = resolveBrowserPath();
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { OrchestratorDataProvider } from '@/components/desktop/orchestrator-data-context';
import { SessionTileSurface } from '@/components/desktop/workspace-terminal/SessionTileSurface';
import { useSessionTiles } from '@/components/desktop/workspace-terminal/use-session-tiles';
import { ThreadWorkerCard } from '@/components/desktop/thoughts/chat-panel/ThreadWorkerCard';
import { useComposerDraftValue } from '@/components/desktop/thoughts/chat-panel/composer-draft-store';
const workers = ['First worker', 'Second worker'].map((name, index) => ({
  name, sessionKey: 'codex-owned:draft-fixture-' + index, runtime: 'codex', status: 'completed',
}));
const keys = workers.map(worker => worker.sessionKey);
function Workspace() {
  const tiles = useSessionTiles({ tabId: 'draft-workspace', repoPath: '/fixture', liveSessionKeys: keys, active: true });
  const parent = useComposerDraftValue('draft-parent', 'input', '');
  return <OrchestratorDataProvider agents={workers} missionState={null} workspaceTargets={[]} onMissionStateChange={() => {}}>
    <main style={{ display: 'flex', width: 1100, height: 700 }}>
      <SessionTileSurface layout={tiles.layout} focusedSessionKey={tiles.focusedSessionKey}
        onResizeSplit={tiles.resizeSplit} onCloseLeaf={tiles.closeSessionLeafById} onFocusSession={tiles.setFocusedSessionKey}
        chatSlot={<><textarea aria-label="Parent draft" value={parent.value} onChange={event => parent.setValue(event.target.value)} />
          <ThreadWorkerCard group={{ packets: [], scouts: [], sessions: workers }} onFocusSession={key => tiles.splitSessionFromMenu(key, 'vertical')} /></>} />
    </main>
  </OrchestratorDataProvider>;
}
createRoot(document.getElementById('root')).render(<Workspace />);
`;

describe.skipIf(!executablePath)('persisted worker draft workspace in a browser', () => {
  let browser: Browser;
  let page: Page;
  const mutations: string[] = [];
  const errors: string[] = [];

  beforeAll(async () => {
    const result = await esbuild.build({
      stdin: { contents: fixture, resolveDir: process.cwd(), loader: 'jsx' },
      bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
      alias: { '@': path.resolve('src') }, logLevel: 'silent',
      plugins: [{ name: 'unrelated-session-transform', setup(build) {
        build.onResolve({ filter: /SessionTransformMenu$/ }, () => ({ path: 'transform', namespace: 'fixture' }));
        build.onResolve({ filter: /ThreadChatPane$/ }, () => ({ path: 'thread', namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const SessionTransformMenu = () => null; export const ThreadChatPane = () => null;' }));
      } }],
    });
    browser = await chromium.launch({ executablePath: executablePath!, headless: true });
    page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://fixture/**', async route => {
      const request = route.request();
      if (request.isNavigationRequest()) {
        await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/bundle.js"></script>' });
      } else if (request.url().endsWith('/bundle.js')) {
        await route.fulfill({ contentType: 'text/javascript', body: result.outputFiles[0].text });
      } else {
        if (request.method() !== 'GET') mutations.push(request.url());
        const session = new URL(request.url()).searchParams.get('sessionKey');
        await route.fulfill({ json: { transcript: [{ id: 'result-' + session, role: 'assistant', text: 'Existing result for ' + session }] } });
      }
    });
    await page.goto('http://fixture/');
  }, 60_000);

  afterAll(async () => { await browser?.close(); });

  it('reopens two completed workers from their parent controls and restores exact drafts after reload', async () => {
    const drafts = ['  First question?\nKeep spacing.  ', 'Second question: café 🧪\n'];
    const parent = page.getByRole('textbox', { name: 'Parent draft', exact: true });
    expect(await parent.inputValue()).toBe('');
    await page.getByRole('button', { name: /2 subagents/ }).click();
    const visited = new Set<number>();
    for (const index of [0, 1, 0, 1]) {
      const name = index === 0 ? 'First worker' : 'Second worker';
      await page.getByRole('button', { name: new RegExp(name) }).click();
      const input = page.getByRole('textbox', { name: 'Message this worker', exact: true });
      await input.waitFor();
      if (!visited.has(index)) {
        expect(await input.inputValue()).toBe('');
        await input.fill(drafts[index]);
        visited.add(index);
      }
      expect(await input.inputValue()).toBe(drafts[index]);
      expect(await parent.inputValue()).toBe('');
      await page.getByText('Existing result for codex-owned:draft-fixture-' + index, { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Hide ' + name + ' pane', exact: true }).click();
      expect(await input.count()).toBe(0);
    }
    await page.getByRole('button', { name: /First worker/ }).click();
    await page.getByRole('textbox', { name: 'Message this worker', exact: true }).waitFor();
    await page.reload();
    await expect.poll(() => page.getByRole('textbox', { name: 'Message this worker', exact: true }).inputValue()).toBe(drafts[0]);
    expect(await parent.inputValue()).toBe('');
    await page.getByText('Existing result for codex-owned:draft-fixture-0', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Hide First worker pane', exact: true }).click();
    await page.getByRole('button', { name: /2 subagents/ }).click();
    await page.getByRole('button', { name: /Second worker/ }).click();
    await expect.poll(() => page.getByRole('textbox', { name: 'Message this worker', exact: true }).inputValue()).toBe(drafts[1]);
    expect(mutations).toEqual([]);
    expect(errors).toEqual([]);
  });
});
