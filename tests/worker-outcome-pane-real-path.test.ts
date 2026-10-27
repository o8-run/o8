import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { resolveBrowserPath } from '../scripts/bench/measure-browser-boot.mjs';

it('keeps finished-pane actions reachable through extreme splits and expansion', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'o8-outcome-pane-'));
  const server = http.createServer();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const mocks: Record<string, string> = {
      useTranscript: 'export const useTranscript=()=>({messages:[],status:"fresh",error:null});',
      'use-packet-transcript-poll': 'export const usePacketTranscriptPoll=()=>({entries:window.workerEntries,activity:null});',
      useAgentPeerMessages: 'export const useAgentPeerMessages=()=>({messages:[],self:null});',
      SessionTransformMenu: 'export const SessionTransformMenu=()=>null;',
      ThreadChatPane: 'export const ThreadChatPane=()=>null;',
      LiveSessionMesh: 'export const projectLiveSessionMeshParticipants=()=>[];',
      'orchestrator-data-context': 'export const useOrchestratorData=()=>window.workerContext;',
    };
    const bundle = path.join(directory, 'fixture.js');
    await build({ absWorkingDir: process.cwd(), bundle: true, format: 'esm', platform: 'browser', outfile: bundle,
      define: { 'process.env.NODE_ENV': '"production"' }, jsx: 'automatic',
      plugins: [{ name: 'fixture-data', setup(builder) {
        builder.onResolve({ filter: /\/(useTranscript|use-packet-transcript-poll|useAgentPeerMessages|SessionTransformMenu|ThreadChatPane|LiveSessionMesh|orchestrator-data-context)$/ }, args => ({ path: args.path.split('/').at(-1)!, namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
      } }],
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { SessionTileSurface } from './src/components/desktop/workspace-terminal/SessionTileSurface';
        import { addSessionToLayout, createDefaultSessionTileLayout, resizeSessionSplit } from './src/lib/orchestrator/session-tiles';
        import { PALETTES, resolveTheme } from './src/lib/theme/registry';
        const params = new URLSearchParams(location.search);
        const theme = params.get('theme');
        for (const [key, value] of Object.entries(resolveTheme(PALETTES.find(p => p.id === theme), 'solid').cssVars)) document.documentElement.style.setProperty(key, value);
        document.body.style.margin = '0'; document.body.style.fontFamily = 'system-ui';
        window.reviewCalls = [];
        window.workerEntries = [
          { id: 'task', role: 'user', text: 'Preserve input.' },
          { id: 'tool', role: 'assistant', text: '', toolCalls: [{ name: 'shell', args: { command: 'verify' }, status: 'done', result: 'Checks passed.' }] },
          { id: 'final', role: 'assistant', text: 'Kept input exact.\\nFull verification details.' },
        ];
        let layout = ['worker', 'other'].reduce((current, key) => addSessionToLayout(current, key), createDefaultSessionTileLayout());
        const rows = layout.root.children[1];
        layout = resizeSessionSplit(layout, layout.root.id, Number(params.get('columns')));
        layout = resizeSessionSplit(layout, rows.id, Number(params.get('rows')));
        function Fixture() {
          const [finished, setFinished] = useState(false);
          window.finishWorker = () => setFinished(true);
          window.workerContext = { agents: [], missionState: { packets: [{
            id: 'worker-packet', title: 'Preserve input', runtime: 'codex',
            status: finished ? 'awaiting_review' : 'running',
            completionSummary: 'Kept input exact.\\n[PR](https://example.test/pull/42) [Receipt](https://example.test/receipts/42)',
            lane: { laneId: 'worker-lane', sessionKey: 'worker', repoPath: '/fixture' },
          }] }, onOpenO8Panel: detail => window.reviewCalls.push(detail) };
          return <main style={{ width: '100vw', height: '100vh', display: 'flex' }}>
            <SessionTileSurface layout={layout} focusedSessionKey={null} chatSlot={<div>Conversation</div>}
              onResizeSplit={() => {}} onCloseLeaf={() => {}} onFocusSession={() => {}} />
          </main>;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
      ` },
    });
    const script = await readFile(bundle);
    const mutationRequests: string[] = [];
    const handbackRequests: string[] = [];
    server.on('request', (request, response) => {
      if (request.method !== 'GET') mutationRequests.push(request.url ?? '');
      if (request.url?.startsWith('/api/lanes/')) handbackRequests.push(request.url);
      if (request.url?.startsWith('/fixture.js')) { response.setHeader('Content-Type', 'text/javascript'); response.end(script); }
      else if (request.url?.startsWith('/api/')) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(request.url.includes('/diff')
          ? { ok: true, laneId: 'worker-lane', stat: '1 file changed, 1 insertion(+)', diff: '' }
          : { agents: [], lane: { prNumber: 42 } }));
      } else {
        response.setHeader('Content-Type', 'text/html');
        response.end('<html><head><style>*{box-sizing:border-box}button{font:inherit}</style></head><body><div id="root"></div><script>window.process={env:{}};</script><script type="module" src="/fixture.js"></script></body></html>');
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ executablePath: resolveBrowserPath() ?? undefined, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const measurements: Array<{ width: number; height: number }> = [];
    for (const theme of ['light', 'dark']) for (const [width, height] of [[900, 700], [1680, 1050]]) {
      for (const [columns, rows] of [[0.8, 0.2], [0.8, 0.8], [0.2, 0.2], [0.2, 0.8]]) {
        await page.setViewportSize({ width, height });
        await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/?theme=${theme}&columns=${columns}&rows=${rows}`);
        await page.getByText('Preserve input', { exact: true }).waitFor();
        await page.evaluate(() => (window as unknown as { finishWorker: () => void }).finishWorker());
        const card = page.locator('[data-worker-outcome-card]');
        await card.waitFor();
        const bounds = async () => card.evaluate(element => {
          const leaf = element.closest('[data-session-tile-leaf-id]')!.getBoundingClientRect();
          const pane = element.closest('[data-worker-pane]')!.getBoundingClientRect();
          const outside = [...element.querySelectorAll('button, a')].filter(action => {
            const rect = action.getBoundingClientRect();
            return rect.left < Math.max(leaf.left, pane.left) - 1 || rect.right > Math.min(leaf.right, pane.right) + 1
              || rect.top < Math.max(leaf.top, pane.top) - 1 || rect.bottom > Math.min(leaf.bottom, pane.bottom) + 1;
          }).map(action => action.getAttribute('aria-label') || action.textContent);
          return { width: pane.width, height: pane.height, outside };
        });
        const collapsed = await bounds();
        expect(collapsed.outside, `${theme} ${width}x${height} columns ${columns} rows ${rows}`).toEqual([]);
        measurements.push({ width: collapsed.width, height: collapsed.height });
        await card.getByRole('button', { name: 'Review merge', exact: true }).click();
        const reviewCalls = await page.evaluate(() => (window as unknown as { reviewCalls: unknown[] }).reviewCalls);
        expect(reviewCalls).toEqual([{ tab: 'review', reviewLaneId: 'worker-lane', repoPath: '/fixture' }]);
        await card.getByRole('button', { name: 'Show transcript', exact: true }).click();
        await page.getByText('Full verification details.', { exact: false }).waitFor();
        expect((await bounds()).outside).toEqual([]);
        expect(await page.locator('[data-worker-pane] form, [data-worker-state-row], [data-session-cache], [data-worker-handback]').count()).toBe(0);
        expect(await page.locator('[data-worker-open-review]').count()).toBe(1);
        await card.getByRole('button', { name: 'Hide transcript', exact: true }).click();
        expect(await page.evaluate(() => (window as unknown as { workerEntries: unknown[] }).workerEntries.length)).toBe(3);
      }
    }
    expect(errors).toEqual([]);
    expect(mutationRequests).toEqual([]);
    expect(handbackRequests).toEqual([]);
    expect(measurements).toHaveLength(16);
    process.stdout.write(`Outcome pane bounds: ${JSON.stringify(measurements)}\n`);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 90_000);
