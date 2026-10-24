/** Settings peer: production routes, disposable stores, synthetic provider transport. */
import childProcess from 'node:child_process';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { NextRequest } from 'next/server';

type Route = (request: NextRequest) => Promise<Response>;

export async function settingsFixture(root: string) {
  const profile = join(root, 'settings-profile');
  mkdirSync(profile);
  // Runtime detection must never inspect a developer's sign-ins or execute a
  // locally installed tool on macOS. Only this disposable child is affected.
  mock.method(os, 'homedir', () => profile);
  const originalExecFileSync = childProcess.execFileSync;
  mock.method(childProcess, 'execFileSync', (file: string, args?: readonly string[]) => {
    // The shell peer creates a second owned repository after isolation. No
    // detected runtime, account tool or arbitrary command is admitted.
    if (file === 'git' && args?.[0] === 'init' && args.at(-1)?.startsWith(root + sep)) return originalExecFileSync(file, args);
    throw new Error('Fixture has no installed runtimes');
  });
  mock.method(childProcess, 'execSync', () => { throw new Error('Fixture has no installed runtimes'); });
  mock.method(childProcess, 'spawn', () => { throw new Error('Fixture does not launch runtimes'); });
  mock.method(childProcess, 'execFile', (...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback === 'function') queueMicrotask(() => callback(new Error('Fixture has no installed runtimes'), '', ''));
    return { on() { return this; }, kill() {} };
  });
  syncBuiltinESMExports();
  for (const key of Object.keys(process.env)) {
    if (key.endsWith('_API_KEY') || key.startsWith('O8_') && !['O8_DATA_DIR', 'O8_OWNED_OPENCODE_ROOT', 'O8_NEXT_API_TOKEN', 'O8_NEXT_REQUEST_LOG', 'O8_NEXT_SETTINGS_DIAGNOSTICS'].includes(key)) delete process.env[key];
  }
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HERMES_HOME', 'PI_CODING_AGENT_DIR', 'PI_AGENT_DIR',
    'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'CURSOR_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'ANTHROPIC_AUTH_TOKEN', 'GOOGLE_APPLICATION_CREDENTIALS']) delete process.env[key];
  process.env.O8_MASTER_KEY = randomBytes(32).toString('base64url');
  // One deliberate environment lock; all other defaults come from owned files.
  process.env.O8_HEAL_BOT_ENABLED = '0';
  let desktopOrigin = '';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (desktopOrigin && url.startsWith('/api/panel/operator-defaults')) return originalFetch(desktopOrigin + url, {
      ...init, headers: { authorization: `Bearer ${process.env.O8_NEXT_API_TOKEN}` },
    });
    if (url.startsWith('https://openrouter.ai/') || url.startsWith('https://api.anthropic.com/')
      || url.startsWith('https://api.openai.com/') || url.startsWith('https://api.deepseek.com/')) {
      const headers = new Headers(init?.headers);
      const refused = [...headers.values()].some(value => value.includes('fixture-refused'));
      return Response.json({ data: { usage: 1, limit: 10, limit_remaining: 9 } }, { status: refused ? 401 : 200 });
    }
    if (url.startsWith(process.env.CORTEX_REALTIME_INTERNAL_ORIGIN + '/')) return originalFetch(input, init);
    throw new Error('Fixture refuses external network access');
  };
  const defaults = await import('../../src/app/api/panel/operator-defaults/route');
  const keys = await import('../../src/app/api/v2/keys/route');
  const routes: Record<string, Route> = {
    'GET /api/panel/operator-defaults': defaults.GET,
    'POST /api/panel/operator-defaults': defaults.POST,
    'GET /api/v2/keys': keys.GET, 'POST /api/v2/keys': keys.POST,
    'DELETE /api/v2/keys': keys.DELETE, 'PATCH /api/v2/keys': keys.PATCH,
  };
  let presentation: ((transientQuiet?: boolean) => Promise<{ quiet: boolean; notifications: boolean }>) | undefined;
  let nextStatus = 0;
  let delayMs = 0;
  let emptyKeys = false;
  let loseResponse = false;
  return {
    routes,
    control: async (request: NextRequest) => {
      const { requirePanelAuth } = await import('../../src/lib/panel/auth');
      const denied = requirePanelAuth(request);
      if (denied) return denied;
      const body = await request.json() as { nextStatus?: number; delayMs?: number; emptyKeys?: boolean; loseResponse?: boolean; healLocked?: boolean; presentation?: boolean; transientQuiet?: boolean };
      if (body.presentation) {
        desktopOrigin = new URL(request.url).origin;
        presentation ??= (await import('./settings-presentation-fixture')).presentationFixture();
        return Response.json({ presentation: await presentation(body.transientQuiet) });
      }
      nextStatus = body.nextStatus ?? 0; delayMs = body.delayMs ?? 0;
      emptyKeys = body.emptyKeys ?? false; loseResponse = body.loseResponse ?? false;
      if (body.healLocked === false) delete process.env.O8_HEAL_BOT_ENABLED;
      if (body.healLocked === true) process.env.O8_HEAL_BOT_ENABLED = '0';
      return Response.json({ ok: true });
    },
    run: async (route: Route, request: NextRequest) => {
      const start = performance.now();
      const label = `${request.method} ${new URL(request.url).pathname}`;
      if (process.env.O8_NEXT_SETTINGS_DIAGNOSTICS) console.error(`[settings-fixture] ${label} start`);
      if (delayMs) await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, 1000)));
      if (nextStatus) {
        const status = nextStatus; nextStatus = 0;
        return Response.json({ error: 'Fixture settings unavailable' }, { status });
      }
      if (emptyKeys && request.method === 'GET' && new URL(request.url).pathname === '/api/v2/keys') return Response.json({ providers: [] });
      const response = await route(request);
      if (process.env.O8_NEXT_SETTINGS_DIAGNOSTICS) console.error(`[settings-fixture] ${label} ${response.status} ${Math.round(performance.now() - start)}ms`);
      return response;
    },
    dropResponse: () => {
      const drop = loseResponse; loseResponse = false; return drop;
    },
  };
}
