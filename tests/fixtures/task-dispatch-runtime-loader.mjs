// Registered after tsx so this resolver sees runtime actions before delegating.
import { readFileSync } from 'node:fs';
const stubUrl = new URL('./task-dispatch-runtime-exports.mjs', import.meta.url).href;
export function resolve(specifier, context, nextResolve) {
  if (/\/runtime\/actions(?:\.ts)?$/.test(specifier)) return { url: stubUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
export function load(url, context, nextLoad) {
  if (url === stubUrl) return { format: 'module', source: readFileSync(new URL(stubUrl), 'utf8'), shortCircuit: true };
  return nextLoad(url, context);
}
