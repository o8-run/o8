import childProcess from 'node:child_process';
import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

const probeArgs = ['-nP', '-d', 'cwd', '-F', 'pcLftn'];
const outputLimit = 64 * 1024;

function errorFields(error) {
  if (!error) return null;
  return { message: String(error.message ?? error).slice(0, 8192),
    code: error.code ?? null, signal: error.signal ?? null, killed: error.killed ?? null,
    errno: error.errno ?? null, syscall: error.syscall ?? null };
}

/** Observe the actual native boundary without replacing its result or deadline. */
function install() {
  const configured = process.env.O8_TEST_NATIVE_CWD_PROBE_ROOT;
  const configuredRun = process.env.O8_TEST_RUN_DATA_ROOT;
  if (!configured || !configuredRun) return;
  const root = realpathSync(configured);
  const run = realpathSync(configuredRun);
  const identity = lstatSync(root);
  if (!identity.isDirectory() || identity.isSymbolicLink() || (identity.mode & 0o777) !== 0o700
    || path.basename(root) !== 'native-cwd-probes' || path.dirname(path.dirname(root)) !== run
    || !/^o8-test-data-run-[A-Za-z0-9]{6}$/.test(path.basename(run))) return;
  const original = childProcess.execFile;
  const originalPromise = original[promisify.custom];
  if (typeof originalPromise !== 'function') return;
  let sequence = 0;
  const matches = args => args[0] === 'lsof' && Array.isArray(args[1])
    && JSON.stringify(args[1]) === JSON.stringify(probeArgs);
  const save = record => {
    try {
      const current = lstatSync(root);
      if (!current.isDirectory() || current.isSymbolicLink() || (current.mode & 0o777) !== 0o700
        || current.dev !== identity.dev || current.ino !== identity.ino || realpathSync(root) !== root) return;
      writeFileSync(path.join(root, `lsof-${process.pid}-${record.nativePid}-${++sequence}.json`),
        JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    } catch { /* Missing receipts remain incomplete evidence; never alter the native callback. */ }
  };
  const observe = (child, args, timing, execution) => {
    try {
      let stdout = ''; let stderr = ''; let stdoutBytes = 0; let stderrBytes = 0;
      let streamError = null; let closedAt = null; let elapsedMs = null;
      let exitCode = null; let signal = null;
      const append = (value, stream) => {
        try {
          const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
          if (stream === 'stdout') {
            stdoutBytes += buffer.length; stdout += buffer.subarray(0, Math.max(0, outputLimit - Buffer.byteLength(stdout))).toString();
          } else {
            stderrBytes += buffer.length; stderr += buffer.subarray(0, Math.max(0, outputLimit - Buffer.byteLength(stderr))).toString();
          }
        } catch (error) { streamError = errorFields(error); }
      };
      child.stdout?.on('data', value => append(value, 'stdout'));
      child.stderr?.on('data', value => append(value, 'stderr'));
      child.on('error', error => { streamError = errorFields(error); });
      const closed = new Promise(resolve => child.once('close', (code, nativeSignal) => {
        exitCode = code; signal = nativeSignal; closedAt = new Date().toISOString();
        elapsedMs = performance.now() - timing.monotonic; resolve();
      }));
      const options = args[2] && typeof args[2] === 'object' ? args[2] : {};
      const record = () => ({ schema: 'o8/test-native-cwd-probe/v1', observerPid: process.pid,
        nativePid: child.pid ?? null, command: ['lsof', ...probeArgs],
        startedAt: timing.at, closedAt, elapsedMs, nativeClose: { exitCode, signal },
        options: { timeout: options.timeout ?? null, maxBuffer: options.maxBuffer ?? null,
          windowsHide: options.windowsHide ?? null, encoding: options.encoding ?? null },
        stdout, stderr, stdoutBytes, stderrBytes,
        stdoutTruncated: stdoutBytes > Buffer.byteLength(stdout), stderrTruncated: stderrBytes > Buffer.byteLength(stderr),
        streamError });
      if (execution) {
        void Promise.allSettled([execution, closed]).then(([result]) => save({ ...record(),
          receiptState: closedAt && !streamError ? 'complete' : 'incomplete',
          originalPromise: result.status, error: result.status === 'rejected' ? errorFields(result.reason) : null,
        })).catch(error => save({ ...record(), receiptState: 'incomplete', observerError: errorFields(error) }));
      } else {
        void closed.then(() => save({ ...record(), receiptState: 'incomplete',
          reason: 'Direct callback outcome not observed; actual native close only',
        })).catch(error => save({ ...record(), receiptState: 'incomplete', observerError: errorFields(error) }));
      }
    } catch (error) {
      save({ schema: 'o8/test-native-cwd-probe/v1', observerPid: process.pid, nativePid: child?.pid ?? null,
        receiptState: 'incomplete', startedAt: timing.at, observerError: errorFields(error) });
    }
  };
  const timing = () => ({ at: new Date().toISOString(), monotonic: performance.now() });
  const wrapped = function (...args) {
    const started = timing();
    const child = Reflect.apply(original, this, args);
    if (matches(args)) observe(child, args, started);
    return child;
  };
  Object.defineProperty(wrapped, promisify.custom, { value: function (...args) {
    const started = timing();
    const execution = Reflect.apply(originalPromise, this, args);
    if (matches(args)) observe(execution.child, args, started, execution);
    return execution;
  } });
  childProcess.execFile = wrapped;
  syncBuiltinESMExports();
}

try { install(); } catch { /* Absent observer evidence cannot establish a process outcome. */ }
