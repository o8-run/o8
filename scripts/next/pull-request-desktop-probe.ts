/** Real desktop control oracle for headless GPUI fixture comparisons. */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { PrDetail } from '../../src/components/desktop/pr-panel/types';
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis };
};

async function main() {
  const { detail, method = 'squash', mode } = JSON.parse(readFileSync(0, 'utf8')) as { detail: PrDetail; method?: string; mode?: 'reviews' };
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
  Object.assign(globalThis, { React, window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, HTMLButtonElement: dom.window.HTMLButtonElement,
    Node: dom.window.Node, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });
  // Preparing a merge is read-only. Any network call is a probe failure.
  globalThis.fetch = async () => { throw new Error('Desktop gate probe attempted a write'); };
  if (mode === 'reviews') {
    const { ReviewsTab } = await import('../../src/components/desktop/pr-panel/tabs/ReviewsTab');
    const root = createRoot(document.getElementById('root')!);
    const render = async (value: PrDetail) => React.act(async () => root.render(React.createElement(ReviewsTab, {
      reviewComments: value.reviewComments, issueComments: value.issueComments, reviewDecision: value.reviewDecision, detail: value,
    })));
    await render(detail);
    const source = document.querySelector<HTMLAnchorElement>('a');
    source?.focus();
    const initialText = document.body.textContent;
    const links = [...document.querySelectorAll('a')].map(link => ({ href: link.href, label: link.getAttribute('aria-label') }));
    // Repeated provider delivery must retain the actual focused DOM node.
    await render({ ...detail, submittedReviews: [...(detail.submittedReviews ?? []), ...(detail.submittedReviews ?? [])] });
    const focusRetained = document.activeElement === source;
    const repeatedText = document.body.textContent;
    await render({ ...detail, headSha: 'd'.repeat(40) });
    const changedText = document.body.textContent;
    await render({ ...detail, headSha: undefined, submittedReviews: [{ ...detail.submittedReviews![0], reviewedHeadSha: null, url: null }] });
    const unknownText = document.body.textContent;
    await React.act(async () => root.unmount());
    dom.window.close();
    process.stdout.write(JSON.stringify({ initialText, links, focusRetained, repeatedText, changedText, unknownText }) + '\n');
    return;
  }
  const { PrPanelActions } = await import('../../src/components/desktop/pr-panel/PrPanelActions');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => root.render(React.createElement(PrPanelActions, {
    detail, onRefresh() {}, onAsk() {}, onComposerMode() {},
  })));
  await React.act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Pull request actions"]')!.click());
  const label = method === 'merge' ? 'Merge' : method === 'rebase' ? 'Rebase and merge' : 'Squash and merge';
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(b => b.textContent === label);
  if (!button) throw new Error('Desktop merge control is missing');
  const allowed = !button.disabled;
  await React.act(async () => root.unmount());
  dom.window.close();
  process.stdout.write(JSON.stringify({ allowed }) + '\n');
}
void main().catch(() => { process.stderr.write('Desktop gate probe failed\n'); process.exitCode = 1; });
