/** Owned host with observed readiness for cold imports and loaded local machines. */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
type Receipt = Record<string, unknown> & { origin: string };

export async function startInlineHost(options = ['--inline'], token = process.env.O8_NEXT_API_TOKEN ?? 'fixture-inline-operator') {
  const host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', ...options], { env: { ...process.env, O8_NEXT_API_TOKEN: token,
      O8_NEXT_INLINE_OWNER_PID: String(process.pid) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostic = '';
  host.stderr.on('data', chunk => {
    diagnostic = (diagnostic + String(chunk)).slice(-8192);
    if (basename(process.argv[1] ?? '') === 'inline-host-fixture.ts') process.stderr.write(chunk);
  });
  const lines = createInterface({ input: host.stdout });
  const deadline = Date.now() + 180_000;
  const receipt = await new Promise<Receipt>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Inline host did not announce readiness: ${diagnostic}`)), 180_000);
    host.once('error', error => { clearTimeout(timer); reject(error); });
    host.once('exit', code => { clearTimeout(timer); reject(new Error(`Inline host exited before readiness (${code}): ${diagnostic}`)); });
    lines.on('line', line => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (typeof value.origin === 'string') { clearTimeout(timer); resolve(value as Receipt); }
      } catch { /* Production fixture logs are not receipts. */ }
    });
  }).catch(async error => { await closeInlineHost(host); throw error; });
  try {
    let last = '';
    while (Date.now() < deadline && host.exitCode === null) {
      try {
        const response = await fetch(receipt.origin + '/api/orchestrator/inline-fixture-ready', {
          headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
        });
        const data = await response.json() as { ready?: boolean };
        if (response.ok && data.ready === true) return { host, receipt, origin: receipt.origin };
        last = `HTTP ${response.status}`;
      } catch (error) { last = error instanceof Error ? error.message : String(error); }
      await delay(100);
    }
    throw new Error(`Inline host readiness failed (${last}, exit=${host.exitCode}): ${diagnostic}`);
  } catch (error) { await closeInlineHost(host); throw error; }
}

export async function closeInlineHost(host: ChildProcess) {
  if (host.exitCode === null && host.signalCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); }
}

if (basename(process.argv[1] ?? '') === 'inline-host-fixture.ts') {
  void startInlineHost(process.argv.slice(2)).then(({ host, receipt }) => {
    process.stdout.write(JSON.stringify(receipt) + '\n');
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
      void closeInlineHost(host).then(() => process.exit(0));
    });
    host.once('exit', code => process.exit(code ?? 1));
  }).catch(error => { console.error('[inline-host-fixture]', error); process.exitCode = 1; });
}
