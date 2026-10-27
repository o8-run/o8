// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchOperatorDefaultsMock } = vi.hoisted(() => ({
  fetchOperatorDefaultsMock: vi.fn(),
}));

vi.mock('./operator-defaults-client', () => ({
  fetchOperatorDefaults: fetchOperatorDefaultsMock,
}));

import { WorktreeRetentionSection } from './WorktreeRetentionSection';

const defaults = {
  values: {
    worktreeMaxCount: 20,
    worktreeMaxTotalGb: 50,
    storageReserveRatio: 0.1,
    storageReserveFloorGb: 10,
    workspaceParkingMode: 'manual',
  },
  sources: {
    worktreeMaxCount: 'default',
    worktreeMaxTotalGb: 'default',
    storageReserveRatio: 'default',
    storageReserveFloorGb: 'default',
    workspaceParkingMode: 'default',
  },
};

function category(
  name: 'source' | 'dependency' | 'build' | 'runtime' | 'transcript',
  allocatedBytes: number | null,
  logicalBytes: number | null,
  measurementMethod: 'workspace-residual' | 'known-path-sum' | 'owned-root-residual' | 'owned-session-artifact-sum',
) {
  return {
    category: name,
    measurementMethod,
    accountingStatus: allocatedBytes === null && logicalBytes === null ? 'unknown' : 'observed',
    allocatedBytes,
    logicalBytes,
  };
}

const observedCategories = {
  source: category('source', 512 * 1024 ** 2, 768 * 1024 ** 2, 'workspace-residual'),
  dependency: category('dependency', 256 * 1024 ** 2, 512 * 1024 ** 2, 'known-path-sum'),
  build: category('build', 128 * 1024 ** 2, 256 * 1024 ** 2, 'known-path-sum'),
  runtime: category('runtime', 64 * 1024 ** 2, 96 * 1024 ** 2, 'owned-root-residual'),
  transcript: category('transcript', 32 * 1024 ** 2, 48 * 1024 ** 2, 'owned-session-artifact-sum'),
};

