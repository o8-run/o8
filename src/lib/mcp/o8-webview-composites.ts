import { McpInputError, safeErrorText } from '@/lib/mcp/api-error';
import { randomUUID } from 'node:crypto';
import { freshSessionScript } from '@/lib/mcp/o8-fresh-session-scripts';
import type { FreshOrchestratorRequest } from '@/lib/desktop/fresh-orchestrator-action';
import { O8WebviewClient } from '@/lib/mcp/o8-webview-client';
import { WebviewBridgeError } from '@/lib/mcp/o8-webview-error';

type TextContent = { type: 'text'; text: string };
type McpToolResult = {
  content: TextContent[];
  isError?: boolean;
};

type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;

type CompositeStep =
  | 'require_fresh_session'
  | 'navigate_dashboard'
  | 'select_repo'
  | 'open_new_tab_menu'
  | 'pick_orchestrator'
  | 'wait_for_composer'
  | 'locate_menu_trigger'
  | 'wait_for_popover'
  | 'pick_menu_option'
  | 'verify_popover_closed'
  | 'read_surface_state';

interface CompositeError {
  ok: false;
  step: CompositeStep;
  error: string;
  code?: string;
  state?: unknown;
}

function jsonResult(data: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    isError,
  };
}

function isMcpToolResult(value: unknown): value is McpToolResult {
  return !!value
    && typeof value === 'object'
    && Array.isArray((value as { content?: unknown }).content);
}

function toolError(step: CompositeStep, error: unknown, state?: unknown): McpToolResult {
  if (state !== undefined && !isOk(state)) console.error('[mcp] Surface failure:', state);
  const payload: CompositeError = {
    ok: false,
    step,
    error: safeErrorText(error),
    ...(error instanceof WebviewBridgeError ? { code: error.code } : {}),
    ...(state !== undefined && isOk(state) ? { state } : {}),
  };
  return jsonResult(payload, true);
}

function optionalString(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === 'string' ? args[key].trim() : '';
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (!value) {
    throw new McpInputError(`${key} is required`);
  }
  return value;
}

function buildJsonEval(body: string): string {
  return `(() => {
  try {
${body}
  } catch (error) {
    return JSON.stringify({ ok: false, error: String((error && error.message) || error) });
  }
})()`;
}

async function evalJson(client: O8WebviewClient, code: string): Promise<Record<string, unknown>> {
  const raw = await client.evalJs(code);
  try {
    const parsed = JSON.parse(raw.result);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : { ok: false, error: 'eval returned non-object JSON' };
  } catch {
    return { ok: false, error: `eval returned unparseable JSON: ${raw.result.slice(0, 200)}` };
  }
}

function isOk(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'ok' in value && value.ok === true;
}

function visibleDomHelpers(): string {
  return `
    const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const lower = (value) => norm(value).toLowerCase();
    const isVisible = (el) => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    };
    const labelFor = (el) => norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || el.getAttribute('placeholder') || '');
    const clickElement = (el) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
      try { el.focus({ preventScroll: true }); } catch (_) {}
      const rect = el.getBoundingClientRect();
      const mouse = { bubbles: true, cancelable: true, composed: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
      const pointer = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, mouse);
      const PointerCtor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      el.dispatchEvent(new PointerCtor('pointerdown', Object.assign({ buttons: 1 }, pointer)));
      el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, mouse)));
      el.dispatchEvent(new PointerCtor('pointerup', Object.assign({ buttons: 0 }, pointer)));
      el.dispatchEvent(new MouseEvent('mouseup', Object.assign({ buttons: 0 }, mouse)));
      el.dispatchEvent(new MouseEvent('click', Object.assign({ buttons: 0, detail: 1 }, mouse)));
    };
  `;
}

