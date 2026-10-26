import { threadProjectMatches } from './thread-project-identity';

export interface ThreadNavigationTarget {
  workspaceId: string;
  repoPath: string;
  taskId: string;
}
interface PanelUnavailable {
  reason: 'panel_viewport_unavailable';
  viewportWidth: number;
  minimumWidth: number;
  recovery: { tool: 'o8_view_manage_window'; operation: 'maximize' };
}
export function threadPanelAvailability(viewportWidth: number, minimumWidth: number): PanelUnavailable | null {
  return viewportWidth < minimumWidth ? {
    reason: 'panel_viewport_unavailable', viewportWidth, minimumWidth,
    recovery: { tool: 'o8_view_manage_window', operation: 'maximize' },
  } : null;
}
interface NavigationResult extends ThreadNavigationTarget {
  ok: boolean;
  status?: 'mounted';
  reason?: string;
  viewportWidth?: number;
  minimumWidth?: number;
  recovery?: PanelUnavailable['recovery'];
}
interface TaskIdentity {
  id: string;
  repoPath?: string | null;
  project?: { id: string; panelProjectId?: string | null } | null;
}
export interface ThreadNavigatorOptions {
  currentWorkspaceId?: () => string | null;
  availability?: () => PanelUnavailable | null;
  resolve: (target: ThreadNavigationTarget) => {
    projectId: string | null;
    activate: () => void;
    isActive: () => boolean;
  } | null;
  readTasks: () => Promise<TaskIdentity[]>;
}
declare global {
  interface Window {
    __o8NavigateThread?: (target: ThreadNavigationTarget) => Promise<NavigationResult>;
  }
}
interface Pending {
  target: ThreadNavigationTarget;
  acknowledge: () => boolean;
  cancel: (reason: string) => void;
}
let pending: Pending | null = null;
let openActiveThread: ((repoPath: string, taskId: string) => Promise<NavigationResult>) | null = null;
/** A human card click uses the same verified navigation and mounted receipt as MCP. */
export function openCurrentThread(repoPath: string, taskId: string): Promise<NavigationResult> {
  return openActiveThread?.(repoPath, taskId) ?? Promise.resolve({ workspaceId: '', repoPath, taskId, ok: false, reason: 'thread_navigation_unavailable' });
}
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };
export const readThreadSelection = () => pending?.target ?? null;
export function subscribeThreadSelection(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function acknowledgeThreadSelection(target: ThreadNavigationTarget) {
  if (!pending || Object.keys(target).some((key) => target[key as keyof ThreadNavigationTarget] !== pending?.target[key as keyof ThreadNavigationTarget])) return false;
  return pending.acknowledge();
}
const path = (value: string | null | undefined) => value?.replace(/\/+$/, '') ?? '';

/** Product navigation intent. No synthetic DOM input, inference, or preview allocation. */
export function installThreadNavigator(options: ThreadNavigatorOptions) {
  let busy = false;
  let disposed = false;
  const navigate = async (target: ThreadNavigationTarget): Promise<NavigationResult> => {
    const failure = (reason: string): NavigationResult => ({ ...target, ok: false, reason });
    if (!target || !['workspaceId', 'repoPath', 'taskId'].every((key) => typeof target[key as keyof ThreadNavigationTarget] === 'string' && target[key as keyof ThreadNavigationTarget].trim())) return failure('invalid_target');
    if (busy || pending) return failure('navigation_busy');
    const resolved = options.resolve(target);
    if (!resolved) return failure('workspace_unavailable');
    const unavailable = options.availability?.();
    if (unavailable) return { ...target, ok: false, ...unavailable };
    busy = true;
    try {
      const tasks = await options.readTasks();
      if (disposed) return failure('navigation_unmounted');
      if (!tasks.some((task) => task.id === target.taskId && path(task.repoPath) === path(target.repoPath)
        && threadProjectMatches(task.project, resolved.projectId))) return failure('task_unavailable');
      // Re-resolve after the async read: a workspace can disappear while loading.
      const current = options.resolve(target);
      if (!current || current.projectId !== resolved.projectId) return failure('workspace_unavailable');
      const unavailableNow = options.availability?.();
      if (unavailableNow) return { ...target, ok: false, ...unavailableNow };
      return await new Promise<NavigationResult>((resolve) => {
        const finish = (result: NavigationResult) => {
          clearTimeout(timer);
          if (pending === request) pending = null;
          changed();
          resolve(result);
        };
        const timer = setTimeout(() => finish(failure('mounted_selection_timeout')), 10_000);
        const request: Pending = {
          target,
          cancel: (reason) => finish(failure(reason)),
          acknowledge: () => {
            if (!current.isActive()) return false;
            finish({ ...target, ok: true, status: 'mounted' });
            return true;
          },
        };
        pending = request;
        try { current.activate(); changed(); } catch { request.cancel('workspace_activation_failed'); }
      });
    } catch { return failure('task_read_failed'); }
    finally { busy = false; }
  };
  window.__o8NavigateThread = navigate;
  const openFromCard = (repoPath: string, taskId: string) => navigate({ workspaceId: options.currentWorkspaceId?.() ?? '', repoPath, taskId });
  openActiveThread = openFromCard;
  return () => {
    disposed = true;
    pending?.cancel('navigation_unmounted');
    if (window.__o8NavigateThread === navigate) delete window.__o8NavigateThread;
    if (openActiveThread === openFromCard) openActiveThread = null;
  };
}
