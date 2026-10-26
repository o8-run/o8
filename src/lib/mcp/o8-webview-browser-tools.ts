import { McpInputError, safeErrorText } from '@/lib/mcp/api-error';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_API_PORT } from '@/lib/panel/api-port';
import { getDataDir } from '@/lib/data-dir-migration';

type TextContent = { type: 'text'; text: string };
type ImageContent = { type: 'image'; data: string; mimeType: string };
type McpToolResult = {
  content: Array<TextContent | ImageContent>;
  isError?: boolean;
};

type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;

const READ_RESULT_BYTE_CAP = 16 * 1024;

function textResult(text: string, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text }],
    isError,
  };
}

function jsonResult(data: unknown, isError = false): McpToolResult {
  return textResult(JSON.stringify(data), isError);
}

function capText(raw: string): McpToolResult {
  const sizeBytes = Buffer.byteLength(raw, 'utf8');
  if (sizeBytes <= READ_RESULT_BYTE_CAP) {
    return textResult(raw);
  }
  const preview = Buffer.from(raw, 'utf8').subarray(0, READ_RESULT_BYTE_CAP).toString('utf8');
  return jsonResult({
    truncated: true,
    sizeBytes,
    capBytes: READ_RESULT_BYTE_CAP,
    preview,
  });
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new McpInputError(`${key} is required`);
  }
  return value.trim();
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

async function withStructuredErrors(action: () => Promise<McpToolResult>): Promise<McpToolResult> {
  try {
    return await action();
  } catch (error) {
    const message = safeErrorText(error);
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
    return jsonResult({
      ok: false,
      error: {
        message,
        code: code ?? null,
      },
    }, true);
  }
}

function browserApiBase(): string {
  try {
    const dataDir = getDataDir();
    const portFile = join(dataDir, 'api-port');
    if (existsSync(portFile)) {
      const port = parseInt(readFileSync(portFile, 'utf-8').trim(), 10);
      if (Number.isInteger(port) && port > 0 && port < 65536) return `http://127.0.0.1:${port}`;
    }
  } catch { /* fall through */ }
  const envBase = process.env.O8_API_BASE?.trim();
  if (envBase) return envBase;
  const envPort = process.env.O8_API_PORT?.trim();
  if (envPort) return `http://127.0.0.1:${envPort}`;
  return `http://127.0.0.1:${DEFAULT_API_PORT}`;
}