function buildSurfaceStateScript({ focusComposer }: { focusComposer: boolean }): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const route = window.location.pathname + window.location.search + window.location.hash;
    const composerCandidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).filter(isVisible);
    const composer = composerCandidates.find((el) => el.getAttribute('data-o8-active-composer') === 'true') || composerCandidates.find((el) => {
      const label = lower(labelFor(el));
      return label.includes('message') || label.includes('ask') || label.includes('queue') || label.includes('reply') || label.includes('orchestrator');
    }) || composerCandidates[0] || null;
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
      .filter(isVisible)
      .map((el) => labelFor(el) || norm((el.innerText || el.textContent || '').slice(0, 80)))
      .filter(Boolean);
    // Active workspace identity is render-derived by WorkspaceTerminalRoot and
    // read straight from its data attributes — never guessed from labels or
    // buttons. Identity comes only from a pane explicitly marked active that is
    // actually visible (no display:none / visibility:hidden ancestor): a single
    // unmarked root is NOT active, and an ambiguous/duplicate case yields null.
    const isActiveRootVisible = (el) => {
      let node = el;
      while (node && node instanceof HTMLElement) {
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        node = node.parentElement;
      }
      return true;
    };
    const activeRoots = Array.from(document.querySelectorAll('[data-o8-workspace-root]'))
      .filter((el) => el.getAttribute('data-o8-workspace-active') === 'true' && isActiveRootVisible(el));
    const activeRoot = activeRoots.length === 1 ? activeRoots[0] : null;
    const rootAttr = (name) => (activeRoot ? (activeRoot.getAttribute(name) || null) : null);
    const rawKind = rootAttr('data-o8-active-tab-kind');
    const activeTabKind = rawKind === 'terminal'
      ? 'terminal'
      : rawKind === 'chat' || rawKind === 'llm-chat'
        ? 'chat'
        : rawKind === 'orchestrator'
          ? 'orchestrator'
          : null;
    const activeTabId = rootAttr('data-o8-active-tab-id');
    const activeWorkspaceId = rootAttr('data-o8-workspace-id');
    const activeWorkspaceRepo = rootAttr('data-o8-active-repo');
    let tabInventory = null;
    let freshSessionReceipt = null;
    try { tabInventory = JSON.parse(rootAttr('data-o8-tab-inventory') || 'null'); } catch (_) {}
    try { freshSessionReceipt = JSON.parse(rootAttr('data-o8-fresh-session-receipt') || 'null'); } catch (_) {}

    if (${focusComposer ? 'true' : 'false'} && composer && !composer.hasAttribute('disabled')) {
      try { composer.focus({ preventScroll: true }); } catch (_) {}
    }
    return JSON.stringify({
      ok: true,
      route,
      activeWorkspaceId,
      activeWorkspaceRepo,
      tabInventory,
      freshSessionReceipt,
      activeTabKind,
      activeTabId,
      openDialogs: dialogs,
      composerFocused: !!composer && document.activeElement === composer,
      composerFocusable: !!composer && !composer.hasAttribute('disabled'),
    });
  `);
}

export const SURFACE_STATE_SCRIPT = buildSurfaceStateScript({ focusComposer: false });
export function buildPickMenuTriggerScript(menuLabel: string): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const needle = ${JSON.stringify(menuLabel.toLowerCase())};
    const isMenuTrigger = (el) => {
      if (el.getAttribute('aria-pressed') !== null) return false;
      if (el.getAttribute('role') === 'tab') return false;
      if (el.getAttribute('aria-haspopup')) return true;
      const expanded = el.getAttribute('aria-expanded');
      return expanded === 'true' || expanded === 'false';
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], [aria-haspopup], a[href]'))
      .filter(isVisible)
      .filter(isMenuTrigger);
    const trigger = candidates.find((el) => lower(labelFor(el)) === needle)
      || candidates.find((el) => lower(labelFor(el)).includes(needle));
    if (!trigger) return JSON.stringify({ ok: false, error: 'menu trigger not found', menuLabel: ${JSON.stringify(menuLabel)} });
    clickElement(trigger);
    return JSON.stringify({ ok: true, trigger: labelFor(trigger) });
  `);
}

export function buildPickMenuOptionScript(optionLabel: string): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const needle = ${JSON.stringify(optionLabel.toLowerCase())};
    const candidates = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a[href], [data-radix-collection-item]')).filter(isVisible);
    const option = candidates.find((el) => lower(labelFor(el)) === needle)
      || candidates.find((el) => lower(labelFor(el)).includes(needle));
    if (!option) return JSON.stringify({ ok: false, error: 'menu option not found', optionLabel: ${JSON.stringify(optionLabel)} });
    clickElement(option);
    return JSON.stringify({ ok: true, option: labelFor(option) });
  `);
}

function buildMenuOptionVisibleScript(optionLabel: string): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const needle = ${JSON.stringify(optionLabel.toLowerCase())};
    const candidates = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"], [data-radix-popper-content-wrapper], [data-composer-overlay]')).filter(isVisible);
    const option = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a[href], [data-radix-collection-item]'))
      .filter(isVisible)
      .find((el) => lower(labelFor(el)) === needle || lower(labelFor(el)).includes(needle));
    return JSON.stringify({ ok: true, popoverVisible: candidates.length > 0 || !!option, optionVisible: !!option });
  `);
}

