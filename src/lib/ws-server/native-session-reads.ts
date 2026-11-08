/**
 * Native session reads (threads, history, chat-history, composer-queue served
 * by o8d). On by default wherever the native transport is on (O8_NEXT_O8D=1).
 * O8D_NATIVE_SESSION_READS=1 forces them on, as before; any other value
 * (0, false, off, empty) turns them off. Only an unset flag takes the default.
 */
export function nativeSessionReadsEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const flag = env.O8D_NATIVE_SESSION_READS;
  if (flag === undefined) return env.O8_NEXT_O8D === '1';
  return flag === '1';
}
