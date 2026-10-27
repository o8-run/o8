// These edits live only in disposable build copies, never the review branches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2]);
assert(fs.existsSync(path.join(root, '.git')), 'Use a disposable source checkout');
const page = path.join(root, 'src/app/dashboard/page.tsx');
let source = fs.readFileSync(page, 'utf8');
const remove = [
  "import { prefetchConnectedAutomations } from '@/components/desktop/automations-page/connected-cache';\n",
  "      import('@/components/desktop/Canvas');\n",
  "      import('@/components/desktop/O8Panel');\n",
  "      import('@/components/desktop/AutomationsPage');\n",
  '      prefetchConnectedAutomations();\n',
];
for (const text of remove) {
  assert.equal(source.split(text).length, 2, 'The measurement-only prefetch patch must match exactly');
  source = source.replace(text, '');
}
fs.writeFileSync(page, source);
const layout = path.join(root, 'src/app/layout.tsx');
const frame = fs.readFileSync(new URL('./launch-frame-probe.js', import.meta.url), 'utf8');
source = fs.readFileSync(layout, 'utf8');
assert.equal(source.split('<head>').length, 2);
source = source.replace('<head>', `<head><script dangerouslySetInnerHTML={{ __html: ${JSON.stringify(frame)} }} />`);
fs.writeFileSync(layout, source);

// Build-time module identities do not change the emitted client code.
const nextConfig = path.join(root, 'next.config.ts');
source = fs.readFileSync(nextConfig, 'utf8');
const hook = 'webpack: (config, { dev }) => {';
assert.equal(source.split(hook).length, 2);
source = "import { writeFileSync as writeLaunchStats } from 'node:fs';\n" + source.replace(hook, `webpack: (config, { dev, isServer }) => {
    if (!dev && !isServer) config.plugins.push({
      apply(compiler: { hooks: { done: { tap(name: string, handler: (stats: { toJson(options: unknown): unknown }) => void): void } } }) {
        compiler.hooks.done.tap('LaunchModuleIdentity', stats => {
          writeLaunchStats(${JSON.stringify(path.join(root, 'work/launch-client-modules.json'))}, JSON.stringify(stats.toJson({ all: false, ids: true, modules: true, nestedModules: true })));
        });
      },
    });`);
fs.writeFileSync(nextConfig, source);

const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
fs.mkdirSync(path.join(root, 'work'), { recursive: true });
fs.writeFileSync(path.join(root, 'work/.gitignore'), '*\n');
fs.writeFileSync(path.join(root, 'work/native-launch.json'), JSON.stringify({
  identifier: 'ai.o8.desktop.launchbench',
  app: { windows: config.app.windows.map(window => ({ ...window, incognito: true })) },
  bundle: { createUpdaterArtifacts: false, macOS: { signingIdentity: '-' } },
}, null, 2) + '\n');
