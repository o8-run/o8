import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Keep the auxiliary webviews and the pages still reached by the shell/CLI. `/`, `/dashboard` and
// `/mobile` serve only the static desktop-app notice since the browser console was removed.
// See docs/internals/classic-web-page-inventory.md for callers and restoration.
const keptPages = [
  '/', '/agent-partials', '/broadcast', '/dashboard', '/dictation-pill',
  '/managed-chat-voice', '/mobile', '/point-overlay', '/spatial-ink',
  '/voice-host', '/voice-settings',
];

it('keeps only page entry points with a remaining desktop, CLI or boot-path caller', () => {
  const pages = readdirSync(join(process.cwd(), 'src/app'), { recursive: true })
    .map(String)
    .filter(file => file === 'page.tsx' || file.endsWith('/page.tsx'))
    .map(file => file === 'page.tsx' ? '/' : `/${file.slice(0, -'/page.tsx'.length)}`)
    .sort();
  expect(pages).toEqual(keptPages);
});
