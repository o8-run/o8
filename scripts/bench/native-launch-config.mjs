// Identical build-only isolation for both measured release artifacts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NATIVE_STARTUP_OBSERVER_JS } from './native-startup-observer.mjs';

const root = path.resolve(process.argv[2]);
assert(fs.existsSync(path.join(root, '.git')), 'Use a source checkout');
const layout = path.join(root, 'src/app/layout.tsx');
const source = fs.readFileSync(layout, 'utf8');
assert.equal(source.split('<head>').length, 2, 'Expected one document head in the disposable build copy');
assert(!source.includes('data-o8-startup-observer'), 'Prepare each clean build copy once');
fs.writeFileSync(layout, source.replace('<head>', `<head><script data-o8-startup-observer dangerouslySetInnerHTML={{ __html: ${JSON.stringify(NATIVE_STARTUP_OBSERVER_JS)} }} />`));
const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(path.join(work, '.gitignore'), '*\n');
fs.writeFileSync(path.join(work, 'native-launch.json'), JSON.stringify({
  identifier: 'ai.o8.desktop.launchbench',
  app: { windows: config.app.windows.map(window => ({ ...window, incognito: true })) },
  bundle: { createUpdaterArtifacts: false, macOS: { signingIdentity: '-' } },
}, null, 2) + '\n');
