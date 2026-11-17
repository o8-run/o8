import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkInventory(routes, tests, count, ceiling) {
  const errors = [];
  if (count > ceiling) errors.push(`TypeScript route count ${count} exceeds ${ceiling}`);
  const states = ['claimed', 'red', 'rust-with-fallback', 'shadow-clean', 'rust-only', 'removed'];
  const seen = new Set();
  for (const route of routes) {
    if (!states.includes(route.state)) errors.push(`Invalid state: ${route.path}`);
    if (!route.path?.startsWith('/api/') || !route.methods?.length) errors.push('Invalid route');
    for (const method of route.methods ?? []) {
      const key = `${method} ${route.path}`;
      if (seen.has(key)) errors.push(`duplicate route: ${key}`);
      seen.add(key);
    }
    if (typeof route.fallback !== 'boolean' || !route.reason) errors.push(`Missing fallback decision: ${route.path}`);
    if (!route.test?.startsWith('tests/') || !route.test.endsWith('.test.ts')
      || !tests.get(route.test)?.includes(`'${route.path}'`)) errors.push(`Missing route test: ${route.path}`);
  }
  return errors;
}
function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const routes = JSON.parse(readFileSync('crates/o8d/native-routes.json', 'utf8'));
  const tests = new Map(routes.map(route => {
    try { return [route.test, readFileSync(join(root, route.test), 'utf8')]; }
    catch { return [route.test, '']; }
  }));
  const count = files(join(root, 'src/app/api')).filter(path => relative(root, path).endsWith('/route.ts')).length;
  // Ratchet this ceiling down with removals; never raise it to admit new routes.
  const ceiling = JSON.parse(readFileSync('crates/o8d/route-budget.json', 'utf8')).maxTypeScriptRoutes;
  const mainCount = execFileSync('git', ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'src/app/api'], { encoding: 'utf8' })
    .split('\n').filter(path => path.endsWith('/route.ts')).length;
  const errors = checkInventory(routes, tests, count, Math.min(ceiling, mainCount));
  const actualTemplates = files(join(root, 'src/app/api')).filter(path => path.endsWith('/route.ts'))
    .map(path => '/api/' + relative(join(root, 'src/app/api'), path).replaceAll('\\', '/').replace(/\/route\.ts$/, '')).sort();
  const templates = JSON.parse(readFileSync('crates/o8d/route-templates.json', 'utf8'));
  if (JSON.stringify(templates) !== JSON.stringify(actualTemplates)) errors.push('Refresh counts-only route templates from API route paths');
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log(`Native route inventory: ${count}/${ceiling} TypeScript routes; ${routes.length} covered entries`);
}
