// @vitest-environment jsdom
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { open as pickDirectory } from '@tauri-apps/plugin-dialog';
import { AddRepoDialog } from '@/components/desktop/repo-registry/AddRepoDialog';
import { POST as registerRepo } from '@/app/api/panel/repos/route';
import { getDataDir } from '@/lib/data-dir-migration';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));
vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn(), startChangePolling: vi.fn(), stopChangePolling: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/cortex/spec-ingest', () => ({
  ingestRepoSpecs: async () => ({ scannedFiles: 0, writtenDirectives: 0, deletedStaleDirectives: 0 }),
  purgeOrphanedSpecDirectives: () => ({ purged: 0, slugs: [] }),
}));

const fixtureRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'o8-picked-repo-')));
const fetchMock = vi.fn<typeof fetch>();
const onRepoAdded = vi.fn();
const onClose = vi.fn();
let root: Root;
let host: HTMLDivElement;
let selected: string | null;
let failRegistration = false;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  vi.clearAllMocks();
  selected = null;
  failRegistration = false;
  vi.mocked(pickDirectory).mockResolvedValue(null);
  fetchMock.mockImplementation(async (url, init) => {
    if (String(url) === '/api/panel/browse-folder') return Response.json({ path: selected });
    if (String(url) === '/api/panel/repos' && init?.method === 'POST') {
      if (failRegistration) return Response.json({ error: 'Try opening the folder again.' }, { status: 400 });
      return registerRepo(new Request('http://localhost/api/panel/repos', init));
    }
    return Response.json({ repos: [] });
  });
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

async function mount() {
  await act(async () => root.render(createElement(StrictMode, null, createElement(AddRepoDialog, {
    open: true, projects: [], activeProjectId: null, onClose, onRepoAdded,
  }))));
  await settle();
}
async function settle() {
  for (let attempt = 0; attempt < 100; attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    if (!document.querySelector('[role="status"]')) return;
  }
  expect(document.querySelector('[role="status"]')).toBeNull();
}
async function submit() {
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await settle();
}
function writes() {
  return fetchMock.mock.calls.filter(([url, init]) => String(url) === '/api/panel/repos' && init?.method === 'POST')
    .map(([, init]) => JSON.parse(String(init?.body)) as { localPath: string });
}
function expectRegistered(expected: string) {
  expect(writes().at(-1)).toEqual({ action: 'add', localPath: expected });
  expect(onRepoAdded).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ localPath: expected }));
  expect(onClose).toHaveBeenCalledOnce();
  const persisted = JSON.parse(readFileSync(path.join(getDataDir(), 'repos.json'), 'utf8'));
  expect(persisted.repos).toContainEqual(expect.objectContaining({ localPath: expected }));
}

it.each([' leading', 'trailing ', '\n', '\nleading', 'trailing\n', ' \n '])(
  'registers the native selection %j with its exact path bytes', async name => {
    selected = path.join(mkdtempSync(path.join(fixtureRoot, 'case-')), name);
    mkdirSync(selected);
    execFileSync('git', ['init', '-q', selected]);
    vi.mocked(pickDirectory).mockResolvedValue(selected);
    await mount();
    expectRegistered(selected);
  },
);

it('preserves the server picker selection and its exact path on retry', async () => {
  selected = path.join(fixtureRoot, 'server selection \n');
  mkdirSync(selected);
  vi.mocked(pickDirectory).mockRejectedValueOnce(new Error('Native dialog unavailable'));
  failRegistration = true;
  await mount();
  expect(document.querySelector('[role="alert"]')).not.toBeNull();
  failRegistration = false;
  await submit();
  expectRegistered(selected);
});

it('keeps typed input normalization separate from a selected path', async () => {
  const typedPath = path.join(fixtureRoot, 'typed project');
  mkdirSync(typedPath);
  await mount();
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('#add-repo-path')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, `  ${typedPath}  `);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await submit();
  expectRegistered(typedPath);
});

it('reopens a recent folder without normalizing its stored path', async () => {
  selected = path.join(fixtureRoot, 'recent project\n');
  mkdirSync(selected);
  localStorage.setItem('o8:recent-repo-folders', JSON.stringify([{ name: 'Recent project', localPath: selected }]));
  await mount();
  await act(async () => document.querySelector<HTMLButtonElement>('nav[aria-label="Recent folders"] button')!.click());
  await settle();
  expectRegistered(selected);
});

it('preserves a dropped filesystem path through registration', async () => {
  selected = path.join(fixtureRoot, 'dropped project \n');
  mkdirSync(selected);
  await mount();
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: {
    files: [], getData: (type: string) => type === 'text/uri-list' ? pathToFileURL(selected!).href : '',
  } });
  await act(async () => document.querySelector('form')!.dispatchEvent(drop));
  await settle();
  expectRegistered(selected);
});
