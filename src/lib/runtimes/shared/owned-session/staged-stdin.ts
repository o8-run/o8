import { EMBEDDED_CHILD_POLICY_SCRIPT } from '@/lib/providers/embedded-child-policy';

// The relay is the detached group leader, not the server. It inherits the
// staged descriptor and owns the only pipe writer, including during backpressure.
const STAGED_STDIN_RELAY = EMBEDDED_CHILD_POLICY_SCRIPT + String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const expectedBytes = Number(process.argv[1]);
const payload = fs.readFileSync(0);
fs.closeSync(0);
let deliveredBytes = 0;
let failed = false;
function recordDelivery(error) {
  fs.writeSync(3, JSON.stringify({ stagedBytes: expectedBytes, deliveredBytes, error }) + '\n');
  fs.fsyncSync(3);
}
function inputFailure(error) {
  if (failed) return;
  failed = true;
  const message = typeof error === 'string' ? error : [error.code, error.message].filter(Boolean).join(': ');
  recordDelivery(message);
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
child.stdin.on('error', inputFailure);
// Count only writes acknowledged by the pipe, never bytes merely queued in Node.
function deliverNext() {
  if (failed) return;
  if (deliveredBytes === payload.length) {
    child.stdin.end(() => { if (!failed) { delivered = true; recordDelivery(); } });
    return;
  }
  const end = Math.min(deliveredBytes + 64 * 1024, payload.length);
  child.stdin.write(payload.subarray(deliveredBytes, end), error => {
    if (error) { inputFailure(error); return; }
    deliveredBytes = end;
    deliverNext();
  });
}
deliverNext();
child.on('error', inputFailure);
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

export const stagedStdinDeliveryPath = (stdinPath: string) => `${stdinPath}.delivery.jsonl`;
