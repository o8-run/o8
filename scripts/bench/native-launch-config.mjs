// Identical build-only isolation for both measured release artifacts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2]);
assert(fs.existsSync(path.join(root, '.git')), 'Use a source checkout');
const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });
fs.writeFileSync(path.join(work, '.gitignore'), '*\n');
fs.writeFileSync(path.join(work, 'native-launch.json'), JSON.stringify({
  identifier: 'ai.o8.desktop.launchbench',
  app: { windows: config.app.windows.map(window => ({ ...window, incognito: true })) },
  bundle: { createUpdaterArtifacts: false, macOS: { signingIdentity: '-' } },
}, null, 2) + '\n');