function buildMenuOptionClosedScript(optionLabel: string): string {
  return buildJsonEval(`
    ${visibleDomHelpers()}
    const needle = ${JSON.stringify(optionLabel.toLowerCase())};
    const option = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, a[href], [data-radix-collection-item]'))
      .filter(isVisible)
      .find((el) => lower(labelFor(el)) === needle || lower(labelFor(el)).includes(needle));
    const popovers = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], [data-radix-popper-content-wrapper], [data-composer-overlay]')).filter(isVisible);
    return JSON.stringify({ ok: true, closed: !option && popovers.length === 0, optionVisible: !!option, popoverCount: popovers.length });
  `);
}

async function evalActionThenVerify(
  client: O8WebviewClient,
  step: CompositeStep,
  actionCode: string,
  verifyCode: string,
  predicate: (value: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown> | McpToolResult> {
  let warning: string | null = null;
  try {
    const result = await evalJson(client, actionCode);
    if (!isOk(result)) {
      return toolError(step, typeof result.error === 'string' ? result.error : 'action returned ok:false', result);
    }
  } catch (error) {
    warning = safeErrorText(error);
  }

  const verified = await waitForEval(client, verifyCode, predicate, timeoutMs);
  if (!predicate(verified)) {
    return toolError(step, new McpInputError(warning ?? 'verification did not pass before timeout'), verified);
  }
  return warning ? { ...verified, warning } : verified;
}

async function evalActionThenWaitFor(
  client: O8WebviewClient,
  actionStep: CompositeStep,
  waitStep: CompositeStep,
  actionCode: string,
  verifyCode: string,
  predicate: (value: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown> | McpToolResult> {
  let warning: string | null = null;
  try {
    const result = await evalJson(client, actionCode);
    if (!isOk(result)) {
      return toolError(actionStep, typeof result.error === 'string' ? result.error : 'action returned ok:false', result);
    }
  } catch (error) {
    warning = safeErrorText(error);
  }

  const verified = await waitForEval(client, verifyCode, predicate, timeoutMs);
  if (!predicate(verified)) {
    return toolError(waitStep, new McpInputError(warning ?? 'verification did not pass before timeout'), verified);
  }
  return warning ? { ...verified, warning } : verified;
}

async function waitForEval(
  client: O8WebviewClient,
  code: string,
  predicate: (value: Record<string, unknown>) => boolean,
  timeoutMs: number,
  terminal?: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let latest: Record<string, unknown> = {};
  while (Date.now() <= deadline) {
    latest = await evalJson(client, code);
    if ((isOk(latest) && predicate(latest)) || terminal?.(latest)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return latest;
}

export const O8_WEBVIEW_COMPOSITE_TOOLS: McpTool[] = [
  {
    name: 'o8_view_new_orchestrator_session',
    description: 'Creates a genuinely fresh orchestrator through the fixed workspace-scoped fresh-orchestrator action. Verifies a new ID against the full prior tab inventory and focuses its enabled composer. Ordinary New session menu reuse is unchanged. After uncertainty, observe state; never replay the spawn.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Optional exact active workspace label or repo path guard. Refuses if it differs; select the desired project before calling.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'o8_view_pick_menu_option',
    description: 'USE THIS WHEN you need to choose an item from an o8 popover or menu by labels. Finds the trigger by aria-label/title/visible text, clicks the option by text, and verifies the popover closed.',
    inputSchema: {
      type: 'object',
      properties: {
        menuLabel: { type: 'string', description: 'Visible text, title, or aria-label of the menu trigger.' },
        optionLabel: { type: 'string', description: 'Visible text of the menu option to choose.' },
      },
      required: ['menuLabel', 'optionLabel'],
      additionalProperties: false,
    },
  },
  {
    name: 'o8_view_surface_state',
    description: 'USE THIS WHEN you need a structured read-only snapshot of the active o8 surface: route, active workspace, active tab kind, open dialogs, and composer focus state. Uses one eval batch and no screenshots.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];

export function createO8WebviewCompositeHandlers(getClient: () => O8WebviewClient): Record<string, ToolHandler> {
  return {
    o8_view_new_orchestrator_session: async (args) => {
      const requestId = randomUUID();
      let attempted = false;
      try {
        if (!args || Object.getPrototypeOf(args) !== Object.prototype || Object.keys(args).some(key => key !== 'repo')
          || (args.repo !== undefined && (typeof args.repo !== 'string' || args.repo.length > 2_048))) {
          return jsonResult({ ok: false, code: 'invalid_schema', actionDispatched: false, requestId }, true);
        }
        const client = getClient();
        const current = await evalJson(client, freshSessionScript('inspect'));
        if (!isOk(current)) return jsonResult({ ...current, requestId }, true);
        const repo = optionalString(args, 'repo');
        if (repo && repo !== current.repoLabel && repo !== current.repoPath) {
          return jsonResult({ ok: false, code: 'requested_project_not_active', actionDispatched: false, requestId }, true);
        }
        const request: FreshOrchestratorRequest = {
          requestId, expiresAt: Date.now() + 5_000,
          capability: current.capability as string,
          workspaceId: current.workspaceId as string,
          repoPath: current.repoPath as string,
          activeTabId: current.activeTabId as string,
          tabIds: current.tabIds as string[],
        };
        attempted = true;
        let warning: string | undefined;
        try {
          const dispatched = await evalJson(client, freshSessionScript('dispatch', request));
          if (!isOk(dispatched)) return jsonResult(dispatched, true);
        } catch (error) {
          warning = safeErrorText(error);
        }
        // A pending app callback receipt is not completion. Observe React's
        // full inventory and active enabled composer; never repeat dispatch.
        const observed = await waitForEval(client, freshSessionScript('observe', request), value => value.ok === true, 7_500,
          value => value.status === 'unknown' || value.status === 'error');
        if (!isOk(observed) && observed.status === 'pending') {
          const settled = await evalJson(client, freshSessionScript('timeout', request));
          return jsonResult({ ...settled, automaticReplay: false }, !isOk(settled));
        }
        if (!isOk(observed)) return jsonResult({ ok: false, requestId, ...observed, automaticReplay: false, ...(observed.status === 'pending' ? {} : { mutationOutcome: 'unknown' }) }, true);
        const focused = await evalJson(client, freshSessionScript('focus', request));
        return jsonResult({ ...focused, ...(warning ? { warning } : {}) }, !isOk(focused));
      } catch (error) {
        return jsonResult({ ok: false, requestId, error: safeErrorText(error), ...(attempted
          ? { mutationOutcome: 'unknown', automaticReplay: false } : { actionDispatched: false }) }, true);
      }
    },

    o8_view_pick_menu_option: async (args) => {
      let menuLabel: string;
      let optionLabel: string;
      try {
        menuLabel = requiredString(args, 'menuLabel');
        optionLabel = requiredString(args, 'optionLabel');
      } catch (error) {
        return toolError('locate_menu_trigger', error);
      }

      const client = getClient();
      const trigger = await evalActionThenWaitFor(
        client,
        'locate_menu_trigger',
        'wait_for_popover',
        buildPickMenuTriggerScript(menuLabel),
        buildMenuOptionVisibleScript(optionLabel),
        (value) => value.optionVisible === true,
        5_000,
      );
      if (isMcpToolResult(trigger)) return trigger;

      const option = await evalActionThenVerify(
        client,
        'pick_menu_option',
        buildPickMenuOptionScript(optionLabel),
        buildMenuOptionClosedScript(optionLabel),
        (value) => value.closed === true,
        2_000,
      );
      if (isMcpToolResult(option)) return option;
      return jsonResult({ ok: true, menuLabel, optionLabel, state: option });
    },

    o8_view_surface_state: async () => {
      try {
        const client = getClient();
        const state = await evalJson(client, SURFACE_STATE_SCRIPT);
        if (!isOk(state)) return toolError('read_surface_state', typeof state.error === 'string' ? state.error : 'state eval failed', state);
        const publicState = { ...state };
        delete publicState.ok;
        delete publicState.composerFocusable;
        return jsonResult(publicState);
      } catch (error) {
        return toolError('read_surface_state', error);
      }
    },
  };
}