function browserApiToken(): string | null {
  try {
    const dataDir = getDataDir();
    const tokenPath = join(dataDir, 'ws-token');
    if (!existsSync(tokenPath)) return null;
    return readFileSync(tokenPath, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

async function browserAgentPost(verb: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const token = browserApiToken();
  const response = await fetch(`${browserApiBase()}/api/browser/agent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ verb, args }),
  });
  const raw = await response.text();
  try {
    return jsonResult(JSON.parse(raw));
  } catch {
    return textResult(raw);
  }
}

// These tools drive the page inside o8's embedded browser, not the o8 UI.
// The API route owns tier routing so MCP, CLI, and Symon share one contract.
export const O8_WEBVIEW_BROWSER_TOOLS: McpTool[] = [
  {
    name: 'o8_browser_read',
    description: "Read the page INSIDE o8's embedded browser (canvas browser card or Browser tab): returns { url, title, text, interactive } where interactive lists clickable/typable elements with CSS selectors — the vocabulary for o8_browser_click / o8_browser_type. Use this FIRST to see the page before acting. Localhost pages only (cross-origin pages return an error envelope).",
    inputSchema: {
      type: 'object',
      properties: {
        surface: { type: 'string', enum: ['canvas', 'panel', 'engine'], description: "Which browser surface — 'canvas' (browser cards), 'panel' (Browser tab), or 'engine' (headless installed-Chrome for external URLs). Omit to auto-route: the engine while its page is open, else the most recently active embedded surface." },
        selector: { type: 'string', description: 'Optional CSS selector — read only this subtree.' },
        maxChars: { type: 'number', description: 'Text cap (default 6000, max 14000).' },
      },
    },
  },
  {
    name: 'o8_browser_rect',
    description: "Resolve one selector from o8_browser_read to its current visible rectangle inside o8's Browser panel or canvas. Returns the surface, coordinate space, viewport, label, and rect; use it when an agent needs exact live geometry instead of a pixel guess.",
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the visible browser element.' },
        surface: { type: 'string', enum: ['canvas', 'panel'], description: "Embedded browser surface. Use 'panel' for the Browser tab or 'canvas' for a browser card." },
      },
      required: ['selector'],
    },
  },
  {
    name: 'o8_browser_click',
    description: "Click an element INSIDE o8's embedded browser by CSS selector (from o8_browser_read's interactive list or a Design Mode grab). Fires the full pointer/mouse sequence so React apps respond, and paints a ghost cursor + ripple the operator can see.",
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click.' },
        surface: { type: 'string', enum: ['canvas', 'panel', 'engine'], description: 'Which browser surface (engine = headless Chrome for external URLs). Omit to auto-route.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'o8_browser_type',
    description: "Type into an input/textarea INSIDE o8's embedded browser by CSS selector. Uses the native value setter + input/change events so controlled (React) inputs accept it. Set submit:true to press Enter / submit the form after.",
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input or textarea.' },
        text: { type: 'string', description: 'Replacement text. Empty text clears the field; whitespace is preserved.' },
        submit: { type: 'boolean', description: 'Press Enter / requestSubmit after typing.' },
        surface: { type: 'string', enum: ['canvas', 'panel', 'engine'], description: 'Which browser surface (engine = headless Chrome for external URLs). Omit to auto-route.' },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'o8_browser_grab',
    description: "Design-Mode grab — capture ONE element INSIDE o8's embedded browser by CSS selector and return its rich payload: { tagName, cssSelector, computedStyles (color/type/box/layout), accessibility (role/name/aria-*), domSummary (role/name/ancestor chain/rect/landmark), attributes, innerHTML, outerHTML, parentChain, boundingRect, screenshot? }. The engine tier includes an element screenshot data URL; synchronous embedded/native grabs return DOM context without pixels. Localhost pages (embedded) or the headless engine (external URLs).",
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to grab.' },
        surface: { type: 'string', enum: ['canvas', 'panel', 'engine'], description: 'Which browser surface (engine = headless Chrome for external URLs). Omit to auto-route.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'o8_browser_wait',
    description: "Poll the page INSIDE o8's embedded browser until a CSS selector resolves (optionally with a text substring) — the settle gate between o8_browser_click and o8_browser_read.",
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for inside the framed page.' },
        text: { type: 'string', description: 'Optional substring the element must contain.' },
        timeoutMs: { type: 'number', description: 'Max wait in milliseconds (default 10000, capped at 25000).' },
        surface: { type: 'string', enum: ['canvas', 'panel', 'engine'], description: 'Which browser surface (engine = headless Chrome for external URLs). Omit to auto-route.' },
      },
      required: ['selector'],
    },
  },
];

export function createO8WebviewBrowserHandlers(): Record<string, ToolHandler> {
  return {
    o8_browser_read: async (args) => withStructuredErrors(async () => {
      const agentArgs: Record<string, unknown> = {};
      if (args.surface === 'canvas' || args.surface === 'panel' || args.surface === 'engine') agentArgs.surface = args.surface;
      if (typeof args.selector === 'string' && args.selector) agentArgs.selector = args.selector;
      const maxChars = parseOptionalNumber(args.maxChars);
      if (maxChars) agentArgs.maxChars = maxChars;
      const result = await browserAgentPost('read', agentArgs);
      const text = result.content[0];
      return text?.type === 'text' ? capText(text.text) : result;
    }),
    o8_browser_click: async (args) => withStructuredErrors(async () => {
      const agentArgs: Record<string, unknown> = { selector: requiredString(args, 'selector') };
      if (args.surface === 'canvas' || args.surface === 'panel' || args.surface === 'engine') agentArgs.surface = args.surface;
      return browserAgentPost('click', agentArgs);
    }),
    o8_browser_rect: async (args) => withStructuredErrors(async () => {
      const agentArgs: Record<string, unknown> = { selector: requiredString(args, 'selector') };
      if (args.surface === 'canvas' || args.surface === 'panel') agentArgs.surface = args.surface;
      return browserAgentPost('rect', agentArgs);
    }),
    o8_browser_type: async (args) => withStructuredErrors(async () => {
      if (typeof args.text !== 'string') throw new McpInputError('text must be a string');
      const agentArgs: Record<string, unknown> = {
        selector: requiredString(args, 'selector'),
        text: args.text,
      };
      if (args.submit === true) agentArgs.submit = true;
      if (args.surface === 'canvas' || args.surface === 'panel' || args.surface === 'engine') agentArgs.surface = args.surface;
      return browserAgentPost('type', agentArgs);
    }),
    o8_browser_grab: async (args) => withStructuredErrors(async () => {
      const agentArgs: Record<string, unknown> = { selector: requiredString(args, 'selector') };
      if (args.surface === 'canvas' || args.surface === 'panel' || args.surface === 'engine') agentArgs.surface = args.surface;
      const result = await browserAgentPost('grab', agentArgs);
      const text = result.content[0];
      return text?.type === 'text' ? capText(text.text) : result;
    }),
    o8_browser_wait: async (args) => withStructuredErrors(async () => {
      const agentArgs: Record<string, unknown> = { selector: requiredString(args, 'selector') };
      if (typeof args.text === 'string' && args.text) agentArgs.text = args.text;
      if (args.surface === 'canvas' || args.surface === 'panel' || args.surface === 'engine') agentArgs.surface = args.surface;
      const timeoutMs = Math.min(25_000, Math.max(1, parseOptionalNumber(args.timeoutMs) ?? 10_000));
      const deadline = Date.now() + timeoutMs;
      let last: unknown = { ok: false, error: 'never probed' };
      while (Date.now() < deadline) {
        const result = await browserAgentPost('probe', agentArgs);
        const text = result.content[0];
        if (text?.type !== 'text') return result;
        try {
          const parsed = JSON.parse(text.text) as { ok?: boolean; pending?: boolean };
          last = parsed;
          if (parsed.ok) return jsonResult(parsed);
          if (!parsed.pending) return jsonResult(parsed);
        } catch {
          // Unparseable responses may be a transient transport result.
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(250, remainingMs)));
        }
      }
      return jsonResult({ ok: false, timedOut: true, timeoutMs, last });
    }),
  };
}
