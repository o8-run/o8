import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { CliError, EXIT } from '../api.js';
import { resolveConfig, resolveCliDataDir, resolveCliTokenFiles } from '../config.js';

/** Local configuration discovery is restricted to the opt-in app shell. */
export async function runNext(args: string[]): Promise<number> {
  // Keep mode help separate from the shared fixture launcher help.
  if (args.includes('--help')) {
    process.stdout.write('App shell: --app-shell [--server ORIGIN] [--shell-state ABSOLUTE_FILE]. Uses existing local port/token configuration.\n');
  }
  if (args.includes('--help')) {
    process.stdout.write('o8 next --enable-next --binary /absolute/path/o8-next --server http://127.0.0.1:PORT [--offscreen] [--terminal SESSION_ID]\nSaved sessions, composer and opt-in terminal; build native/o8-next separately. Set O8_NEXT_API_TOKEN for the selected server.\n');
    return 0;
  }
  const at = args.indexOf('--binary');
  const binary = at >= 0 ? args[at + 1] : undefined;
  const shell = args.includes('--app-shell');
  if (!args.includes('--enable-next') || !binary || !isAbsolute(binary) || (!shell && !args.includes('--server'))) {
    throw new CliError('invalid_args', 'Pass --enable-next, --binary with an absolute executable path, and --server.', EXIT.INVALID_ARGS);
  }
  const forwarded = [...args.slice(0, at), ...args.slice(at + 2)];
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
