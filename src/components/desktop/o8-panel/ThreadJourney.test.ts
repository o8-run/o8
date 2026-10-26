// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { O8ThreadsPane } from './O8ThreadsPane';
import type { TaskPoolTask } from '../repo-focus/tabs/control-room/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';

vi.mock('../orchestrator-data-context', () => ({ useOrchestratorData: () => ({ agents: [], missionState: { packets: [] } }) }));
vi.mock('../repo-registry/useProjects', () => ({ useProjects: () => ({ loading: false, activeProject: { id: 'project', name: 'Parser project', repoPaths: ['/repo'] }, ledger: { projects: [] } }) }));
vi.mock('@/lib/tauri/ipc-fetch', () => ({ ipcFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const task = { id: 'parser-task', packetId: 'parser-task', title: 'Parser decision', repoPath: '/repo', status: 'awaiting_review', group: 'review', runtime: 'codex', project: { id: 'project' }, summary: 'Choose the parser result',
  thread: { kind: 'packet', state: 'review', sessionKey: 'codex:parser', observedAt: '2026-10-25T00:00:00Z', childIds: [], truncated: false,
    requirements: [{ id: 'R1', text: 'Reject invalid input', covered: false, verification: 'Run parser test', head: null }],
    artifacts: [{ id: 'report', title: 'Parser evidence', kind: 'report', href: '/api/panel/artifacts/content/report.json' }],
    merges: [{ id: 'pr1', title: 'Parser fix', url: 'https://github.com/fixture/repo/pull/1', state: 'open', checks: 'running', head: 'a'.repeat(40) }],
    workers: [{ sessionKey: 'codex:parser', name: 'Parser worker', runtime: 'codex', model: 'fixture-model', status: 'working', tokens: 150, tools: 3, toolsTruncated: false, stage: 'Wave 1' }],
    stages: [{ name: 'Wave 1', done: 0, total: 1 }], history: [{ id: 'review', at: '2026-10-25T00:00:00Z', label: 'Review requested' }],
  },
} as unknown as TaskPoolTask;
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); vi.unstubAllGlobals(); });
async function show(record = task, records = [record]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/content/') ? new Response('{"result":"Parser verified"}')
    : new Response(JSON.stringify({ tasks: records, task: record, repos: [], nextOffset: null }))));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(createElement(O8ThreadsPane, { active: true, repoPath: '/repo', repos: [{ id: 'repo', name: 'Repo', localPath: '/repo' }] as RepoRegistryEntry[] })));
}
it('opens the exact decision with recorded requirements, artifacts, merges and worker telemetry without a mutation', async () => {
  await show();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="View thread Parser decision"]')!.click());
  expect.soft(container.textContent).toContain('Reject invalid input');
  expect.soft(container.textContent).toContain('Parser evidence');
  expect.soft(container.textContent).toContain('Parser fix');
  expect.soft(container.textContent).toContain('150');
  expect.soft(container.textContent).toContain('3 tools');
  expect.soft(container.textContent).toContain('Wave 1');
  expect(vi.mocked(fetch).mock.calls.some(call => call[1]?.method === 'POST')).toBe(false);
});
it('offers project Library, Merges and History alongside the preserved thread and agent views', async () => {
  await show();
  for (const label of ['Threads', 'Library', 'Merges', 'History', 'Agents']) expect.soft([...container.querySelectorAll('[role="tab"]')].some(node => node.textContent === label)).toBe(true);
  const library = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(node => node.textContent === 'Library');
  if (library) { await act(async () => library.click()); expect(container.textContent).toContain('Parser evidence'); }
});

it('reads recorded tool telemetry from the project Agents view on demand', async () => {
  await show();
  const listTask = { ...task, thread: { ...task.thread!, workers: task.thread!.workers.map(worker => ({ ...worker, tools: null })) } };
  vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes('taskId=') ? { task } : { tasks: [listTask], nextOffset: null })));
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Refresh')!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === 'Agents')!.click());
  const read = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Read recorded tools');
  expect(read).toBeDefined();
  await act(async () => read!.click());
  expect(container.textContent).toContain('3 tools');
  expect(vi.mocked(fetch).mock.calls.some(call => String(call[0]).includes('taskId=parser-task'))).toBe(true);
});
it('keeps interactive artifact previews sandboxed and rejects evidence from a different repository', async () => {
  await show();
  vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes('taskId=')
    ? { task: { ...task, repoPath: '/foreign', thread: { ...task.thread!, artifacts: [{ id: 'foreign', title: 'Foreign report', href: '/api/foreign', kind: 'report' }] } } }
    : { tasks: [task], nextOffset: null })));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="View thread Parser decision"]')!.click());
  expect(container.textContent).toContain('Thread evidence identity did not match');
  expect(container.textContent).not.toContain('Foreign report');
  const artifact = { id: 'interactive', title: 'Interactive evidence', kind: 'interactive', href: '/api/task-artifacts/interactive', interactive: true };
  vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes('/api/task-artifacts/')
    ? { result: { artifact: { id: 'interactive', html: '<button onclick="fetch(\'/mutate\')">Inspect</button><script>fetch("/mutate")</script>' } } }
    : { tasks: [{ ...task, thread: { ...task.thread!, artifacts: [artifact] } }], task: { ...task, thread: { ...task.thread!, artifacts: [artifact] } }, nextOffset: null })));
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Refresh')!.click());
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Interactive evidence')!.click());
  const frame = container.querySelector('iframe');
  expect(frame?.getAttribute('sandbox')).toBe('');
  expect(frame?.getAttribute('srcdoc')).toContain('Inspect');
  expect(vi.mocked(fetch).mock.calls.some(call => call[1]?.method === 'POST' || String(call[0]).includes('/mutate'))).toBe(false);
});

