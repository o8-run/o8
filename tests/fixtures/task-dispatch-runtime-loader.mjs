// Fallback for Node versions without synchronous module hooks.
import { readFileSync } from 'node:fs';
const stubUrl = new URL('./task-dispatch-runtime-stub.cjs', import.meta.url).href;
export function resolve(specifier, context, nextResolve) {
  if (/\/runtime\/actions(?:\.ts)?$/.test(specifier)) return { url: stubUrl, shortCircuit: true };
  return nextResolve(specifier, context);
}
export function load(url, context, nextLoad) {
  if (url === stubUrl) return { format: 'commonjs', source: readFileSync(new URL(stubUrl), 'utf8'), shortCircuit: true };
  return nextLoad(url, context);
}
