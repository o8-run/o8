const proxy = new URL('./o8d-directives-proxy.cjs', import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (/\/ws-server\/native-directives-completion\.ts$/.test(new URL(result.url).pathname)) return { url: new URL('./o8d-directives-completion-proxy.cjs', import.meta.url).href, shortCircuit: true };
  return /\/ws-server\/native-http-routes\.ts$/.test(new URL(result.url).pathname) ? { url: proxy, shortCircuit: true } : result;
}
