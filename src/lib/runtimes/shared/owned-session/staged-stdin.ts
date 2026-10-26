import { EMBEDDED_CHILD_POLICY_SCRIPT } from '@/lib/providers/embedded-child-policy';

// The relay is the detached group leader, not the server. It inherits the
// staged descriptor and owns the only pipe writer, including during backpressure.
const STAGED_STDIN_RELAY = EMBEDDED_CHILD_POLICY_SCRIPT + String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const expectedBytes = Number(process.argv[1]);
const payload = fs.readFileSync(0);
fs.closeSync(0);
function inputFailure(message) {
  fs.writeSync(2, 'O8_STDIN_DELIVERY_FAILED: ' + message + '\n');
}
if (payload.length !== expectedBytes) {
  inputFailure('staged input was truncated before delivery');
  process.exit(74);
}
const child = withO8ChildPolicy(env => spawn(process.argv[2], process.argv.slice(3), {
  env, windowsHide: true, stdio: ['pipe', 1, 2],
}), { preserveStamp: true });
let delivered = false;
let failed = false;
child.stdin.on('error', error => {
  failed = true;
  inputFailure(error.message);
});
child.stdin.end(payload, () => { delivered = true; });
child.on('error', error => { failed = true; inputFailure(error.message); });
child.on('close', (code, signal) => {
  if (failed || !delivered) {
    if (!failed) inputFailure('worker closed before staged input was delivered');
    process.exit(74);
  }
  if (signal) { process.exitCode = 1; process.kill(process.pid, signal); }
  else process.exit(code ?? 1);
});
`;

export function workerOwnedStdinInvocation(launch: { command: string; args: string[] }, bytes: number) {
  return { command: process.execPath, args: ['-e', STAGED_STDIN_RELAY, String(bytes), launch.command, ...launch.args] };
}
