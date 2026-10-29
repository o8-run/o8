import { VISUALIZATION_LIMITS } from './types';
import { sealVisualizationScripts } from './scripts';
import { VISUALIZATION_STYLES } from './runtime-styles';
import { VISUALIZATION_CONTROLS } from './runtime-controls';
import { VISUALIZATION_CHARTS } from './runtime-charts';
import { VISUALIZATION_LAYOUTS } from './runtime-layouts';
import { visualizationState } from './view-state';
import { D3_LICENSE } from './vendor/license-notices';

export interface VisualizationTheme {
  colorScheme: 'light' | 'dark';
  variables: Record<string, string>;
}

export const VISUALIZATION_THEME_VARIABLES = [
  '--background', '--foreground', '--muted', '--muted-foreground', '--card', '--card-foreground', '--popover',
  '--border', '--accent', '--accent-foreground', '--primary', '--primary-foreground',
  '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--font-sans', '--font-mono',
] as const;

export function defaultVisualizationTheme(colorScheme: 'light' | 'dark' = 'dark'): VisualizationTheme {
  const dark = colorScheme === 'dark';
  return { colorScheme, variables: {
    '--background': 'transparent', '--foreground': dark ? '#eceef2' : '#20242c',
    '--muted': dark ? '#ffffff0d' : '#00000008', '--muted-foreground': dark ? '#a1a8b4' : '#656d79',
    '--card': dark ? '#ffffff08' : '#00000004', '--card-foreground': dark ? '#eceef2' : '#20242c',
    '--popover': dark ? '#18202eed' : '#fffffff2',
    '--border': dark ? '#ffffff1a' : '#0000001a', '--accent': '#85aaff', '--accent-foreground': '#172238',
    '--primary': '#85aaff', '--primary-foreground': '#172238', '--chart-1': dark ? '#eceef2' : '#364152',
    '--chart-2': '#dd835b', '--chart-3': '#70b5c4', '--chart-4': '#a599d8', '--chart-5': '#69bea6', '--chart-6': '#d8b16d',
    '--font-sans': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    '--font-mono': 'ui-monospace, SFMono-Regular, Consolas, monospace',
  } };
}

const INNER_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

/** Escape HTML parser delimiters, not just JavaScript quotes. */
function scriptJson(value: unknown): string { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }

