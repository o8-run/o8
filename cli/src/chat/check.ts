import WebSocket from 'ws';
import { CliError, EXIT, resolveWsBase } from '../api.js';
import type { ResolvedConfig } from '../config.js';

/** An authenticated transport check, without subscriptions or conversation turns. */
export function checkChatConnection(cfg: ResolvedConfig): Promise<void> {
  if (cfg.source.token === 'worker') {
    return Promise.reject(new CliError('operator_required', 'Chat checks require an operator connection.', EXIT.UNAUTHORIZED));
  }
  const url = new URL('/ws', resolveWsBase(cfg));
  if (cfg.token) url.searchParams.set('token', cfg.token);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (ok) resolve();
      else reject(new CliError('chat_unavailable', 'Cannot reach the terminal chat transport. Start the app and retry.', EXIT.SERVER_TIMEOUT));
    };
    const timer = setTimeout(() => finish(false), 8_000);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'ping' })));
    socket.on('message', raw => {
      try {
        if (JSON.parse(String(raw)).channel === 'pong') finish(true);
      } catch { /* Ignore unrelated or malformed events until the check settles. */ }
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}
