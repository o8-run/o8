import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Keep the auxiliary webviews, the pages still reached by the shell/CLI, and the parked phone UI.
// See docs/internals/classic-web-page-inventory.md for callers and restoration.
const keptPages = [
  '/', '/agent-partials', '/broadcast', '/dashboard', '/dictation-pill',
  '/managed-chat-voice', '/mobile', '/mobile/visualizations/[id]', '/point-overlay', '/preview/canvas-glass', '/spatial-ink',
  '/voice-host', '/voice-settings',
];

it('keeps only page entry points with a remaining desktop, CLI, boot-path or parked-phone caller', () => {
  const pages = readdirSync(join(process.cwd(), 'src/app'), { recursive: true })
    .map(String)
    .filter(file => file === 'page.tsx' || file.endsWith('/page.tsx'))
    .map(file => file === 'page.tsx' ? '/' : `/${file.slice(0, -'/page.tsx'.length)}`)
    .sort();
  expect(pages).toEqual(keptPages);
});
