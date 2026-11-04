import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  claudeBinary: '',
  antigravity: { installed: false, authenticated: false, detail: 'Fixture absent', fix: 'Sign in' },
  scanAndLink: vi.fn<(_: string) => string | null>(() => null),
}));

vi.mock('@/lib/runtimes/shared/antigravity-login-probe', () => ({
  probeAntigravityLogin: vi.fn(async () => h.antigravity),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      if (args[0] === h.claudeBinary) return actual.execFileSync(...args);
      throw new Error('missing cli');
    },
  };
});

vi.mock('@/lib/runtimes/shared/cli-locate', () => ({
  scanAndLink: h.scanAndLink,
}));

const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'o8-setup-claude-auth-'));
const claudeConfigDir = path.join(fixtureRoot, 'claude-config');
h.claudeBinary = path.join(fixtureRoot, 'claude');
const claudeModePath = `${h.claudeBinary}.mode`;
writeFileSync(h.claudeBinary, [
  '#!/bin/sh',
  'if [ "$1" = "--version" ]; then printf \'%s\\n\' \'Claude Code test\'; exit 0; fi',
  // Fixture-only environment names do not cross the provider allowlist (#4585).
  'case "$(cat -- "$0.mode")" in',
  '  logged_in) printf \'%s\\n\' \'{"loggedIn":true}\' ;;',
  '  logged_out) printf \'%s\\n\' \'{"loggedIn":false}\' ;;',
  '  malformed) printf \'%s\\n\' \'unexpected probe output setup-probe-secret-marker\' ;;',
  'esac',
].join('\n'));
chmodSync(h.claudeBinary, 0o755);
// A keyless install proves readiness through its own model listing, so the
// fixture CLI lists one free model and nothing else.
const opencodeBinary = path.join(fixtureRoot, 'opencode2');
writeFileSync(opencodeBinary, [
  '#!/bin/sh',
  'if [ "$1" = "models" ]; then printf \'%s\\n\' \'opencode/nemotron-3.5-lightning-free\'; fi',
  'exit 0',
].join('\n'));
chmodSync(opencodeBinary, 0o755);
const fixtureHome = path.join(fixtureRoot, 'home');
mkdirSync(fixtureHome);

beforeEach(() => {
  h.antigravity = { installed: false, authenticated: false, detail: 'Fixture absent', fix: 'Sign in' };
  h.scanAndLink.mockReset();
  h.scanAndLink.mockReturnValue(null);
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfigDir);
  writeFileSync(claudeModePath, 'logged_out');
  rmSync(claudeConfigDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('GET /api/setup/detect', () => {
  it.each([false, true])('reports account CLI readiness only after sign-in evidence: %s', async (authenticated) => {
    h.antigravity = { installed: true, authenticated, detail: 'Fixture status', fix: 'Sign in' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const { GET } = await import('./route');
    const data = await (await GET()).json();
    expect(data.tools.find((tool: { id: string }) => tool.id === 'antigravity')).toMatchObject({
      detected: true, ready: authenticated,
    });
  });

  it('reports optional CLI runtimes as gracefully absent when their CLIs are missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    vi.stubEnv('CURSOR_API_KEY', '');
    vi.stubEnv('GROK_CODE_XAI_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');

    const { GET } = await import('./route');
    const response = await GET();
    const data = await response.json() as {
      tools: Array<{ id: string; name: string; detected: boolean; ready?: boolean; authHint?: string }>;
      codexVoiceCapability?: {
        capable: boolean;
        installation: { installed: boolean };
      };
    };

    expect(response.status).toBe(200);
    expect(data.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '3code', name: '3code CLI', detected: false }),
      expect.objectContaining({ id: 'magnitude', name: 'Magnitude CLI', detected: false }),
      expect.objectContaining({ id: 'cursor', name: 'Cursor CLI', detected: false }),
      expect.objectContaining({ id: 'grok', name: 'Grok Build', detected: false }),
      expect.objectContaining({ id: 'pi', name: 'Pi', detected: false }),
    ]));
    for (const id of ['3code', 'magnitude', 'cursor', 'grok', 'pi']) {
      const tool = data.tools.find((entry) => entry.id === id);
      expect(tool?.ready).toBeUndefined();
      expect(tool?.authHint).toBeUndefined();
    }
    expect(data.codexVoiceCapability).toMatchObject({
      capable: false,
      installation: { installed: false },
    });
  });

  it('reports the installed keyless OpenCode default as composer-ready', async () => {
    h.scanAndLink.mockImplementation((binary) => (
      binary === 'opencode2' ? opencodeBinary : null
    ));
    // An empty home holds no provider credential, so only the listing can make it ready.
    vi.stubEnv('HOME', fixtureHome);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));

    const { GET } = await import('./route');
    const response = await GET();
    const data = await response.json() as {
      tools: Array<{ id: string; detected: boolean; ready?: boolean; authHint?: string }>;
    };

    expect(data.tools.find((tool) => tool.id === 'opencode')).toMatchObject({
      detected: true,
      ready: true,
    });
    expect(data.tools.find((tool) => tool.id === 'opencode')?.authHint).toBeUndefined();
  });

  it('recognizes a Keychain-only Claude session through the bounded CLI status contract', async () => {
    h.scanAndLink.mockImplementation((binary) => binary === 'claude' ? h.claudeBinary : null);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    writeFileSync(claudeModePath, 'logged_in');
    mkdirSync(path.join(claudeConfigDir, 'projects'), { recursive: true });
    writeFileSync(path.join(claudeConfigDir, 'projects', 'old-session.jsonl'), '{}');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));

    const { GET } = await import('./route');
    const response = await GET();
    const payload = await response.json() as {
      tools: Array<{ id: string; ready?: boolean; details?: Record<string, unknown> }>;
    };

    expect(payload.tools.find((tool) => tool.id === 'claude-code')).toMatchObject({
      ready: true,
      details: { authPresent: true, sessionCount: 1 },
    });
  });

  it('does not treat stale Claude transcripts or markers as auth after explicit logout', async () => {
    h.scanAndLink.mockImplementation((binary) => binary === 'claude' ? h.claudeBinary : null);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    mkdirSync(path.join(claudeConfigDir, 'projects'), { recursive: true });
    writeFileSync(path.join(claudeConfigDir, 'projects', 'stale-session.jsonl'), '{}');
    writeFileSync(path.join(claudeConfigDir, 'settings.json'), '{}');
    writeFileSync(path.join(claudeConfigDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'stale-but-shaped-token', refreshToken: '' },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));

    const { GET } = await import('./route');
    const response = await GET();
    const text = await response.text();
    const payload = JSON.parse(text) as {
      tools: Array<{ id: string; ready?: boolean; details?: Record<string, unknown> }>;
    };

    expect(payload.tools.find((tool) => tool.id === 'claude-code')).toMatchObject({
      ready: false,
      details: { authPresent: false, sessionCount: 1 },
    });
    expect(text).not.toContain('stale-but-shaped-token');
  });

  it('discards malformed Claude status output without leaking it into setup JSON', async () => {
    h.scanAndLink.mockImplementation((binary) => binary === 'claude' ? h.claudeBinary : null);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    writeFileSync(claudeModePath, 'malformed');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));

    const { GET } = await import('./route');
    const response = await GET();
    const text = await response.text();
    const payload = JSON.parse(text) as { tools: Array<{ id: string; ready?: boolean }> };

    expect(payload.tools.find((tool) => tool.id === 'claude-code')?.ready).toBe(false);
    expect(text).not.toContain('setup-probe-secret-marker');
    expect(text).not.toContain('unexpected probe output');
  });
});
