import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The deb/rpm `.desktop` entry is what `xdg-open o8://...` launches until o8's
// runtime `register_all()` has written its own handler. Tauri's default
// template already lists `MimeType=x-scheme-handler/o8` (from
// `plugins.deep-link.desktop.schemes`) but ends `Exec=o8` with no field code,
// and launchers pass the URL only through `%u`/`%U`, so a sign-in click
// started o8 without the callback. Seen on a Debian 13 install of v0.1.810.
const TAURI_DIR = join(__dirname, '..', 'src-tauri');

type LinuxConfig = {
  plugins?: { 'deep-link'?: { desktop?: { schemes?: string[] } } };
  bundle?: { linux?: Record<'deb' | 'rpm', { desktopTemplate?: string } | undefined> };
};

const config: LinuxConfig = JSON.parse(
  readFileSync(join(TAURI_DIR, 'tauri.linux.conf.json'), 'utf-8'),
);

// The bundler renders the template with handlebars; this covers the subset
// the template uses ({{var}} and {{#if var}}...{{/if}}).
function render(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\{#if (\w+)\}\}\n?([\s\S]*?)\{\{\/if\}\}\n?/g, (_m, key: string, body: string) =>
      vars[key] ? body : '',
    )
    .replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? '');
}

describe('Linux .desktop entry hands o8:// URLs to the app', () => {
  it('registers the o8 scheme with the deep-link plugin', () => {
    expect(config.plugins?.['deep-link']?.desktop?.schemes).toContain('o8');
  });

  describe.each(['deb', 'rpm'] as const)('%s bundle', (target) => {
    const templatePath = config.bundle?.linux?.[target]?.desktopTemplate;

    it('uses the repo desktop template', () => {
      expect(templatePath).toBeDefined();
      expect(existsSync(join(TAURI_DIR, templatePath!))).toBe(true);
    });

    it('renders an Exec line that receives the URL and keeps the MimeType', () => {
      const rendered = render(readFileSync(join(TAURI_DIR, templatePath!), 'utf-8'), {
        categories: '',
        comment: 'o8',
        exec: 'o8',
        icon: 'o8',
        name: 'o8',
        mime_type: 'x-scheme-handler/o8',
      });
      const lines = rendered.split('\n');
      expect(lines).toContain('Exec=o8 %u');
      expect(lines).toContain('MimeType=x-scheme-handler/o8');
      expect(lines).toContain('StartupWMClass=o8');
      expect(rendered).not.toMatch(/\{\{/);
    });
  });
});