const privateSecret = 'synthetic-view-credential-8341';
const privateHome = '/' + ['Users', 'synthetic-view-owner', 'private'].join('/');
const privateCanary = `Authorization: Bearer ${privateSecret} at ${privateHome}/report.json`;
function expectViewRedacted() {
  expect.soft(container.innerHTML).not.toContain(privateSecret);
  expect.soft(container.innerHTML).not.toContain(privateHome);
  expect.soft(container.innerHTML).toContain('[redacted]');
  expect.soft(container.innerHTML).toContain('~/private');
}
it('redacts recorded handoffs and task titles in the project History view', async () => {
  const record = { ...task, title: privateCanary, thread: { ...task.thread!, history: [{ id: 'private-handoff', at: '2026-10-25T00:00:00Z', label: privateCanary }] } };
  await show(record);
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === 'History')!.click());
  expectViewRedacted();
});
it.each(['report', 'file', 'interactive'])('redacts %s artifact titles and fetched evidence bodies in the Library view', async kind => {
  const artifact = { id: 'private-artifact', title: `Evidence ${privateCanary}`, kind, href: '/api/panel/threads/artifact?id=private-artifact', interactive: kind === 'interactive' };
  const record = { ...task, thread: { ...task.thread!, artifacts: [artifact] } };
  await show(record);
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === 'Library')!.click());
  vi.mocked(fetch).mockImplementation(async () => kind === 'interactive'
    ? Response.json({ result: { artifact: { id: artifact.id, html: `<pre>Benign report body ${privateCanary} ${JSON.stringify({ password: privateSecret })}</pre>` } } })
    : kind === 'file' ? Response.json({ content: `Benign report body ${privateCanary}` }) : new Response(JSON.stringify({ token: privateSecret, note: `Benign report body ${privateCanary}` })));
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('Evidence '))!.click());
  expectViewRedacted();
  expect(container.innerHTML).toContain('Benign report body');
  if (kind === 'interactive') expect(container.querySelector('iframe')?.getAttribute('sandbox')).toBe('');
});

it.each(['approval', 'inbox'])('requires project identity for an orphan %s in the project view', async kind => {
  const own = { ...task, id: `own-${kind}`, title: 'Own project decision', thread: { ...task.thread!, kind } } as TaskPoolTask;
  const unknown = { ...own, id: `unknown-${kind}`, title: 'Unowned private decision', project: null };
  await show(own, [own, unknown]);
  expect(container.textContent).toContain('Own project decision');
  expect(container.textContent).not.toContain('Unowned private decision');
});

it.each(['screenshot', 'video'])('fetches protected %s evidence through authenticated IPC and releases the media URL', async kind => {
  const create = vi.fn(() => 'blob:http://localhost/thread-evidence');
  const revoke = vi.fn();
  vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
  const href = '/api/panel/threads/artifact?id=protected-media';
  const artifact = { id: 'protected-media', title: 'Protected media', kind, href };
  await show({ ...task, thread: { ...task.thread!, artifacts: [artifact] } });
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === 'Library')!.click());
  vi.mocked(fetch).mockClear().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': kind === 'screenshot' ? 'image/png' : 'video/webm' } }));
  const toggle = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Protected media')!;
  await act(async () => toggle.click());
  expect(fetch).toHaveBeenCalledWith(href, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(create).toHaveBeenCalledTimes(1);
  expect(container.querySelector(kind === 'screenshot' ? 'img' : 'video')?.getAttribute('src')).toBe('blob:http://localhost/thread-evidence');
  await act(async () => toggle.click());
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:http://localhost/thread-evidence');
});
