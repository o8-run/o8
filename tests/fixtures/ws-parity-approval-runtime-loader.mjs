// Keep dynamic runtime imports on the same stub as the preload's require seam.
const stubUrl = new URL('./ws-parity-approval-runtime-actions.cjs', import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (/\/runtime\/actions(?:\.ts)?(?:\?.*)?$/.test(specifier)) {
    return { url: stubUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
