/** Saved tool references and production visualization reads for native acceptance. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export default async function register({ repo, dataDir, seeds }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--visualizations')) return {};
  const { insertVisualization } = await import('../../../src/lib/visualizations/store');
  const { GET } = await import('../../../src/app/api/visualizations/[id]/route');
  const id = 'vis-49720000-0000-4000-8000-000000000001';
  const reference = { kind: 'o8-visualization' as const, id, title: 'Weekly activity', height: 320, createdAt: '2026-10-01T00:00:02.000Z' };
  const html = `<section style="height:320px;padding:20px"><h2>Weekly activity</h2><p>Explore the weekly plan.</p>
    <label>Week <select id="week" data-o8-control="week"><option value="1">Week 1</option><option value="2">Week 2</option></select></label>
    <button id="bar" title="Tuesday: 7 tasks" style="display:block;margin-top:24px;width:65%;height:80px;background:var(--chart-3);color:var(--foreground);border:0;border-radius:10px">Tuesday · 7 tasks</button>
    <p id="selection">Week 1 selected</p></section><script>
    const control = document.querySelector('#week');
    const apply = state => { if (state.week) control.value = state.week; document.querySelector('#selection').textContent = 'Week ' + control.value + ' selected'; };
    apply(window.__o8Visualization.initialState);
    addEventListener('o8:visualization-state', event => apply(event.detail));
    control.addEventListener('change', () => { apply({week:control.value}); window.__o8Visualization.post('state',{week:control.value}); });
    </script>`;
  insertVisualization({ ...reference, html, repoPath: repo, threadId: 'thoughts-visualization', packetId: null });
  insertVisualization({ ...reference, id: 'vis-49720000-0000-4000-8000-000000000003',
    html: readFileSync('native/o8-next/fixtures/visualization-sandbox.html', 'utf8'),
    repoPath: repo, threadId: 'thoughts-visualization', packetId: null });
  const missing = { ...reference, id: 'vis-49720000-0000-4000-8000-000000000002', title: 'Missing visualization' };
  const messages = Array.from({ length: 80 }, (_, index) => ({ id: `visual-${index}`, role: index % 2 ? 'assistant' : 'user',
    content: index === 3 ? 'The weekly plan is interactive below.' : `Transcript message ${index + 1}. ${'Keep the card attached to this conversation. '.repeat(3)}`,
    timestamp: 1790812800000 + index * 1000,
    ...([3, 7].includes(index) ? { toolCalls: [{ id: `visual-tool-${index}`, name: 'o8_html_render', status: 'completed',
      args: { title: reference.title }, result: JSON.stringify({ visualization: index === 3 ? reference : missing }) }] } : {}),
  }));
  const seed = { id: 'thoughts-visualization', title: 'Visualization cards', messages };
  seeds.push(seed);
  writeFileSync(join(dataDir, 'chat-history', `${seed.id}.json`), JSON.stringify({ ...seed, repoPath: repo,
    backend: 'claude', model: 'claude-code', orchestratorVisible: true, savedAt: '2026-10-01T01:00:00.000Z' }));
  return { match: (method, path) => method === 'GET' && path.startsWith('/api/visualizations/')
    ? request => GET(request, { params: Promise.resolve({ id: path.slice('/api/visualizations/'.length) }) }) : undefined };
}