const observedUsage = {
  schema: 'o8/worktree-storage-telemetry/v1',
  accountingStatus: 'observed',
  totalCount: 2,
  totalBytes: 1024 ** 3,
  totalAllocatedBytes: 1024 ** 3,
  totalLogicalBytes: 2 * 1024 ** 3,
  totalGb: 1,
  categoryStorage: {
    schema: 'o8/storage-category-telemetry/v1',
    measuredAt: '2026-08-15T12:00:00.000Z',
    accountingStatus: 'observed',
    freshness: { source: 'cache', ageMs: 2_000, ttlMs: 5_000 },
    categories: observedCategories,
    repos: [],
  },
  storageAdmission: {
    accountingStatus: 'observed',
    physicalAvailableBytes: 40 * 1024 ** 3,
    reservedBytes: 2 * 1024 ** 3,
    requiredReserveBytes: 10 * 1024 ** 3,
    dispatchHeadroomBytes: 28 * 1024 ** 3,
    activeReservations: 1,
  },
  storagePressure: {
    mode: 'pressure',
    automaticParkingEnabled: true,
    eligibleRepositories: 3,
    optedOutRepositories: 1,
    parkedWorkspaces: 2,
    repositories: [
      { id: 'repo-o8', name: 'o8', parkingDisabled: false },
      { id: 'repo-private', name: 'Private', parkingDisabled: true },
    ],
  },
  repos: [{
    name: 'o8',
    path: '/worktrees',
    count: 2,
    bytes: 1024 ** 3,
    allocatedBytes: 1024 ** 3,
    logicalBytes: 2 * 1024 ** 3,
  }],
};

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('WorktreeRetentionSection storage accounting', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchOperatorDefaultsMock.mockReset().mockResolvedValue(Response.json(defaults));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('opens a repository-scoped cleanup review and requires an explicit selection and confirmation', async () => {
    const plan = { id: 'cleanup-fixture', repositoryPath: '/fixture/repo', fingerprint: 'reviewed-fingerprint',
      status: 'preview', selection: null, outcomes: [], observedFreeSpace: [{ observedAt: 1, availableBytes: 1024 }], entries: [
        { id: 'workspace:done', worktreeId: 'done', kind: 'workspace', eligible: true, workspacePath: '/fixture/repo/done',
          dependencies: [], estimate: { logicalBytes: null }, recovery: { ref: 'refs/heads/kept' } },
        { id: 'workspace:active', worktreeId: 'active', kind: 'workspace', eligible: false, reason: 'Not terminal',
          dependencies: [], estimate: { logicalBytes: null }, recovery: {} },
      ] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/panel/repos')) return Response.json({ repos: [{ id: 'repo', name: 'Fixture', localPath: '/fixture/repo' }] });
      if (String(input).includes('/workspace/maintenance')) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return Response.json({ ok: true, result: { plan: body.action === 'execute' ? { ...plan, status: 'settled',
          selection: ['workspace:done'], outcomes: [{ entryId: 'workspace:done', state: 'removed', recovery: { ref: 'refs/heads/kept' } }] } : plan } });
      }
      return Response.json(observedUsage);
    });
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(createElement(WorktreeRetentionSection)); await settle(); });
    const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent?.trim() === label)!;
    expect(button('Review cleanup')).toBeDefined();
    await act(async () => { button('Review cleanup').click(); await settle(); });
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Cleanup repository"]')!;
    await act(async () => { select.value = '/fixture/repo'; select.dispatchEvent(new Event('change', { bubbles: true })); await settle(); });
    await act(async () => { button('Preview cleanup').click(); await settle(); });
    expect(button('Clean selected')?.disabled).toBe(true);
    const checkboxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checkboxes.find(node => node.disabled)).toBeDefined();
    await act(async () => { checkboxes.find(node => !node.disabled)!.click(); await settle(); button('Clean selected').click(); await settle(); });
    expect(fetchMock.mock.calls.filter(([, init]) => String(init?.body).includes('execute'))).toHaveLength(0);
    await act(async () => { button('Confirm cleanup').click(); await settle(); });
    expect(fetchMock.mock.calls.find(([, init]) => String(init?.body).includes('execute'))?.[1]?.body).toBe(JSON.stringify({
      action: 'execute', planId: 'cleanup-fixture', fingerprint: 'reviewed-fingerprint', selection: ['workspace:done'],
    }));
    expect(container.textContent).toContain('removed');
    expect(container.textContent).toContain('refs/heads/kept');
    expect(container.textContent).toContain('Before cleanup: 1024 bytes available');
  });

  it('shows fleet reserve, pressure projection, and observational category accounting', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(observedUsage)));

    await act(async () => {
      root.render(createElement(WorktreeRetentionSection));
      await settle();
    });

    expect(container.querySelector('details')?.open).toBe(false);
    const sections = [...container.querySelectorAll('[data-settings-section]')].map((element) => element.getAttribute('data-settings-section'));
    expect(sections.slice(0, 2)).toEqual(['Storage usage', 'Automatic cleanup']);
    expect(container.textContent).toContain('Disk space used');
    expect(container.textContent).toContain('1.0 GB');
    expect(container.textContent).toContain('Total file size');
    expect(container.textContent).toContain('2.0 GB');
    expect(container.textContent).toContain('2 worktrees across 1 repo');
    expect(container.textContent).toContain('Available for new tasks');
    expect(container.textContent).toContain('28 GB');
    expect(container.textContent).toContain('Automatic parking is active');
    expect(container.textContent).toContain('Parked2');
    expect(container.textContent).toContain('Eligible repos3');
    expect(container.textContent).toContain('Opted out1');
    expect(container.textContent).toContain('o8Eligible reviewing workspaces may park');
    expect(container.textContent).toContain('PrivateAutomatic pressure parking is disabled');
    expect(container.textContent).toContain('Source files');
    expect(container.textContent).toContain('Method: workspace residual');
    expect(container.textContent).toContain('Cached 2s ago');
    expect(container.textContent).toContain('Snapshot 2026-08-15 12:00:00 UTC');
    expect(container.textContent).toContain('neither exclusive nor guaranteed reclaimable');
  });

  it('distinguishes an empty repository list from a failed capacity measurement', async () => {
    const unavailable = { ...observedUsage, totalCount: 0, totalAllocatedBytes: 0, totalLogicalBytes: 0, repos: [],
      storageAdmission: { ...observedUsage.storageAdmission, accountingStatus: 'unknown', physicalAvailableBytes: null, dispatchHeadroomBytes: null, reservedBytes: 0, activeReservations: 0 },
      storagePressure: { ...observedUsage.storagePressure, repositories: [] },
    };
    const fetchMock = vi.fn(async () => Response.json(unavailable));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => { root.render(createElement(WorktreeRetentionSection)); await settle(); });
    expect(container.textContent).toContain('No repositories yet.');
    expect(container.textContent).not.toContain('Could not calculate available task space');
    expect(container.textContent).toContain('Available for new tasks—');
    fetchMock.mockImplementation(async () => Response.json({ ...unavailable, storagePressure: observedUsage.storagePressure }));
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Refresh usage"]')!.click(); await settle(); });
    expect(container.textContent).not.toContain('No repositories yet.');
    expect(container.textContent).toContain('Could not calculate available task space');
    expect(container.textContent).toContain('Available for new tasksUnavailable');
  });

  it('updates parking mode and settles the selected control from the persisted response', async () => {
    const updated = {
      values: { ...defaults.values, workspaceParkingMode: 'pressure' },
      sources: defaults.sources,
    };
    fetchOperatorDefaultsMock
      .mockReset()
      .mockResolvedValueOnce(Response.json(defaults))
      .mockResolvedValueOnce(Response.json(updated));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(observedUsage)));

    await act(async () => {
      root.render(createElement(WorktreeRetentionSection));
      await settle();
    });

    const pressure = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Set workspace parking to pressure"]',
    );
    expect(pressure?.getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      pressure?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });

    expect(fetchOperatorDefaultsMock).toHaveBeenCalledTimes(2);
    expect(fetchOperatorDefaultsMock.mock.calls[1]?.[0]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ workspaceParkingMode: 'pressure' }),
    });
    expect(pressure?.getAttribute('aria-pressed')).toBe('true');
  });

  it('saves zero volume reserve and displays it as zero rather than unlimited', async () => {
    fetchOperatorDefaultsMock.mockReset()
      .mockResolvedValueOnce(Response.json({
        ...defaults, values: { ...defaults.values, storageReserveRatio: 0.01 },
      }))
      .mockResolvedValueOnce(Response.json({
        ...defaults, values: { ...defaults.values, storageReserveRatio: 0 },
      }));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(observedUsage)));
    await act(async () => { root.render(createElement(WorktreeRetentionSection)); await settle(); });

    const heading = container.querySelector('[data-settings-section="Minimum free space"]');
    const section = heading!.parentElement!;
    const decrease = section.querySelector<HTMLButtonElement>('button[aria-label="Decrease"]')!;
    expect(section.textContent).toContain('1 %');
    await act(async () => { decrease.click(); await settle(); });
    expect(fetchOperatorDefaultsMock.mock.calls[1]?.[0]).toMatchObject({
      method: 'POST', body: JSON.stringify({ storageReserveRatio: 0 }),
    });
    expect(section.textContent).toContain('0 %');
    expect(section.textContent).not.toContain('∞');
    expect(decrease.disabled).toBe(true);
  });

  it('serializes settings writes and exposes the durable repository opt-out', async () => {
    let resolveSave: ((response: Response) => void) | null = null;
    fetchOperatorDefaultsMock
      .mockReset()
      .mockResolvedValueOnce(Response.json(defaults))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSave = resolve; }));
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === 'POST'
        ? Response.json({ repo: { id: 'repo-o8', storagePressureParkingDisabled: true } })
        : Response.json(observedUsage)
    ));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(createElement(WorktreeRetentionSection));
      await settle();
    });
    const pressure = container.querySelector<HTMLButtonElement>('button[aria-label="Set workspace parking to pressure"]');
    const increase = container.querySelector<HTMLButtonElement>('button[aria-label="Increase"]');
    await act(async () => {
      pressure?.click();
      increase?.click();
      await settle();
    });
    expect(fetchOperatorDefaultsMock).toHaveBeenCalledTimes(2);
    expect(increase?.disabled).toBe(true);
    await act(async () => {
      resolveSave?.(Response.json({
        values: { ...defaults.values, workspaceParkingMode: 'pressure' },
        sources: defaults.sources,
      }));
      await settle();
    });

    const repoToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Disable pressure parking for o8"]');
    await act(async () => {
      repoToggle?.click();
      await settle();
    });
    expect(fetchMock.mock.calls.find((call) => call[1]?.method === 'POST')?.[1]?.body).toBe(JSON.stringify({
      action: 'update',
      id: 'repo-o8',
      storagePressureParkingDisabled: true,
    }));
  });

  it('shows named repository policy stages through a slow usage refresh', async () => {
    let resolveRepoSave: ((response: Response) => void) | null = null;
    let resolveUsageRefresh: ((response: Response) => void) | null = null;
    const updatedUsage = {
      ...observedUsage,
      storagePressure: {
        ...observedUsage.storagePressure,
        repositories: observedUsage.storagePressure.repositories.map((repo) => (
          repo.id === 'repo-o8' ? { ...repo, parkingDisabled: true } : repo
        )),
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(observedUsage))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRepoSave = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveUsageRefresh = resolve; }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(createElement(WorktreeRetentionSection));
      await settle();
    });
    const repoToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Disable pressure parking for o8"]',
    );
    await act(async () => {
      repoToggle?.click();
      await settle();
    });
    expect(repoToggle?.disabled).toBe(true);
    expect(repoToggle?.textContent).toBe('Saving policy');

    await act(async () => {
      resolveRepoSave?.(Response.json({
        repo: { id: 'repo-o8', storagePressureParkingDisabled: true },
      }));
      await settle();
      await settle();
    });
    expect(container.textContent).toContain('Refreshing usage');

    await act(async () => {
      resolveUsageRefresh?.(Response.json(updatedUsage));
      await settle();
    });
    expect(container.querySelector<HTMLButtonElement>(
      'button[aria-label="Allow pressure parking for o8"]',
    )?.textContent).toBe('Opted out');
  });

  it('keeps the newest usage projection when an older refresh settles last', async () => {
    let resolveRepoSave: ((response: Response) => void) | null = null;
    let resolveOlderRefresh: ((response: Response) => void) | null = null;
    const updatedUsage = {
      ...observedUsage,
      storagePressure: {
        ...observedUsage.storagePressure,
        eligibleRepositories: 2,
        optedOutRepositories: 2,
        repositories: observedUsage.storagePressure.repositories.map((repo) => (
          repo.id === 'repo-o8' ? { ...repo, parkingDisabled: true } : repo
        )),
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(observedUsage))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRepoSave = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveOlderRefresh = resolve; }))
      .mockResolvedValueOnce(Response.json(updatedUsage));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(createElement(WorktreeRetentionSection));
      await settle();
    });
    const repoToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Disable pressure parking for o8"]',
    );
    const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh usage"]');
    await act(async () => {
      repoToggle?.click();
      refresh?.click();
      await settle();
    });

    await act(async () => {
      resolveRepoSave?.(Response.json({
        repo: { id: 'repo-o8', storagePressureParkingDisabled: true },
      }));
      await settle();
    });
    expect(container.textContent).toContain('Opted out2');
    expect(container.querySelector(
      'button[aria-label="Allow pressure parking for o8"]',
    )).not.toBeNull();

    await act(async () => {
      resolveOlderRefresh?.(Response.json(observedUsage));
      await settle();
    });
    expect(container.textContent).toContain('Opted out2');
    expect(container.querySelector(
      'button[aria-label="Allow pressure parking for o8"]',
    )).not.toBeNull();
  });

  it('disables both parking choices when the mode is environment-locked', async () => {
    fetchOperatorDefaultsMock.mockResolvedValue(Response.json({
      values: { ...defaults.values, workspaceParkingMode: 'pressure' },
      sources: { ...defaults.sources, workspaceParkingMode: 'env' },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(observedUsage)));

    await act(async () => {
      root.render(createElement(WorktreeRetentionSection));
      await settle();
    });

    const modeButtons = [...container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="Set workspace parking"]',
    )];
    expect(modeButtons).toHaveLength(2);
    expect(modeButtons.every((button) => button.disabled)).toBe(true);
    expect(container.textContent).toContain('Locked by an environment variable.');
  });

  it('keeps observed values and labels only missing category accounting as Unknown', async () => {
    const partialUsage = {
      ...observedUsage,
      accountingStatus: 'partial',
      categoryStorage: {
        ...observedUsage.categoryStorage,
        accountingStatus: 'partial',
        categories: {
          ...observedCategories,
          dependency: category('dependency', null, null, 'known-path-sum'),
        },
      },
      error: 'Worktree storage accounting is incomplete.',
    };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(partialUsage, { status: 503 })));

    await act(async () => {
      root.render(createElement(WorktreeRetentionSection));
      await settle();
    });

    expect(container.textContent).toContain('Measurement incomplete: Worktree storage accounting is incomplete.');
    expect(container.textContent).toContain('Source filesMethod: workspace residualAllocated512 MBLogical768 MB');
    expect(container.textContent).toContain('DependenciesMethod: known path sumAllocatedUnknownLogicalUnknown');
  });

  it('names category loading and unavailable states without retaining stale bytes', async () => {
    let resolveUsage: ((response: Response) => void) | null = null;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      resolveUsage = resolve;
    })));

    await act(async () => {
      root.render(createElement(WorktreeRetentionSection));
      await settle();
    });

    expect(container.textContent).toContain('Measuring workspace files and disk space');
    expect(container.textContent).toContain('Measuring category storage');
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Refresh usage"]')?.disabled).toBe(true);

    await act(async () => {
      resolveUsage?.(Response.json({ error: 'Storage probe failed.' }, { status: 500 }));
      await settle();
    });

    expect(container.textContent).toContain('Measurement incomplete: Storage probe failed.');
    expect(container.textContent).toContain('Category accounting is unavailable.');
    expect(container.textContent).toContain('Source filesMethod unknownAllocatedUnknownLogicalUnknown');
  });

  it('clears stale usage while refreshing and keeps every control at least 44 pixels high', async () => {
    let resolveRefresh: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(observedUsage))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(createElement(WorktreeRetentionSection));
      await settle();
    });

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => Number.parseInt(button.style.height, 10) >= 44)).toBe(true);

    const refresh = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh usage"]');
    await act(async () => {
      refresh?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
    });

    expect(container.textContent).not.toContain('Cached 2s ago');
    expect(container.textContent).toContain('Measuring workspace files and disk space');
    expect(refresh?.disabled).toBe(true);

    await act(async () => {
      resolveRefresh?.(Response.json({ error: 'Storage probe failed.' }, { status: 500 }));
      await settle();
    });

    expect(container.textContent).toContain('Measurement incomplete: Storage probe failed.');
    expect(refresh?.disabled).toBe(false);
  });
});
