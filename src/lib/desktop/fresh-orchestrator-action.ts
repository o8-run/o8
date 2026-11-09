import type { RegisteredRepo } from '@/components/desktop/workspace-terminal/registered-repo';

/** Fixed app-owned action, delivered only to the exact live workspace root.
 * Ordinary New session retains blank reuse. This explicit action alone forces
 * creation; its pending receipt is not proof of a React-rendered new tab.
 */
export const FRESH_ORCHESTRATOR_EVENT = 'o8:request-fresh-orchestrator';
export const FRESH_ACTION_ATTRIBUTE = 'data-o8-fresh-session-action';
export const FRESH_RECEIPT_ATTRIBUTE = 'data-o8-fresh-session-receipt';
export const FRESH_RECEIPT_TIMEOUT_MS = 8_000;
export interface FreshOrchestratorRequest {
  requestId: string;
  expiresAt: number;
  capability: string;
  workspaceId: string;
  repoPath: string;
  activeTabId: string;
  tabIds: string[];
}
interface Owner {
  workspaceId: string;
  activeTabId: string;
  repo: RegisteredRepo;
  tabIds: string[];
  getTabIds: () => string[];
  enabled: boolean;
  spawnFresh: (repo: RegisteredRepo) => string;
}
function visible(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
function readReceipt(root: HTMLElement): Record<string, unknown> | null {
  try { return JSON.parse(root.getAttribute(FRESH_RECEIPT_ATTRIBUTE) ?? 'null'); } catch { return null; }
}
export function registerFreshOrchestratorAction(root: HTMLElement, owner: Owner): () => void {
  if (!owner.enabled) return () => undefined;
  const capability = `v1:${crypto.randomUUID()}`;
  root.setAttribute(FRESH_ACTION_ATTRIBUTE, capability);
  const listener = (event: Event) => {
    // Bubble delivery, foreign roots and caller-provided operation/code are not
    // supported. This handler has exactly one operation and no URL/file input.
    if (event.target !== root) return;
    const request = (event as CustomEvent<unknown>).detail;
    if (!request || typeof request !== 'object' || Array.isArray(request)) return;
    const value = request as FreshOrchestratorRequest;
    if (typeof value.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value.requestId)) return;
    const prior = readReceipt(root);
    if (prior?.requestId === value.requestId || (prior?.status === 'pending' && !owner.getTabIds().includes(String(prior.tabId)))) {
      // Keep the original receipt intact; never replay a dispatched request.
      return;
    }
    const refuse = (code: string) => {
      root.setAttribute(FRESH_RECEIPT_ATTRIBUTE, JSON.stringify({ requestId: value.requestId, status: 'error', code, actionDispatched: false }));
    };
    if (Object.keys(value).sort().join(',') !== 'activeTabId,capability,expiresAt,repoPath,requestId,tabIds,workspaceId'
      || !Number.isFinite(value.expiresAt) || value.expiresAt < Date.now() || value.expiresAt > Date.now() + 10_000
      || !Array.isArray(value.tabIds) || value.tabIds.length > 1_000
      || value.tabIds.some(id => typeof id !== 'string' || !id || id.length > 256)
      || new Set(value.tabIds).size !== value.tabIds.length) { refuse('invalid_or_expired_request'); return; }
    const roots = Array.from(document.querySelectorAll<HTMLElement>('[data-o8-workspace-root][data-o8-workspace-active="true"]')).filter(visible);
    if (!owner.enabled || !visible(root) || roots.length !== 1 || roots[0] !== root
      || root.getAttribute('aria-disabled') === 'true'
      || Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [aria-modal="true"]')).some(visible)
      || value.capability !== capability || root.getAttribute(FRESH_ACTION_ATTRIBUTE) !== capability
      || value.workspaceId !== owner.workspaceId || value.repoPath !== owner.repo.localPath
      || value.activeTabId !== owner.activeTabId
      || root.getAttribute('data-o8-workspace-id') !== owner.workspaceId
      || root.getAttribute('data-o8-active-repo-path') !== owner.repo.localPath
      || root.getAttribute('data-o8-active-tab-id') !== owner.activeTabId
      || JSON.stringify(value.tabIds) !== JSON.stringify(owner.getTabIds())
      || JSON.stringify(value.tabIds) !== JSON.stringify(owner.tabIds)
      || root.getAttribute('data-o8-tab-inventory') !== JSON.stringify(owner.tabIds)) { refuse('target_changed_or_unavailable'); return; }
    if (Date.now() > value.expiresAt) { refuse('expired_request'); return; }
    const receipt = { requestId: value.requestId, workspaceId: owner.workspaceId, repoPath: owner.repo.localPath, tabIds: owner.tabIds, status: 'pending', actionDispatched: true, tabId: '' };
    root.setAttribute(FRESH_RECEIPT_ATTRIBUTE, JSON.stringify(receipt));
    try {
      const tabId = owner.spawnFresh(owner.repo);
      if (!tabId || owner.tabIds.includes(tabId)) {
        root.setAttribute(FRESH_RECEIPT_ATTRIBUTE, JSON.stringify({ ...receipt, status: 'error', code: 'freshness_not_proven' }));
        return;
      }
      const pending = JSON.stringify({ ...receipt, tabId });
      root.setAttribute(FRESH_RECEIPT_ATTRIBUTE, pending);
      // Registration rotates on the tab's React commit. Keep this bounded
      // expiry on the captured root, including after a disconnected caller or
      // unmount, without touching a replacement root or replaying creation.
      window.setTimeout(() => {
        if (root.getAttribute(FRESH_RECEIPT_ATTRIBUTE) !== pending) return;
        root.setAttribute(FRESH_RECEIPT_ATTRIBUTE, JSON.stringify({
          ...receipt, tabId, status: 'unknown', code: 'verification_timeout', automaticReplay: false,
        }));
      }, FRESH_RECEIPT_TIMEOUT_MS);
    } catch {
      root.setAttribute(FRESH_RECEIPT_ATTRIBUTE, JSON.stringify({ ...receipt, status: 'error', code: 'creation_failed' }));
    }
  };
  root.addEventListener(FRESH_ORCHESTRATOR_EVENT, listener);
  return () => {
    root.removeEventListener(FRESH_ORCHESTRATOR_EVENT, listener);
    if (root.getAttribute(FRESH_ACTION_ATTRIBUTE) === capability) root.removeAttribute(FRESH_ACTION_ATTRIBUTE);
  };
}
