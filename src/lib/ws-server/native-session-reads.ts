/**
 * Native session reads (threads, history, chat-history, composer-queue served
 * by o8d). On by default wherever the native transport is on (O8_NEXT_O8D=1).
 * O8D_NATIVE_SESSION_READS=0 turns them off and =1 forces them on, as before.
 */
export function nativeSessionReadsEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const flag = env.O8D_NATIVE_SESSION_READS;
  if (flag === '1') return true;
  if (flag === '0') return false;
  return env.O8_NEXT_O8D === '1';
}
