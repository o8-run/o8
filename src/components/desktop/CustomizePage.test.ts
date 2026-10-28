/** @vitest-environment jsdom */

import { act, createElement, useState, type ChangeEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomizePage } from './CustomizePage';
import { RetainedCustomizeView } from './customize/RetainedCustomizeView';
import { openCustomizeTab, setCustomizeTab } from './customize/navigation';

describe('CustomizePage skills', () => {
  let host: HTMLDivElement;
  let root: Root;

  const instructionFixture = () => {
    const personal = { id: 'personal', title: 'Personal guide', scope: 'global', repoName: null, body: 'Personal guidance', projects: [], priority: null, file: null };
    const authored = [personal,
      { ...personal, id: 'project', title: 'Project guide', scope: 'project', body: 'Project guidance', projects: ['sample'] },
      { ...personal, id: 'repo', title: 'Repository guide', scope: 'repo', repoName: 'sample' },
    ];
    const references = Array.from({ length: 1700 }, (_, index) => {
      const source = index < 1000 ? 'sample/docs/architecture.md' : 'sample/docs/operations.md';
      return {
        ...personal, id: `spec-ingest:sample:docs:${index}`, scope: 'repo', repoName: 'sample',
        title: `${source} — Section ${index}`,
        body: `Reference section ${index}${index === 1699 ? ' with unique reference needle' : ''}\n\n_Source: ${source} — auto-ingested from repo specs (spec-ingest)._`,
        file: `/fixture/directives/section-${index}.md`,
      };
    });
    const previous = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname !== '/api/cortex/directives') return previous(input, init);
      return Promise.resolve(Response.json({ directives: url.searchParams.has('repoPath') ? [...authored, ...references] : [personal] }));
    });
    return {
      project: { id: 'sample', name: 'Sample', repoPaths: ['/repo/sample'], createdAt: '' },
      registeredRepos: [{ name: 'sample', localPath: '/repo/sample' }],
    };
  };

  it('separates authored counts from indexed sections and browses bounded pages by source', async () => {
    const openedFiles: string[] = [];
    const onFile = (event: Event) => openedFiles.push((event as CustomEvent<{ path: string }>).detail.path);
    window.addEventListener('o8:open-file', onFile);
    try {
      await act(async () => root.render(createElement(CustomizePage, instructionFixture())));
      const tab = [...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Instructions'))!;
      expect(tab.textContent).toBe('Instructions3');
      expect(host.textContent).not.toContain('authored instructions');
      expect(host.textContent).not.toContain('The Instructions count shows authored guidance');
      expect(host.textContent).toContain('Personal guide');
      expect(host.textContent).toContain('Project guide');
      expect(host.textContent).toContain('Repository guide');
      const docs = host.querySelector<HTMLElement>('[aria-label="Indexed documentation"]')!;
      expect(docs).not.toBeNull();
      expect(docs.querySelectorAll('[role="button"]')).toHaveLength(20);
      expect(docs.textContent).toContain('Indexed docs1700');
      expect(docs.textContent).not.toContain('Indexed reference');
      expect(docs.textContent).not.toContain('Document sections indexed for retrieval');
      expect(docs.textContent).not.toContain('Repository rule');
      expect(docs.textContent).toContain('Sections 1 to 20 of 1700');
      const button = (label: string) => [...docs.querySelectorAll('button')].find((item) => item.textContent === label)!;
      expect(button('Previous sections').disabled).toBe(true);
      act(() => button('Next sections').click());
      expect(docs.textContent).toContain('Sections 21 to 40 of 1700');
      expect(docs.querySelectorAll('[role="button"]')).toHaveLength(20);
      act(() => button('Previous sections').click());
      expect(docs.textContent).toContain('Sections 1 to 20 of 1700');
      act(() => button('Next sections').click());
      const source = docs.querySelector<HTMLSelectElement>('[aria-label="Documentation source"]')!;
      act(() => { source.value = 'sample/docs/operations.md'; source.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(docs.textContent).toContain('Sections 1 to 20 of 700');
      act(() => docs.querySelector<HTMLElement>('[role="button"]')!.click());
      expect(docs.textContent).toContain('Reference section 1000');
      act(() => button('Open file ›').click());
      expect(openedFiles).toEqual(['/fixture/directives/section-1000.md']);
      expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    } finally { window.removeEventListener('o8:open-file', onFile); }
  });

  it('searches indexed bodies and sources while retaining authored totals and scope filtering', async () => {
    await act(async () => root.render(createElement(CustomizePage, instructionFixture())));
    const search = host.querySelector<HTMLInputElement>('[aria-label="Search Instructions"]')!;
    const enter = (value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, value);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const docs = () => host.querySelector<HTMLElement>('[aria-label="Indexed documentation"]')!;
    const tab = () => [...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Instructions'))!;
    enter('unique reference needle');
    expect(docs()).not.toBeNull();
    expect(docs().querySelectorAll('[role="button"]')).toHaveLength(1);
    expect(docs().textContent).toContain('Section 1699');
    expect(docs().querySelector('[aria-label="Documentation pages"]')).toBeNull();
    expect(docs().querySelector('[aria-label="Documentation source"]')).not.toBeNull();
    expect(tab().textContent).toBe('Instructions3');
    enter('sample/docs/operations.md');
    expect(docs().textContent).toContain('Sections 1 to 20 of 700');
    const view = host.querySelector<HTMLSelectElement>('[aria-label="Customization view"]')!;
    await act(async () => { view.value = 'personal'; view.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.textContent).toContain('No matching instructions');
    expect(docs()).toBeNull();
    expect(tab().textContent).toBe('Instructions1');
    enter('');
    expect(host.textContent).toContain('Personal guide');
    expect(host.textContent).not.toContain('Project guide');
    for (const scope of ['/repo/sample', 'all']) {
      await act(async () => { view.value = scope; view.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(host.textContent).toContain('Project guide');
      expect(docs().textContent).toContain('Sections 1 to 20 of 1700');
      expect(tab().textContent).toBe('Instructions3');
    }
  });

  it('offers this project repositories inside Plugins without another section roundtrip', async () => {
    const fetcher = vi.mocked(fetch);
    const previous = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((input, init) => String(input) === '/api/customize/actions'
      ? Promise.resolve(Response.json({ installed: [], damaged: [], receipts: [] })) : previous(input, init));
    await act(async () => root.render(createElement(CustomizePage, {
      project: { id: 'sample', name: 'Sample', repoPaths: ['/repo/o8', '/repo/web'], createdAt: '' },
      registeredRepos: [{ name: 'o8', localPath: '/repo/o8' }, { name: 'Web repo', localPath: '/repo/web' }],
    })));
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Plugins')!.click());
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(host.querySelector('[aria-label="Choose action repository"]')).not.toBeNull();
    });
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Choose action repository"]')!.click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.startsWith('Web repo'))!.click());
    expect(host.textContent).toContain('Selected repository: /repo/web');
    expect(host.querySelector('[aria-label="Search Instructions"]')).toBeNull();
  });

  beforeEach(() => {
    setCustomizeTab('rules');
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/panel/repos') {
        return Response.json({ repos: [{ name: 'o8', localPath: '/repo/o8' }] });
      }
      if (url.startsWith('/api/customize/skills?')) return Response.json({ ok: true, instructions: 'Review behavior and verify the result.' });
      if (url.startsWith('/api/customize/inventory')) {
        return Response.json({
          ok: true,
          agents: [],
          hooks: [],
          skills: [
            { name: 'review', description: 'Shared review', scope: 'project', source: 'shared', file: '/repo/o8/.agents/skills/review/SKILL.md' },
            { name: 'visual-check', description: 'Gemini visual checks', scope: 'user', source: 'gemini', file: '/home/.gemini/skills/visual-check/SKILL.md' },
          ],
        });
      }
      if (url.startsWith('/api/cortex/directives')) return Response.json({ directives: [] });
      if (url === '/api/setup/mcp-servers') return Response.json({ servers: [] });
      if (url === '/api/customize/actions') return Response.json({ installed: [], damaged: [], receipts: [] });
      if (url.startsWith('/api/projects/context')) return Response.json({ context: { id: 'sample', runtimeProjectId: 'sample', settingsProjectId: 'sample', instructions: 'Shared instructions' }, taskBrief: 'Sample project' });
      if (url.startsWith('/api/prompt-library')) return Response.json({ prompts: [] });
      return Response.json({}, { status: 404 });
    }));
  });

  it('distinguishes unmatched instructions from empty inventory and restores rows across scopes', async () => {
    const previous = vi.mocked(fetch).getMockImplementation()!;
    const personal = { id: 'personal', title: 'Personal guide', scope: 'global', repoName: null, body: 'Personal rules', projects: [], priority: null, file: null };
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname !== '/api/cortex/directives') return previous(input, init);
      const path = url.searchParams.get('repoPath');
      return Promise.resolve(Response.json({ directives: [personal, ...(path ? [{ ...personal, id: path, title: 'Repository guide', scope: 'repo', repoName: 'o8' }] : [])] }));
    });
    await act(async () => root.render(createElement(CustomizePage, {
      project: { id: 'sample', name: 'Sample', repoPaths: ['/repo/o8'], createdAt: '' },
      registeredRepos: [{ name: 'o8', localPath: '/repo/o8' }],
    })));
    const search = host.querySelector<HTMLInputElement>('[aria-label="Search Instructions"]')!;
    const enter = (value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, value);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const tab = () => [...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Instructions'))!;
    expect(host.textContent).toContain('Repository guide');
    expect(tab().textContent).toContain('2');
    enter('ZZqv');
    expect(host.textContent).toContain('No matching instructions');
    expect(host.textContent).toContain('ZZqv');
    expect(host.textContent).not.toContain('No additional rules');
    expect(tab().textContent).toContain('2');
    const view = host.querySelector<HTMLSelectElement>('[aria-label="Customization view"]')!;
    for (const scope of ['/repo/o8', 'personal', 'all']) {
      await act(async () => { view.value = scope; view.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(host.textContent).toContain('No matching instructions');
      expect(tab().textContent).toContain(scope === 'personal' ? '1' : '2');
      enter('');
      expect(host.textContent).toContain('Personal guide');
      expect(host.textContent?.includes('Repository guide')).toBe(scope !== 'personal');
      enter('ZZqv');
    }
    enter('');
    expect(host.textContent).toContain('Repository guide');
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it('keeps empty-inventory guidance when no instructions exist', async () => {
    await act(async () => root.render(createElement(CustomizePage)));
    expect(host.textContent).toContain('No additional rules');
    expect(host.textContent).not.toContain('Rules appear here with their source and scope.');
    expect(host.textContent).not.toContain('No matching instructions');
  });

  it('keeps the dedicated Plugins page separate from customization navigation', async () => {
    const props = {
      project: { id: 'sample', name: 'Sample', repoPaths: ['/repo/o8'], createdAt: '' },
      registeredRepos: [{ name: 'o8', localPath: '/repo/o8' }],
    };
    const event = vi.fn();
    window.addEventListener('o8:open-customize', event);
    try {
      openCustomizeTab('plugins');
      expect((event.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: 'plugins' });
      await act(async () => root.render(createElement(CustomizePage, { ...props, fixedTab: 'plugins' })));
      expect(host.querySelector('h1')?.textContent).toBe('Plugins');
      expect(host.querySelector('[aria-label="Customization sections"]')).toBeNull();
      await vi.waitFor(async () => {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(host.querySelector('[aria-label="Choose action repository"]')).not.toBeNull();
      });
      await act(async () => openCustomizeTab('rules'));
      expect(host.querySelector('h1')?.textContent).toBe('Plugins');
      await act(async () => root.render(createElement(CustomizePage, props)));
      expect(host.querySelector('[aria-label="Search Instructions"]')).not.toBeNull();
      await act(async () => openCustomizeTab('plugins'));
      expect(host.querySelector('[aria-label="Search Instructions"]')).not.toBeNull();
    } finally { window.removeEventListener('o8:open-customize', event); }
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it('reaches the universal inventory through Skills and searches its metadata', async () => {
    await act(async () => {
      root.render(createElement(CustomizePage, { project: { id: 'sample', name: 'Sample', repoPaths: ['/repo/o8'], createdAt: '' }, registeredRepos: [{ name: 'o8', localPath: '/repo/o8' }] }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const skillsTab = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.startsWith('Skills'));
    act(() => skillsTab?.click());
    expect(host.querySelector('h1')?.textContent).toBe('Customize');
    expect(host.textContent).toContain('Discovered skills');
    expect(host.textContent).toContain('review');
    expect(host.textContent).toContain('visual-check');
    expect(skillsTab?.textContent).toContain('2');

    const search = host.querySelector<HTMLInputElement>('input[placeholder^="Search Skills"]');
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(search, 'gemini');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(host.textContent).toContain('visual-check');
    expect(host.textContent).not.toContain('Shared review');
  });

  it('shows unavailable inventory instead of claiming no skills when loading fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/panel/repos') return Response.json({ repos: [] });
      return Response.json({}, { status: 503 });
    }));
    await act(async () => {
      root.render(createElement(CustomizePage));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const skillsTab = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.startsWith('Skills'));
    act(() => skillsTab?.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not load');
    expect(host.textContent).not.toContain('No skills discovered');
  });

  it('keeps both project repositories visible, excludes other projects, and filters without changing membership', async () => {
    const registeredRepos = [
      { name: 'web', localPath: '/repo/web' }, { name: 'api', localPath: '/repo/api' }, { name: 'other', localPath: '/repo/other' },
    ];
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/customize/inventory') {
        const path = url.searchParams.get('repo');
        return Response.json({ ok: true, agents: [], hooks: [], skills: [
          { name: 'personal-review', description: 'Personal guide', scope: 'user', source: 'shared', file: '/home/skills/review/SKILL.md' },
          ...(path ? [{ name: `${path.split('/').pop()}-review`, description: 'Repository guide', scope: 'project', source: 'shared', file: `${path}/.agents/skills/review/SKILL.md` }] : []),
        ] });
      }
      if (url.pathname === '/api/projects/context') return Response.json({ context: { id: 'sample', runtimeProjectId: 'sample', settingsProjectId: 'sample', instructions: 'Shared instructions' } });
      if (url.pathname === '/api/cortex/directives') return Response.json({ directives: [] });
      if (url.pathname === '/api/setup/mcp-servers') return Response.json({ servers: [] });
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal('fetch', fetcher);
    const project = { id: 'sample', name: 'Sample product', repoPaths: ['/repo/web', '/repo/api'], createdAt: '' };
    await act(async () => { root.render(createElement(CustomizePage, { project, registeredRepos })); });
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Skills'))?.click());
    expect(host.textContent).toContain('Sample product · 2 repositories');
    expect(host.textContent).toContain('web-review');
    expect(host.textContent).toContain('api-review');
    expect(host.textContent?.match(/personal-review/g)).toHaveLength(1);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes(encodeURIComponent('/repo/other')))).toBe(false);
    const view = host.querySelector<HTMLSelectElement>('select[aria-label="Customization view"]')!;
    await act(async () => { view.value = '/repo/api'; view.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.textContent).toContain('api-review');
    expect(host.textContent).not.toContain('web-review');
    expect(project.repoPaths).toEqual(['/repo/web', '/repo/api']);
    expect(fetcher.mock.calls.every((call) => !('method' in (call[1] ?? {})))).toBe(true);
    await act(async () => { view.value = 'all'; view.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(host.textContent).toContain('web-review');
    expect(host.textContent).toContain('api-review');
    await act(async () => { view.value = '/repo/api'; view.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { root.render(createElement(CustomizePage, { project: { ...project, repoPaths: ['/repo/web'] }, registeredRepos })); });
    expect(view.value).toBe('all');
    expect(host.textContent).toContain('web-review');
    expect(host.textContent).not.toContain('api-review');
    await act(async () => { root.render(createElement(CustomizePage, { project: { ...project, id: 'other', name: 'Other project', repoPaths: ['/repo/other'] }, registeredRepos })); });
    expect(host.textContent).toContain('other-review');
    expect(host.textContent).not.toContain('web-review');
    expect(host.textContent).not.toContain('api-review');
  });

  it('inserts a saved prompt once, does not replay it after Customize re-entry, and allows another explicit insert', async () => {
    const savedPrompt = {
      id: 'prompt-api',
      title: 'Synthetic API prompt',
      body: 'Check the synthetic API contract.',
      tags: ['api'],
      scope: 'global',
      repoPath: null,
      sourceKind: 'manual',
      sourceId: null,
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      useCount: 0,
    };
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/customize/inventory') {
        return Response.json({ ok: true, agents: [], hooks: [], skills: [] });
      }
      if (url.pathname === '/api/cortex/directives') return Response.json({ directives: [] });
      if (url.pathname === '/api/setup/mcp-servers') return Response.json({ servers: [] });
      if (url.pathname === '/api/prompt-library' && url.searchParams.has('scope')) {
        return Response.json({ ok: true, prompts: [savedPrompt] });
      }
      if (url.pathname === '/api/prompt-library/prompt-api/use') return Response.json({ ok: true });
      return Response.json({}, { status: 404 });
    }));

    function Harness() {
      const [customizing, setCustomizing] = useState(true);
      const [draft, setDraft] = useState('');
      if (customizing) {
        return createElement(CustomizePage, { onClose: () => setCustomizing(false) });
      }
      return createElement('div', null,
        createElement('textarea', {
          'data-o8-active-composer': 'true',
          value: draft,
          onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.currentTarget.value),
        }),
        createElement('button', { type: 'button', onClick: () => setCustomizing(true) }, 'Customize'),
      );
    }

    const findButton = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((candidate) => candidate.textContent?.trim() === label);
    const settle = async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const flushFrames = () => {
      while (animationFrames.length > 0) {
        const frame = animationFrames.shift();
        act(() => frame?.(performance.now()));
      }
    };
    const insertSavedPrompt = async () => {
      act(() => findButton('Prompts')?.click());
      await settle();
      const row = [...host.querySelectorAll<HTMLElement>('[role="button"]')]
        .find((candidate) => candidate.textContent?.includes(savedPrompt.title));
      act(() => row?.click());
      act(() => findButton('Insert')?.click());
      flushFrames();
    };
    const insertedCount = () => (
      host.querySelector<HTMLTextAreaElement>('textarea[data-o8-active-composer="true"]')
        ?.value.match(/Check the synthetic API contract\./g) ?? []
    ).length;

    await act(async () => { root.render(createElement(Harness)); });
    await settle();
    await insertSavedPrompt();
    expect(insertedCount()).toBe(1);

    act(() => findButton('Customize')?.click());
    await settle();
    act(() => findButton('Back to workspace')?.click());
    flushFrames();
    expect(insertedCount()).toBe(1);

    act(() => findButton('Customize')?.click());
    await settle();
    await insertSavedPrompt();
    expect(insertedCount()).toBe(2);
  });

  it('keeps skill inspection state on return and inserts the selected skill into the draft without sending', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    const openedFiles: string[] = [];
    const onFile = (event: Event) => openedFiles.push((event as CustomEvent<{ path: string }>).detail.path);
    window.addEventListener('o8:open-file', onFile);
    function Harness() {
      const [customizing, setCustomizing] = useState(true);
      const [draft, setDraft] = useState('Review this change. ');
      return createElement('div', null,
        createElement(RetainedCustomizeView, { active: customizing },
          createElement(CustomizePage, {
            project: { id: 'sample', name: 'Sample', repoPaths: ['/repo/o8'], createdAt: '' },
            registeredRepos: [{ name: 'o8', localPath: '/repo/o8' }],
            onClose: () => setCustomizing(false),
          }),
        ),
        createElement('div', { hidden: customizing },
          createElement('textarea', {
            'data-o8-active-composer': 'true', value: draft,
            onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.currentTarget.value),
          }),
          createElement('button', { onClick: () => setCustomizing(true) }, 'Return to Customize'),
        ),
      );
    }
    const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((item) => item.textContent?.trim() === label)!;
    try {
      await act(async () => { root.render(createElement(Harness)); });
      act(() => [...host.querySelectorAll('button')].find((item) => item.textContent?.startsWith('Skills'))!.click());
      const search = host.querySelector<HTMLInputElement>('input[placeholder^="Search Skills"]')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'Shared review');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() => host.querySelector<HTMLElement>('[role="button"]')!.click());
      act(() => button('Open file ›').click());
      expect(openedFiles).toEqual(['/repo/o8/.agents/skills/review/SKILL.md']);
      await act(async () => button('Return to Customize').click());
      expect(host.querySelector<HTMLInputElement>('input[placeholder^="Search Skills"]')?.value).toBe('Shared review');
      expect(button('Use in task')).toBeDefined();
      const composer = host.querySelector<HTMLTextAreaElement>('textarea[data-o8-active-composer]')!;
      composer.setSelectionRange(composer.value.length, composer.value.length);
      await act(async () => button('Use in task').click());
      while (frames.length) act(() => frames.shift()!(performance.now()));
      expect(composer.value).toContain('Review this change. Use the "review" skill for this task.');
      expect(composer.value).toContain('Review behavior and verify the result.');
      expect(composer.value).not.toContain('/repo/o8/.agents/skills/review/SKILL.md');
      expect(composer.value).not.toContain('/home/.gemini');
      expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    } finally {
      window.removeEventListener('o8:open-file', onFile);
    }
  });

});
