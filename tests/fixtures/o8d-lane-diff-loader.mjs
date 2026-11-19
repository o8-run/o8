const proxy=new URL('./o8d-lane-diff-proxy.cjs',import.meta.url).href;
export async function resolve(specifier,context,nextResolve){const result=await nextResolve(specifier,context);return /\/ws-server\/native-http-routes\.ts$/.test(new URL(result.url).pathname)?{url:proxy,shortCircuit:true}:result;}
