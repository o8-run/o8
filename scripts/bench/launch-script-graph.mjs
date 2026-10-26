// Relate the default composer to the initial scripts in a packaged build.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(process.argv[2]);
const context = {};
vm.runInNewContext(fs.readFileSync(path.join(root, 'server/app/dashboard/page_client-reference-manifest.js'), 'utf8'), context, { timeout: 1000 });
const manifest = context.__RSC_MANIFEST?.['/dashboard/page'];
if (!manifest) throw new Error('Dashboard client manifest is missing');
function scripts(value) {
  if (typeof value === 'string') {
    if (!value.endsWith('.js')) return [];
    return [value.startsWith('/_next/') ? value.slice(7) : value.startsWith('_next/') ? value.slice(6) : value];
  }
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(scripts);
}
let initial = scripts(manifest.entryJSFiles);
let graphSource = 'client-reference entryJSFiles';
if (!initial.length) {
  const build = JSON.parse(fs.readFileSync(path.join(root, 'app-build-manifest.json'), 'utf8'));
  initial = ['/layout', '/dashboard/layout', '/dashboard/page'].flatMap(key => scripts(build.pages[key]));
  graphSource = 'app-build-manifest route entries';
}
if (!initial.length) throw new Error('Initial dashboard script graph is empty');
const initialScripts = new Set(initial);
const modules = [];
for (const name of ['WorkspaceTerminalPanels', 'OrchestratorTab', 'ThoughtsChatPanel', 'ComposerArea']) {
  const entries = Object.entries(manifest.clientModules).filter(([file]) => file.endsWith('/' + name + '.tsx'));
  for (const [, value] of entries) {
    const files = scripts(value.chunks);
    modules.push({ name, async: value.async, files, initial: files.filter(file => initialScripts.has(file)),
      deferred: files.filter(file => !initialScripts.has(file)) });
  }
}
console.log(JSON.stringify({ schema: 'o8/launch-script-graph/v1', graphSource,
  initialScriptCount: initialScripts.size, modules }));
