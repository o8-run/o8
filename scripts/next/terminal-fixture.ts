/** Owns the production WS server and fixture PTYs in the disposable store.
 * No server handler is replaced; Python is the deterministic terminal workload. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

export async function startTerminalFixture(dataDir: string, repo: string, apiPort: number, token: string, sessionNames = ['cortex-next-terminal-fixture']) {
  const reservation = createServer();
  await new Promise<void>(ready => reservation.listen(0, '127.0.0.1', ready));
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Missing terminal fixture port');
  const port = address.port;
  await new Promise<void>(ready => reservation.close(() => ready()));
  const child = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs',
    '--import', 'tsx', 'src/ws-server.ts'], {
    env: { ...process.env, O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
      CORTEX_IDE_DB_PATH: join(dataDir, 'fixture.db'), CORTEX_IDE_REVIEW_REPO_ROOT: repo,
      O8_WS_PORT: String(port), WS_PORT: String(port), O8_API_PORT: String(apiPort),
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`, O8_PERSISTENT_TERMINALS: '0',
      O8_TERMINAL_HOST: 'inline', WS_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); child.stderr.resume();
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited; clearTimeout(timer);
  };
  try {
    const deadline = Date.now() + 20_000;
    while (true) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* starting */ }
      if (Date.now() > deadline || child.exitCode !== null) throw new Error('Terminal fixture did not start');
      await new Promise(ready => setTimeout(ready, 20));
    }
    const sessionName = sessionNames[0];
    const script = resolve('native/o8-next/fixtures/terminal.py').replaceAll("'", "'\\''");
    for (const sessionName of sessionNames) {
      const env = Object.fromEntries([
        'O8_NEXT_TERMINAL_START_GATE', 'O8_NEXT_TERMINAL_FLOOD_TAIL_GATE',
      ].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
      const response = await fetch(`http://127.0.0.1:${port}/terminal-spawn`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionName, shellCommand: `python3 '${script}'`, cwd: repo, cols: 80, rows: 24, env }),
      });
      if (!response.ok) throw new Error(`Fixture PTY spawn failed (${response.status})`);
    }
    // Spawn acknowledges the PTY, not the child's first write. Consumers must
    // observe readiness through terminal data before asserting replay content.
    return { port, sessionName, sessionNames, close };
  } catch (error) { await close(); throw error; }
}
