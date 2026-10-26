import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { stripVTControlCharacters } from 'node:util';
import { workerParentEnvironment } from '../src/lib/providers/worker-environment';
import { providerSpawnEnvironment } from '../src/lib/providers/spawn-environment';
import { withChildEnvironment } from '../src/lib/providers/child-process';

import { resolveCli } from '../src/lib/runtimes/shared/cli-resolver';
import { saveNativeWorkerToken } from '../src/lib/claude-code/worker-token';
import { extractSetupWorkerToken, workerTokenSetupNeedsBrowser } from '../src/lib/claude-code/worker-token-output';

// Run only as the operator. Never put the raw setup-token command in a managed
// terminal: it prints the credential. This wrapper retains output in memory only.
async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Mac acceptance required.');
  if (process.env.O8_WORKER_TOKEN || process.env.O8_WORKER_PACKET_ID || process.env.O8_SPECTATOR_TOKEN
    || /(?:^|[/\\])\.cortex-worktrees[/\\]packet-/.test(process.cwd())) throw new Error('Operator context required.');
  const binary = await resolveCli({ runtimeId: 'claude-code', binaryName: 'claude', envOverride: 'O8_CLAUDE_CODE_BIN' });
  const { spawn } = createRequire(import.meta.url)('node-pty') as typeof import('node-pty');
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'o8-worker-login-'));
  const env = providerSpawnEnvironment({
    ...workerParentEnvironment(process.env, undefined, false),
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    FORCE_COLOR: '0', NO_COLOR: '1',
  }, { runtimeId: 'claude-code', inject: false });
  try {
    await new Promise<void>((resolve, reject) => {
      const child = withChildEnvironment(env, [binary.path, 'setup-token'], fresh =>
        spawn(binary.path, ['setup-token'], { cwd: configDir, env: fresh, cols: 1000, rows: 40 }), false, configDir);
      let raw = '';
      let browserReported = false;
      let saving: Promise<void> | undefined;
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
        try { child.kill(); } catch { /* The CLI can exit before encrypted storage finishes. */ }
        raw = '';
        if (ok) resolve(); else reject(new Error('Worker login did not finish.'));
      };
      const cancel = () => finish(false);
      const timer = setTimeout(cancel, 10 * 60_000);
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      child.onData((chunk) => {
        if (settled) return;
        // Interactive redraws can repeat for minutes during browser approval.
        // Retain a bounded tail rather than treating those redraws as a failure.
        raw = (raw + chunk).slice(-128 * 1024);
        if (!browserReported && workerTokenSetupNeedsBrowser(raw)) {
          browserReported = true;
          console.log('Approve the dedicated worker login in your browser. No token will be printed here.');
        }
      });
      child.onExit(({ exitCode }) => {
        if (settled) return;
        const token = extractSetupWorkerToken(raw, exitCode === 0);
        if (token) saving = saveNativeWorkerToken(token);
        if (saving) void saving.then(() => finish(true), () => finish(false));
        else {
          const clean = stripVTControlCharacters(raw);
          console.error(JSON.stringify({
            event: 'setup_exit_without_capture', exitCode,
            browserReported,
            successMarker: clean.includes('Long-lived authentication token created successfully'),
            footerMarker: clean.includes('Store this token securely.'),
            tokenPrefixPresent: clean.includes('sk-ant-oat01-'),
            tokenLengths: [...clean.matchAll(/sk-ant-oat01-([A-Za-z0-9_-]+)/g)].map((match) => match[0].length),
            authError: /authentication failed|invalid code|expired|revoked/i.test(clean),
          }));
          finish(false);
        }
      });
      console.log('Starting a dedicated subscription worker login. Raw CLI output is suppressed.');
    });
    console.log('Worker token encrypted and saved. A real worker request is still required to verify authentication.');
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

void main().catch(() => {
  console.error('Dedicated worker login stopped without a success receipt. No credential details were logged.');
  process.exitCode = 1;
});
