import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it, vi } from 'vitest';

// Stop at server readiness so installed CLI checks cannot execute a provider turn.
vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>(),
  ensureDispatchBackendReady: vi.fn(async () => { throw new Error('Fixture reached the pre-spawn dispatch boundary.'); }),
}));

const execFileAsync = promisify(execFile);
const dataDir = mkdtempSync(join(tmpdir(), 'o8-runtime-carrier-conformance-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const capabilities = await import('@/lib/orchestrator/runtime-capabilities');
const auth = await import('@/lib/runtimes/shared/auth-detect');
const opencode = await import('@/lib/runtimes/shared/opencode-readiness');
const { cliInvocation } = await import('@/lib/runtimes/shared/cli-spawn');
const runtimes = await import('@/lib/runtimes');

const registered = capabilities.listDispatchableRuntimes();

function fail(runtime: string, contractLine: string, message: string): never {
  throw new Error(`[${runtime}] ${contractLine}: ${message}`);
}

function requireContract(
  runtime: string,
  contractLine: string,
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) fail(runtime, contractLine, message);
}

function parseVersion(output: string): string | null {
  const normalized = output.replace(/\u001b\[[0-9;]*m/g, ' ').trim();
  return normalized.match(/\bv?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
}

async function realVersion(binaryPath: string) {
  const invocation = cliInvocation(binaryPath, ['--version']);
  try {
    const { stdout, stderr } = await execFileAsync(invocation.command, invocation.args, {
      windowsHide: true,
      timeout: 8_000,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      maxBuffer: 256 * 1024,
    });
    return { ok: true as const, output: `${stdout}\n${stderr}` };
  } catch (error) {
    const failure = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      ok: false as const,
      output: `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
      error: failure,
    };
  }
}

afterAll(async () => {
  await import('@/lib/db').then(({ closeDb }) => closeDb()).catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
});

describe('registered runtime carrier conformance', () => {
  it('is generated from the canonical dispatch registry, not a second runtime list', () => {
    expect(registered).toEqual(capabilities.ORCHESTRATOR_RUNTIME_IDS.filter(
      (id) => capabilities.ORCHESTRATOR_RUNTIMES[id].dispatchable,
    ));
    expect(new Set(registered).size).toBe(registered.length);
  });

  for (const runtime of registered) {
    const capability = capabilities.getRuntimeCapability(runtime);

    it(`${runtime}: install → version → auth evidence → dispatch entry`, async (context) => {
      auth.invalidateRuntimeAuthCache();
      const status = await auth.detectRuntimeAuthStatus(runtime);

      if (!status.installed) {
        console.log(
          `[runtime-carrier-conformance] SKIP runtime=${runtime} binary=${capability.binaryName} `
          + `reason=not installed (${status.detail})`,
        );
        context.skip();
        return;
      }

      const binaryPath = status.binaryPath;
      requireContract(
        runtime,
        'install-detection',
        typeof binaryPath === 'string' && binaryPath.length > 0,
        `installed=true must include the resolved ${capability.binaryName} path`,
      );

      const version = await realVersion(binaryPath);
      requireContract(
        runtime,
        'version-command',
        version.ok,
        `${capability.binaryName} --version exited unsuccessfully: ${version.output.trim() || version.error?.message}`,
      );
      const parsedVersion = parseVersion(version.output);
      requireContract(
        runtime,
        'version-parse',
        parsedVersion,
        `could not parse a dotted numeric version from ${JSON.stringify(version.output.trim().slice(0, 240))}`,
      );

      requireContract(runtime, 'auth-evidence', typeof status.authenticated === 'boolean',
        'authenticated evidence must resolve to an explicit boolean');
      requireContract(runtime, 'auth-readiness', typeof status.ready === 'boolean',
        'readiness must resolve to an explicit boolean');
      requireContract(runtime, 'auth-detail', status.detail.trim().length > 0,
        'readiness must explain the evidence used');
      requireContract(runtime, 'auth-fix', status.fix.trim().length > 0,
        'readiness must provide an actionable next step or no-op');

      // #2194: a successful OpenCode auth listing may be empty even when the
      // server-side account can dispatch. Empty is indeterminate, never proof of
      // disconnection; a resolvable model is stronger positive evidence.
      if (runtime === 'opencode' && status.unavailableReason !== 'needs_restart') {
        const [providers, models] = await Promise.all([
          opencode.opencodeAuthenticatedProviders(homedir(), binaryPath),
          opencode.opencodeCliModels(binaryPath),
        ]);
        if (providers.size === 0 && models && models.size > 0) {
          requireContract(runtime, 'auth-empty-success-indeterminate', status.ready,
            'empty auth evidence plus a non-empty real model listing must not resolve disconnected');
        }
      }

      const adapter = runtimes.getRuntime(runtime);
      requireContract(runtime, 'adapter-registration', adapter,
        'dispatchable registry entry has no registered runtime adapter');
      requireContract(runtime, 'adapter-launch-capability', adapter.capabilities.launch,
        'dispatchable registry entry does not advertise launch');

      const model = capability.defaultModel ?? null;
      let preflightReady = false;
      try {
        await auth.assertRuntimeDispatchable(runtime, model);
        preflightReady = true;
      } catch (error) {
        requireContract(
          runtime,
          'dispatch-preflight-refusal',
          error instanceof auth.DispatchPreflightError,
          `real dispatch preflight failed outside the readiness contract: ${String(error)}`,
        );
        requireContract(
          runtime,
          'dispatch-preflight-refusal',
          !status.ready || error.status.unavailableReason === 'incompatible_model',
          `readiness said ready but real dispatch preflight refused: ${error.status.detail}`,
        );
      }

      if (!preflightReady) return;

      // Reach the actual adapter launch entry point and stop at its readiness
      // boundary before a worker can execute or contact a provider.
      const impossibleCwd = join(dataDir, 'does-not-exist', runtime);
      const launch = await adapter.launch({
        cwd: impossibleCwd,
        prompt: 'o8 runtime carrier conformance dry-run: do not contact a provider',
        ...(runtime === 'claude-code' ? { claudeCodeCarrier: 'native' as const } : {}),
        ...(model ? { model } : {}),
      }).catch((error: Error) => ({ ok: false, note: error.message, sideEffect: 'none' as const }));
      requireContract(runtime, 'dispatch-adapter-entry', launch.ok === false,
        'adapter unexpectedly accepted an impossible cwd during the pre-effect smoke');
      const nativeCredentialRefusal = runtime === 'claude-code' && launch.sideEffect === 'none'
        && launch.note.startsWith('worker_not_authenticated:');
      // Built-in Pi resolves its cwd before it creates a session, so it refuses earlier than the readiness boundary.
      const piSessions = process.env.O8_OWNED_PI_BUILTIN_ROOT || join(dataDir, 'owned-pi-builtin');
      const piCwdRefusal = runtime === 'pi-builtin' && launch.sideEffect === 'none' && launch.note.includes(impossibleCwd)
        && (!existsSync(piSessions) || readdirSync(piSessions).length === 0);
      requireContract(runtime, 'dispatch-adapter-pre-effect', nativeCredentialRefusal || piCwdRefusal
        || launch.note.includes('Fixture reached the pre-spawn dispatch boundary.'),
        `impossible-cwd smoke could not prove it stayed pre-effect: ${launch.note}`);
    }, 30_000);
  }
});
