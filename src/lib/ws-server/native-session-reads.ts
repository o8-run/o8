/**
 * Native session reads (threads, history, chat-history, composer-queue and the
 * project registry served by o8d). On by default only with O8_NEXT_O8D=1. The
 * API front door leaves them off: WS serves the same routes from the working
 * TypeScript handlers, and the Rust project reader is not selected.
 * O8D_NATIVE_SESSION_READS=1 forces them on, as before; any other value
 * (0, false, off, empty) turns them off. Only an unset flag takes the default.
 */
export function nativeSessionReadsEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const flag = env.O8D_NATIVE_SESSION_READS;
  if (flag === undefined) return env.O8_NEXT_O8D === '1';
  return flag === '1';
}
