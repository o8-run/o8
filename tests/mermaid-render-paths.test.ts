// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeBlock as DesktopCodeBlock } from '@/components/desktop/CodeBlock';
import { CodeBlock as MobileCodeBlock } from '@/components/mobile/CodeBlock';
import { renderLLMMarkdown } from '@/components/desktop/LLMMarkdown';
import { MermaidViewer } from '@/components/desktop/canvas/CanvasDiffMermaidViewers';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const surfaces: Array<[string, (code: string) => ReactNode]> = [
  ['desktop code fence', code => createElement(DesktopCodeBlock, { code, language: 'mermaid' })],
  ['mobile code fence', code => createElement(MobileCodeBlock, { code, language: 'mermaid' })],
  ['markdown code fence', code => renderLLMMarkdown(`\`\`\`mermaid\n${code}\n\`\`\``)],
  ['canvas viewer', code => createElement(MermaidViewer, { code })],
];

async function show(content: ReactNode, selector = 'svg.pele') {
  await act(async () => root.render(content));
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(host.querySelector(selector)).not.toBeNull();
  }, { timeout: 5000 });
}

describe.each(surfaces)('%s', (_name, surface) => {
  it('renders a mermaid fence with Pele', async () => {
    await show(surface('flowchart LR\n A[Start] --> B[Done]'));
    expect(host.querySelector('svg.pele')).not.toBeNull();
    expect(host.textContent).toContain('Start');
  });

  it('falls back to a plain code block for garbage', async () => {
    const code = 'this is not a diagram';
    await show(surface(code), 'pre');
    expect(host.querySelector('pre')?.textContent).toBe(code);
  });

  it('recovers when invalid source is replaced with a valid diagram', async () => {
    await show(surface('this is not a diagram'), 'pre');
    await show(surface('flowchart LR\n A[Recovered] --> B[Done]'));
    expect(host.querySelector('pre')).toBeNull();
    expect(host.textContent).toContain('Recovered');
  });

  it('renders malicious labels without active markup', async () => {
    await show(surface('flowchart LR\n A["<script>alert(1)</script><svg onload=alert(1)>x</svg><foreignObject>bad</foreignObject>"] --> B[Safe]'));
    expect(host.querySelector('svg.pele')).not.toBeNull();
    expect(host.querySelector('script, foreignObject, [onload]')).toBeNull();
    expect(host.textContent).toContain('Safe');
  });
});
