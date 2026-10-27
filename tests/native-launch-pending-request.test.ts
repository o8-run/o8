// @vitest-environment jsdom
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

const probe = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  `import { COMPOSER_PROBE_JS } from ${JSON.stringify(pathToFileURL(resolve('scripts/bench/native-launch.mjs')).href)}; process.stdout.write(JSON.stringify(COMPOSER_PROBE_JS));`,
], { encoding: 'utf8' })) as string;

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as Record<string, unknown>).__o8StartupFetchObserved;
  delete (window as unknown as Record<string, unknown>).__o8OptionalStartupRequests;
  delete (window as unknown as Record<string, unknown>).__o8StartupObserverVersion;
});

it('counts a connected request started before the first composer probe while its response is pending', () => {
  const root = mkdtempSync(join(tmpdir(), 'o8-launch-observer-'));
  try {
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'src-tauri'));
    mkdirSync(join(root, 'src/app'), { recursive: true });
    writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ app: { windows: [{}] } }));
    writeFileSync(join(root, 'src/app/layout.tsx'), '<html><head></head><body /></html>');
    execFileSync(process.execPath, [resolve('scripts/bench/native-launch-config.mjs'), root]);
    const layout = readFileSync(join(root, 'src/app/layout.tsx'), 'utf8');
    const script = layout.match(/data-o8-startup-observer dangerouslySetInnerHTML=\{\{ __html: (.+) \}\}/)?.[1];
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    if (script) window.eval(JSON.parse(script));
    void window.fetch('/api/automations/connected');
    window.eval(probe);
    expect((window as unknown as Record<string, unknown>).__o8OptionalStartupRequests).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
