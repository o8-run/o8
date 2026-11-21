import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listWorktrees, generateConflictReport } = vi.hoisted(() => ({
  listWorktrees: vi.fn(),
  generateConflictReport: vi.fn(),
}));

vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/worktree/manager', () => ({
  WorktreeManager: class {
    list = listWorktrees;
  },
}));
vi.mock('@/lib/worktree/conflicts', () => ({ generateConflictReport }));

import { GET } from './route';

function request(signal?: AbortSignal) {
  return new NextRequest('http://127.0.0.1/api/worktrees/conflicts?repo=/fixture', { signal });
}

describe('worktree conflict report requests', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('stops before building the report when the caller disconnects during the worktree scan', async () => {
    const caller = new AbortController();
    listWorktrees.mockImplementation(async () => {
      caller.abort();
      return [];
    });

    const response = await GET(request(caller.signal));

    expect(response.status).toBe(499);
    expect(generateConflictReport).not.toHaveBeenCalled();
  });

  it('skips reading or serializing the report after the caller disconnects during analysis', async () => {
    const caller = new AbortController();
    const serialize = vi.fn();
    listWorktrees.mockResolvedValue([]);
    generateConflictReport.mockImplementation(async () => {
      caller.abort();
      return { toJSON: serialize };
    });

    const response = await GET(request(caller.signal));

    expect(response.status).toBe(499);
    expect(serialize).not.toHaveBeenCalled();
  });

  it('returns the full report while the caller remains connected', async () => {
    const worktrees = [{ id: 'fixture' }];
    const report = { files: [], safe: true, conflictCount: 0, warningCount: 0, mergeOrder: [], generatedAt: 1 };
    listWorktrees.mockResolvedValue(worktrees);
    generateConflictReport.mockResolvedValue(report);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(report);
    expect(generateConflictReport).toHaveBeenCalledWith(worktrees, false);
  });
});
