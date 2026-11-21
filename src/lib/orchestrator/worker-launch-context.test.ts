import { describe, expect, it } from 'vitest';
import {
  normalizeWorkerLaunchContext,
  bindWorkerLaunchParent,
  runtimeFromWorkerSessionKey,
  shouldPresentWorkerInSplit,
  workerLaunchOriginLabel,
} from './worker-launch-context';

describe('worker launch context', () => {
  it('normalizes bounded outside provenance and requests a dedicated pane', () => {
    const context = normalizeWorkerLaunchContext({
      source: 'cli',
      presentation: 'split',
      repoContext: 'transient',
      workMode: 'read-only',
      caller: ' outside terminal ',
      parentWorkspaceId: ' workspace-one ',
      parentThreadId: ' thoughts-one ',
    });
    expect(context).toEqual({
      source: 'cli',
      presentation: 'split',
      repoContext: 'transient',
      workMode: 'read-only',
      caller: 'outside terminal',
      parentWorkspaceId: 'workspace-one',
      parentThreadId: 'thoughts-one',
    });
    expect(shouldPresentWorkerInSplit(context)).toBe(true);
    expect(workerLaunchOriginLabel(context)).toBe('outside terminal via o8 CLI');
  });

  it('fills durable parent placement without replacing explicit caller truth', () => {
    const context = bindWorkerLaunchParent({
      source: 'mcp',
      presentation: 'split',
      repoContext: 'transient',
      parentWorkspaceId: 'explicit-workspace',
    }, {
      workspaceId: 'fallback-workspace',
      threadId: 'thoughts-parent',
    });

    expect(context).toMatchObject({
      parentWorkspaceId: 'explicit-workspace',
      parentThreadId: 'thoughts-parent',
    });
  });

  it('keeps desktop launches in their existing tab presentation', () => {
    const context = normalizeWorkerLaunchContext({
      source: 'desktop',
      presentation: 'split',
      repoContext: 'registered',
    });
    expect(shouldPresentWorkerInSplit(context)).toBe(false);
  });

  it.each([
    ['3code-owned:surface-0', '3code'],
    ['opencode-owned:surface-1', 'opencode'],
    ['claude-code:surface-3', 'claude-code'],
    ['hermes-owned:surface-6', 'hermes'],
    ['unknown:surface-4', 'codex'],
  ] as const)('derives %s as %s for supervisor launches', (sessionKey, runtime) => {
    expect(runtimeFromWorkerSessionKey(sessionKey)).toBe(runtime);
  });

  it('rejects partial or unknown launch records', () => {
    expect(normalizeWorkerLaunchContext({ source: 'cli', presentation: 'split' })).toBeUndefined();
    expect(normalizeWorkerLaunchContext({ source: 'shell', presentation: 'split', repoContext: 'transient' })).toBeUndefined();
    expect(normalizeWorkerLaunchContext({ source: 'cli', presentation: 'split', repoContext: 'transient', workMode: 'delete' })).toBeUndefined();
  });
});
