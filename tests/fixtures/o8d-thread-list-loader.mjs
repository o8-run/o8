// Dynamic imports and require use the same counter wrappers on Node 22.
const proxy = new URL('./o8d-thread-list-proxy.cjs', import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  const path = new URL(result.url).pathname;
  if (/\/(?:ws-server\/(?:native-http-routes|native-thread-list-compose)|bots\/network-projection|mobile\/machine-name)\.ts$/.test(path)) return { url: proxy, shortCircuit: true };
  return result;
}
