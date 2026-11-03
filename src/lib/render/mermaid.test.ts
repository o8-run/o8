// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('pele', async importOriginal => {
  const actual = await importOriginal<typeof import('pele')>();
  return { ...actual, render: vi.fn(actual.render) };
});

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(code: string) {
  const { renderMermaidSvg } = await import('./mermaid');
  const host = document.createElement('div');
  host.innerHTML = await renderMermaidSvg(code);
  return host;
}

describe('renderMermaidSvg', () => {
  it('renders a valid flowchart as SVG', async () => {
    const host = await render('flowchart LR\n A[Start] --> B[Done]');
    expect(host.querySelector('svg')).not.toBeNull();
    expect(host.textContent).toContain('Start');
    expect(host.textContent).toContain('Done');
  });

  it('rejects garbage so callers can show a code block', async () => {
    await expect(render('this is not a diagram')).rejects.toThrow();
  });

  it.each([
    '<script>alert(1)</script>',
    '<svg onload=alert(1)>label</svg>',
    '<foreignObject><div>label</div></foreignObject>',
  ])('strips active markup from a label: %s', async (label) => {
    const host = await render(`flowchart LR\n A["${label}"] --> B[Safe]`);
    expect(host.querySelector('svg')).not.toBeNull();
    expect(host.querySelector('script, foreignObject, [onload]')).toBeNull();
    for (const element of host.querySelectorAll('*')) {
      expect([...element.attributes].some(attr => /^on/i.test(attr.name))).toBe(false);
    }
    expect(host.textContent).toContain('Safe');
  });

  it('inherits light and dark theme tokens without rerendering', async () => {
    const host = await render('flowchart LR\n A --> B');
    const style = host.querySelector('svg')!.getAttribute('style');
    expect(style).toContain('--pele-fg: var(--t-text)');
    expect(style).toContain('--pele-surface: var(--t-panel)');
    expect(style).toContain('--pele-line: var(--t-text-muted)');
  });

  it('gives diagrams independent SVG IDs', async () => {
    const code = 'flowchart LR\n accTitle: Independent diagram\n A --> B';
    const first = await render(code);
    const second = await render(code);
    const ids = [...first.querySelectorAll('[id]')].map(el => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect([...second.querySelectorAll('[id]')].some(el => ids.includes(el.id))).toBe(false);
  });

  it('renders without secure-context crypto APIs', async () => {
    vi.stubGlobal('crypto', {});
    const host = await render('flowchart LR\n A --> B');
    expect(host.querySelector('svg')).not.toBeNull();
  });

  it('sanitizes renderer output even if the renderer returns active SVG', async () => {
    const pele = await import('pele');
    const result = pele.render('flowchart LR\n A --> B');
    const spy = vi.spyOn(pele, 'render').mockReturnValueOnce({
      ...result,
      svg: '<svg onload="alert(1)"><script>alert(1)</script><foreignObject><div>bad</div></foreignObject><rect width="10" height="10"/></svg>',
    });
    try {
      const host = await render('flowchart LR\n A --> B');
      expect(host.querySelector('rect')).not.toBeNull();
      expect(host.querySelector('script, foreignObject, [onload]')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