async function innerDocument(html: string, nonce: string, theme: VisualizationTheme, state: Record<string, unknown>): Promise<string> {
  // A separate application chunk loads only when an actual visualization mounts.
  const { D3_SOURCE } = await import('./vendor/d3');
  const bootstrap = `(() => {
    const nonce = ${scriptJson(nonce)};
    const names = ${scriptJson(VISUALIZATION_THEME_VARIABLES)};
    window.__o8Visualization = {
      initialState: ${scriptJson(state)},
      post(type, value) { parent.postMessage({ type: 'o8-visualization:' + type, nonce, value }, '*'); }
    };
    function apply(theme) {
      if (!theme || !['light', 'dark'].includes(theme.colorScheme)) return;
      const root = document.documentElement;
      root.style.colorScheme = theme.colorScheme;
      root.dataset.theme = theme.colorScheme;
      root.classList.toggle('dark', theme.colorScheme === 'dark');
      for (const name of names) {
        const value = theme.variables && theme.variables[name];
        if (typeof value === 'string' && value.length <= 300) root.style.setProperty(name, value);
      }
      dispatchEvent(new CustomEvent('o8:visualization-theme'));
    }
    apply(${scriptJson(theme)});
    addEventListener('message', event => {
      if (event.source !== parent || event.data?.nonce !== nonce) return;
      if (event.data.type === 'o8-visualization:theme') apply(event.data.theme);
      if (event.data.type === 'o8-visualization:state') dispatchEvent(new CustomEvent('o8:visualization-state', { detail: event.data.value }));
    });
    let queued = false;
    let last = 0;
    let lastWidth = 0;
    let lastOverflow = 0;
    function measure() {
      queued = false;
      if (!document.body) return;
      const body = document.body.getBoundingClientRect();
      const overflow = document.documentElement.scrollHeight > innerHeight + 1 ? document.documentElement.scrollHeight : 0;
      const height = Math.max(${VISUALIZATION_LIMITS.minHeight}, Math.ceil(body.bottom + scrollY), overflow);
      const width = document.documentElement.clientWidth;
      const horizontalOverflow = Math.max(0, document.documentElement.scrollWidth - width);
      if (height === last && width === lastWidth && horizontalOverflow === lastOverflow) return;
      last = height;
      lastWidth = width;
      lastOverflow = horizontalOverflow;
      parent.postMessage({ type: 'o8-visualization:height', nonce, height, width, overflow: horizontalOverflow }, '*');
    }
    function queue() { if (!queued) { queued = true; requestAnimationFrame(measure); } }
    addEventListener('DOMContentLoaded', () => {
      new ResizeObserver(queue).observe(document.body);
      new MutationObserver(queue).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
      document.fonts.ready.then(queue);
      // Background and offscreen frames can suspend animation frames. Send the
      // first size synchronously so restored cards can finish loading there.
      measure();
    }, { once: true });
    addEventListener('resize', queue);
    addEventListener('load', queue);
    // Links do not leave the transcript. Local controls and anchor navigation still work.
    addEventListener('click', event => {
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (link && !link.getAttribute('href')?.startsWith('#')) event.preventDefault();
    }, true);
  })();`;
  const page = `<style>
    html { background: transparent; scrollbar-width: none; }
    body { display: flow-root; margin: 0; color: var(--foreground); background: transparent; font: 300 13px/1.55 var(--font-sans); -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums; }
    *, *::before, *::after { box-sizing: border-box; }
    ::-webkit-scrollbar { display: none; }
    img, svg, canvas { max-width: 100%; }
    button, input, select, textarea { font: inherit; }
    h1, h2, h3 { font-weight: 400; line-height: 1.3; letter-spacing: -.2px; }
    h1, h2 { font-size: 18px; } h3 { font-size: 14px; }
    code, pre, kbd { font-family: var(--font-mono); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    button { touch-action: manipulation; }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .001ms !important; transition-duration: .001ms !important; scroll-behavior: auto !important; } }
  </style><style>${VISUALIZATION_STYLES}</style><script>${bootstrap}</script>
  <script data-o8-toolkit="d3">/* ${D3_LICENSE} */\n${D3_SOURCE}</script><script>${VISUALIZATION_CONTROLS}</script><script>${VISUALIZATION_CHARTS}</script><script>${VISUALIZATION_LAYOUTS}</script>
  </head><body>${html.replace(/^\s*<!doctype[^>]*>/i, '')}</body></html>`;
  const sealed = await sealVisualizationScripts(page);
  // Both policies apply: hashes seal inline scripts; the base policy separately
  // denies external scripts even when an attacker supplies a matching SRI hash.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${INNER_CSP}"><meta http-equiv="Content-Security-Policy" content="${sealed.policy}">${sealed.html}`;
}

/** Keep the same opaque frame boundary when hosted by a system web view. */
export async function nativeVisualizationDocument(html: string, nonce: string): Promise<string> {
  return visualizationSrcdoc(html, nonce, defaultVisualizationTheme(), {}, true);
}

/**
 * A trusted opaque outer frame owns a second opaque srcdoc frame. Its frame-src
 * restriction also blocks the document's self-navigation, which a CSP on a
 * single srcdoc frame cannot prevent. Neither frame has app/network authority.
 */
export async function visualizationSrcdoc(html: string, nonce: string, theme: VisualizationTheme, initialState: unknown = {}, nativeHost = false): Promise<string> {
  const document = await innerDocument(html, nonce, theme, visualizationState(initialState) ?? {});
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${INNER_CSP}"><style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
  </style></head><body><iframe sandbox="allow-scripts" title="Interactive visualization"></iframe><script>(() => {
    const frame = document.querySelector('iframe');
    const nonce = ${scriptJson(nonce)};
    const deliver = ${nativeHost ? "data => dispatchEvent(new CustomEvent('o8:native-visualization-message', { detail: data }))" : "data => parent.postMessage(data, '*')"};
    frame.srcdoc = ${scriptJson(document)};
    addEventListener('message', event => {
      const data = event.data;
      if (!data || data.nonce !== nonce) return;
      if (event.source === frame.contentWindow) {
        if (data.type === 'o8-visualization:height' && Number.isFinite(data.height)) deliver({ type: data.type, nonce, height: data.height,
          width: Number.isFinite(data.width) ? data.width : undefined, overflow: Number.isFinite(data.overflow) ? data.overflow : undefined });
        if (data.type === 'o8-visualization:state' || data.type === 'o8-visualization:question') deliver({ type: data.type, nonce, value: data.value });
      } else if (event.source === parent && ['o8-visualization:theme', 'o8-visualization:state'].includes(data.type)) {
        frame.contentWindow.postMessage(data, '*');
      }
    });
  })();</script></body></html>`;
}
