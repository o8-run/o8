// Cover ESM imports in the WS child as well as the preload's CommonJS seam.
const stubUrl = new URL('./symon-brain-native-provider.mjs', import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (/\/symon\/durable\/managed-provider\.ts$/.test(resolved.url)) {
    return { url: stubUrl, shortCircuit: true };
  }
  return resolved;
}
