import { sanitizeAgentHtml } from '@/lib/render/sanitize-html';

const THEME = {
  '--pele-bg': 'var(--t-panel)',
  '--pele-fg': 'var(--t-text)',
  '--pele-muted': 'var(--t-text-muted)',
  '--pele-line': 'var(--t-text-muted)',
  '--pele-surface': 'var(--t-panel)',
  '--pele-surface-alt': 'var(--t-bg-subtle)',
  '--pele-border': 'var(--t-panel-border)',
  '--pele-accent': 'var(--t-accent)',
};
let nextDiagramId = 0;

/** Browser-only, lazy SVG rendering. Callers retain the source as code on error. */
export async function renderMermaidSvg(code: string, fontSize = 14): Promise<string> {
  const { render } = await import('pele');
  const fontFamily = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-sans-system').trim() || 'system-ui, sans-serif';
  const { svg } = render(code, {
    fontFamily,
    fontSize,
    idPrefix: `mermaid-${++nextDiagramId}`,
    links: false,
  });

  // Keep the shared untrusted-HTML boundary before any SVG reaches a DOM sink.
  const template = document.createElement('template');
  template.innerHTML = sanitizeAgentHtml(svg);
  const diagram = template.content.querySelector('svg');
  if (!diagram) throw new Error('Diagram renderer returned no SVG');
  // Inline variables survive sanitization and follow light/dark token changes,
  // including when the same SVG is displayed in the zoom modal.
  for (const [name, value] of Object.entries(THEME)) diagram.style.setProperty(name, value);
  return diagram.outerHTML;
}
