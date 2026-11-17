import { readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(process.cwd(), 'src/app/api');
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
const templates = files(root).map(path => relative(root, path).replaceAll('\\', '/'))
  .filter(path => path.endsWith('/route.ts'))
  .map(path => '/api/' + path.slice(0, -'/route.ts'.length)).sort();
writeFileSync('crates/o8d/route-templates.json', JSON.stringify(templates, null, 2) + '\n');
console.log(`Refreshed ${templates.length} API route templates`);
