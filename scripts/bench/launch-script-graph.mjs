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
  const page = Object.entries(manifest.clientModules).find(([file]) => file.endsWith('/app/dashboard/page.tsx'));
  initial = scripts(page?.[1].chunks);
  graphSource = 'dashboard page client reference';
}
if (!initial.length && fs.existsSync(path.join(root, 'app-build-manifest.json'))) {
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
let composerLoader = null;
const labels = ['label:"Orchestrator tab"', "label:'Orchestrator tab'"];
for (const file of initialScripts) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const label = labels.find(value => source.includes(value));
  if (!label) continue;
  const at = source.indexOf(label);
  const start = source.lastIndexOf('()=>', at);
  if (start < 0 || at - start > 4000) throw new Error('Composer loader expression was not recognized');
  const ids = [...source.slice(start, at).matchAll(new RegExp('[.]e[(]([0-9]+)[)]', 'g'))].map(match => match[1]);
  const files = fs.readdirSync(path.join(root, 'static/chunks'), { recursive: true })
    .filter(name => name.endsWith('.js') && ids.some(id => path.basename(name).startsWith(id + '.') || path.basename(name).startsWith(id + '-')))
    .map(name => 'static/chunks/' + name.split(path.sep).join('/'));
  composerLoader = { file, chunkIds: ids, files, deferred: files.filter(name => !initialScripts.has(name)) };
}
console.log(JSON.stringify({ schema: 'o8/launch-script-graph/v1', graphSource,
  initialScriptCount: initialScripts.size, modules, composerLoader }));
if (process.argv.includes('--require-initial-composer') && composerLoader?.deferred.length) {
  throw new Error('Default composer requires deferred scripts');
}
