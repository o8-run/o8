'use client';
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { acknowledgeThreadSelection, installThreadNavigator, readThreadSelection, subscribeThreadSelection, type ThreadNavigatorOptions } from './thread-navigation';

export function useThreadWorkspaceNavigation(options: ThreadNavigatorOptions) {
  const current = useRef(options);
  useLayoutEffect(() => { current.current = options; }, [options]);
  useEffect(() => installThreadNavigator({
    currentWorkspaceId: () => current.current.currentWorkspaceId?.() ?? null,
    availability: () => current.current.availability?.() ?? null,
    resolve: (target) => {
      const resolved = current.current.resolve(target);
      return resolved ? { ...resolved, isActive: () => current.current.resolve(target)?.isActive() ?? false } : null;
    },
    readTasks: () => current.current.readTasks(),
  }), []);
}
export function useThreadDetailNavigation(input: {
  active: boolean; repoPath: string | null; scopeKey: string; loading: boolean;
  taskIds: string[]; selectedId: string | null; boundSessionKey?: string | null;
  select: (taskId: string) => void;
}) {
  const request = useSyncExternalStore(subscribeThreadSelection, readThreadSelection, () => null);
  useEffect(() => {
    if (!request || !input.active || input.loading || input.boundSessionKey || request.repoPath !== input.repoPath || !input.taskIds.includes(request.taskId)) return;
    if (input.selectedId !== request.taskId) input.select(request.taskId);
    else acknowledgeThreadSelection(request);
  }, [request, input]);
}
