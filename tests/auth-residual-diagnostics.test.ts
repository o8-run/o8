import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ authError: null as Error | null }));
vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => {
    if (state.authError) throw state.authError;
    return { userId: 'synthetic-user' };
  },
}));
vi.mock('@/lib/db/users', () => ({ findOrCreateByClerk: () => ({ id: 'synthetic', plan: 'free' }) }));

const marker = 'SYNTHETIC_AUTH_SECRET_NOT_VALID';
const secretError = () => Object.assign(new Error(marker), {
  cause: { authorization: marker }, response: { ticket: marker }, stack: marker,
});

function logged(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((args) => args.map((arg) => {
    if (arg instanceof Error) return `${arg.message} ${arg.stack} ${JSON.stringify(arg)}`;
    return typeof arg === 'string' ? arg : JSON.stringify(arg);
  }).join(' ')).join('\n');
}

afterEach(() => {
  state.authError = null;
  vi.restoreAllMocks();
});

describe('residual auth diagnostics', () => {
  it('clerk-provision reports a failure without the SDK error contents', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.authError = secretError();
    const { POST } = await import('@/app/api/panel/auth/clerk-provision/route');

    const response = await POST(new Request('http://127.0.0.1/api/panel/auth/clerk-provision', { method: 'POST' }));

    await expect(response.json()).resolves.toEqual({ ok: false, reason: 'error' });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(logged(errors)).not.toContain(marker);
  });

  it('account settings failures log fixed text for sync and async SDK errors', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { openAccountSettings } = await import('@/lib/auth/open-account-settings');

    openAccountSettings({ openUserProfile: () => { throw secretError(); } });
    openAccountSettings({ openUserProfile: () => Promise.reject(secretError()) });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toHaveBeenCalledTimes(2);
    expect(logged(errors)).not.toContain(marker);
    expect(errors.mock.calls.every((args) => args.length === 1
      && args[0] === '[auth] failed to open account settings')).toBe(true);
  });

  it('native console capture redacts token-shaped values from every captured source', () => {
    const hookSource = readFileSync('src-tauri/src/webview_latch.rs', 'utf8')
      .match(/const CONSOLE_ERROR_HOOK_JS: &str = r#"([\s\S]*?)"#;/)![1];
    const captured: Array<{ message: string; source: string }> = [];
    const listeners: Record<string, (event: unknown) => void> = {};
    const window = {
      __TAURI_INTERNALS__: { invoke: (_cmd: string, payload: { message: string; source: string }) => {
        captured.push(payload);
        return Promise.resolve();
      } },
      addEventListener: (name: string, handler: (event: unknown) => void) => { listeners[name] = handler; },
    };
    const context = vm.createContext({ window, console: { error: () => {} }, JSON, String, Error, isFinite, Math });
    vm.runInContext(hookSource, context);

    const jwt = `eyJ${marker}.eyJ${marker}.${marker}`;
    const url = `https://clerk.o8.run/v1/client?__clerk_ticket=${marker}&__clerk_db_jwt=${marker}&x=1`;
    const consoleError = (context.console as { error: (...args: unknown[]) => void }).error;
    consoleError('Clerk load failed', Object.assign(new Error(`token ${jwt}`), { stack: `Error: ${url}` }));
    consoleError(`Authorization: Bearer ${marker} device o8d_${marker}`);
    listeners.error({ message: `uncaught ${jwt}`, filename: url, lineno: 3 });
    listeners.unhandledrejection({ reason: { ticket: jwt, header: `Bearer ${marker}` } });

    expect(captured).toHaveLength(4);
    for (const payload of captured) {
      expect(`${payload.message} ${payload.source}`).not.toContain(marker);
    }
    expect(captured[0].message).toContain('[redacted]');
  });

  it('native capture and telemetry scrubbing redact the same encoded and nested forms', async () => {
    const hookSource = readFileSync('src-tauri/src/webview_latch.rs', 'utf8')
      .match(/const CONSOLE_ERROR_HOOK_JS: &str = r#"([\s\S]*?)"#;/)![1];
    const captured: string[] = [];
    const window = {
      __TAURI_INTERNALS__: { invoke: (_cmd: string, payload: { message: string; source: string }) => {
        captured.push(payload.message);
        return Promise.resolve();
      } },
      addEventListener: () => {},
    };
    const context = vm.createContext({ window, console: { error: () => {} }, JSON, String, Error, isFinite, Math, parseInt });
    vm.runInContext(hookSource, context);
    const consoleError = (context.console as { error: (...args: unknown[]) => void }).error;
    const { redactSecrets } = await import('@/lib/telemetry/scrub');

    const samples = [
      `callback o8://auth?%74icket=${marker}&next=1`,
      `nested https://o8.run/cb?next=%2Fdone%3Fticket%3D${marker}`,
      `double %253Fticket%253D${marker}`,
      `jwt eyJ${marker}%2EeyJ${marker}%2E${marker}`,
      JSON.stringify({ sessionToken: marker, session_token: marker, apiKey: marker }),
      JSON.stringify({ response: JSON.stringify({ ticket: marker, nested: { token: marker } }) }),
      JSON.stringify({ outer: JSON.stringify({ response: JSON.stringify({ ticket: marker }) }) }),
      `headers authorization: Bearer ${marker}; cookie=__session=${marker}`,
      `device o8d_${marker} key sk_live_${marker.replace(/_/g, '')} code ?code=${marker}`,
    ];
    for (const sample of samples) {
      consoleError(sample);
      const scrubbed = redactSecrets(sample);
      expect(scrubbed, sample).not.toContain(marker);
      expect(scrubbed, sample).not.toContain(marker.replace(/_/g, ''));
    }
    expect(captured).toHaveLength(samples.length);
    captured.forEach((text, index) => {
      expect(text, samples[index]).not.toContain(marker);
      expect(text, samples[index]).toBe(redactSecrets(samples[index]));
    });
  });

  it('crash records redact credentials before they are persisted', async () => {
    const { buildCrashRecord } = await import('@/lib/telemetry/crash-store');
    const record = buildCrashRecord({
      source: 'webview', kind: 'window.error', appVersion: 'test',
      message: `load failed ?__clerk_ticket=${marker}`,
      stack: `Error: token eyJ${marker}.eyJ${marker}.${marker}\n    at Bearer ${marker}`,
    });
    expect(JSON.stringify(record)).not.toContain(marker);
  });

  it('crash records read for triage or feedback are redacted, including rows written raw', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'o8-crash-redact-'));
    vi.stubEnv('O8_DATA_DIR', dataDir);
    vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
    try {
      mkdirSync(join(dataDir, 'telemetry'), { recursive: true });
      writeFileSync(join(dataDir, 'telemetry', 'crashes.jsonl'), `${JSON.stringify({
        ts: 1, source: 'boot', appVersion: 'test', kind: 'uncaughtException',
        message: `boot failed Bearer ${marker}`, stack: `Error: eyJ${marker}.eyJ${marker}.${marker}`,
      })}\n`);
      vi.resetModules();
      const { readCrashRecords } = await import('@/lib/telemetry/crash-store');
      const rows = readCrashRecords();
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(marker);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('account settings opens normally without diagnostics', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const open = vi.fn();
    const { openAccountSettings } = await import('@/lib/auth/open-account-settings');

    openAccountSettings({ openUserProfile: open });

    expect(open).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
  });
});
