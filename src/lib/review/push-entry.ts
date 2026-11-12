// Trusted policy helper. Request data and inherited secrets arrive only on stdin.
async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 16 * 1024 * 1024) throw new Error('Push request too large');
  }
  const request = JSON.parse(input) as { root: string; env: NodeJS.ProcessEnv; observed: string[] };
  if (typeof request.root !== 'string' || !request.env || !Array.isArray(request.observed)) throw new Error('Invalid push request');
  // Policy modules must first load with the same environment as the owning server.
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, request.env);
  const { retainObservedChildSecrets, childObservedSecrets } = await import('@/lib/providers/spawn-environment');
  retainObservedChildSecrets(request.observed);
  const { pushWorkspace } = await import('./push-operation');
  const result = await pushWorkspace(request.root);
  process.stdout.write(JSON.stringify({ result, observed: childObservedSecrets() }));
}
main().catch(() => {
  // Never echo stdin, environment, loader errors or credentials to logs.
  process.stdout.write(JSON.stringify({ result: { status: 500, body: { error: 'Push failed' } }, observed: [] }));
  process.exitCode = 1;
});
