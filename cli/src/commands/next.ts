import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { CliError, EXIT } from '../api.js';
import { resolveConfig, resolveCliDataDir, resolveCliTokenFiles } from '../config.js';
import { runServe } from './serve.js';

const INSTALLED_BINARY = '/Applications/o8.app/Contents/MacOS/o8-next';

async function serverIsHealthy(origin: string): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/api/setup/identity`, {
      signal: AbortSignal.timeout(1_000), redirect: 'error',
    });
    if (!response.ok) return false;
    return (await response.json() as { product?: unknown }).product === 'o8';
  } catch { return false; }
}

async function ensureServer(): Promise<void> {
  if (await serverIsHealthy(resolveConfig().apiBase)) return;
  process.stderr.write('Starting o8 serve; waiting for the local server to become healthy...\n');
  try {
    await runServe({ human: true, verbose: false }, undefined, []);
  } catch (error) {
    throw new CliError('next_server_start_failed',
      `Could not start o8 serve: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.CONNECTION_REFUSED, 'Run `o8 serve status` and inspect the serve log.');
  }
  if (!await serverIsHealthy(resolveConfig().apiBase)) {
    throw new CliError('next_server_unhealthy', 'o8 serve started, but the selected local server is not healthy.',
      EXIT.CONNECTION_REFUSED, 'Run `o8 serve status` and inspect the serve log.');
  }
}

/** The default shell shares the existing local server and credential resolver. */
export async function runNext(args: string[]): Promise<number> {
  if (args.includes('--help')) {
    process.stdout.write('o8 next [--binary ABSOLUTE_PATH] [--server ORIGIN] [--shell-state ABSOLUTE_FILE]\nOpens the native app shell using /Applications/o8.app/Contents/MacOS/o8-next by default. Reuses a healthy local server or starts o8 serve and waits for health.\nQuitting the window leaves the headless server running. Stop it with: o8 serve stop\nExplicit fixture mode: --enable-next --binary ABSOLUTE_PATH --server ORIGIN [--offscreen] [--terminal SESSION_ID]\n--app-shell explicitly selects the shell. Explicit --server attaches only; existing env-only credentials and numeric loopback HTTP rules apply.\n');
    return 0;
  }
  const at = args.indexOf('--binary');
  const binary = at >= 0 ? args[at + 1] : INSTALLED_BINARY;
  const shell = args.includes('--app-shell') || !args.includes('--enable-next');
  if (!binary || !isAbsolute(binary) || (!shell && !args.includes('--server'))) {
    throw new CliError('invalid_args', 'Pass --binary with an absolute executable path; fixture mode also requires --server.', EXIT.INVALID_ARGS);
  }
  try { accessSync(binary, constants.X_OK); } catch {
    throw new CliError('native_unavailable', 'Could not launch the native binary. Install o8 or pass --binary with an absolute executable path.', EXIT.INVALID_ARGS);
  }
  const forwarded = at < 0 ? [...args] : [...args.slice(0, at), ...args.slice(at + 2)];
  if (!forwarded.includes('--enable-next')) forwarded.push('--enable-next');
  if (shell && !forwarded.includes('--app-shell')) forwarded.push('--app-shell');
  if (shell && !forwarded.includes('--server')) await ensureServer();
  if (shell) process.stderr.write('Quitting the window leaves the server running. Stop it with: o8 serve stop\n');
  const env = { ...process.env };
  if (shell) {
    const config = resolveConfig();
    const explicitNativeToken = Boolean(env.O8_NEXT_API_TOKEN?.trim());
    delete env.O8_NEXT_TOKEN_FILE;
    delete env.O8_NEXT_TOKEN_FILES;
    delete env.O8_NEXT_TOKEN_ORIGIN;
    const serverAt = forwarded.indexOf('--server');
    const origin = serverAt < 0 ? config.apiBase : forwarded[serverAt + 1];
    let url: URL;
    try { url = new URL(origin ?? ''); } catch {
      throw new CliError('invalid_args', 'App shell requires a numeric loopback HTTP origin.', EXIT.INVALID_ARGS);
    }
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new CliError('invalid_args', 'App shell requires a numeric loopback HTTP origin.', EXIT.INVALID_ARGS);
    }
    if (serverAt < 0) forwarded.push('--server', config.apiBase);
    if (config.source.token === 'worker' || url.origin !== config.apiBase) {
      delete env.O8_NEXT_CLERK_SESSION_TOKEN;
    }
    // An explicitly selected fixture server must never inherit another server's
    // disk credential. Worker credentials keep their existing lower authority.
    if (config.source.token === 'worker') {
      delete env.O8_NEXT_API_TOKEN;
      if (url.origin === config.apiBase && config.token) env.O8_NEXT_API_TOKEN = config.token;
    } else if (!env.O8_NEXT_API_TOKEN && url.origin === config.apiBase && config.token) {
      env.O8_NEXT_API_TOKEN = config.token;
    }
    if (!explicitNativeToken && config.source.token !== 'worker' && config.source.token !== 'env'
      && url.origin === config.apiBase) {
      const files = resolveCliTokenFiles();
      env.O8_NEXT_TOKEN_FILE = files[0];
      env.O8_NEXT_TOKEN_FILES = JSON.stringify(files);
      env.O8_NEXT_TOKEN_ORIGIN = url.origin;
    }
    if (!forwarded.includes('--shell-state')) forwarded.push('--shell-state', join(config.dataDir || resolveCliDataDir(), 'next-shell.json'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, forwarded, { stdio: 'inherit', shell: false, env });
    const forward = () => { child.kill('SIGTERM'); };
    process.once('SIGTERM', forward); process.once('SIGINT', forward);
    const remove = () => { process.off('SIGTERM', forward); process.off('SIGINT', forward); };
    child.once('error', () => { remove(); reject(new CliError('native_unavailable', 'Could not launch the selected native binary.', EXIT.INVALID_ARGS)); });
    child.once('exit', code => { remove(); resolve(code ?? 1); });
  });
}
