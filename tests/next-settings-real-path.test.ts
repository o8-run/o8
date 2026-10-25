import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';

let host: ChildProcess;
let origin = '';
let configDir = '';
const headers = { authorization: 'Bearer fixture-next-settings-operator', 'Content-Type': 'application/json' };
beforeAll(async () => {
  host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--settings', '--shell'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: 'fixture-next-settings-operator' }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const lines = createInterface({ input: host.stdout! });
  for await (const line of lines) {
    try {
      const value = JSON.parse(line) as { origin?: string; configDir?: string };
      origin = value.origin || origin;
      configDir = value.configDir || configDir;
    } catch { continue; }
    if (origin && configDir) { lines.close(); break; }
  }
  configDir = realpathSync(configDir);
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
}, 60_000);
afterAll(async () => {
  if (host?.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); }
});
const call = (path: string, method = 'GET', body?: unknown, authorization = headers.authorization) => fetch(origin + path, {
  method, headers: { ...headers, authorization }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

it('uses operator auth for both existing routes and rejects worker or missing authority before persistence', async () => {
  for (const authorization of ['', 'Bearer fixture-invalid-worker']) {
    for (const [path, method, body] of [
      ['/api/panel/operator-defaults?include=values', 'GET', undefined],
      ['/api/panel/operator-defaults?include=native', 'GET', undefined],
      ['/api/panel/operator-defaults?include=presentation', 'GET', undefined],
      ['/api/panel/operator-defaults?include=native', 'POST', { branchPrefix: 'unauthorized' }],
      ['/api/panel/operator-defaults', 'POST', { branchPrefix: 'unauthorized' }],
      ['/api/v2/keys', 'GET', undefined],
      ['/api/v2/keys', 'POST', { provider: 'openai', key: 'fixture-unauthorized' }],
      ['/api/v2/keys', 'DELETE', { provider: 'openai' }],
      ['/api/v2/keys', 'PATCH', { provider: 'openai', enabled: false }],
    ] as const) expect((await call(path, method, body, authorization)).status).toBe(401);
  }
  expect((await (await call('/api/panel/operator-defaults?include=values')).json()).values.branchPrefix).not.toBe('unauthorized');
});

it('shares persisted field writes with desktop and preserves validation, environment overrides and TOML conflicts', async () => {
  const response = await call('/api/panel/operator-defaults', 'POST', { parallelCap: 8, branchPrefix: 'fixture-next' });
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data).toMatchObject({ values: { parallelCap: 8, branchPrefix: 'fixture-next', healBotEnabled: false }, sources: { healBotEnabled: 'env' } });
  const toml = readFileSync(join(configDir, 'settings.toml'), 'utf8');
  expect(toml).toContain('fixture-next');
  const invalid = await call('/api/panel/operator-defaults', 'POST', { parallelCap: 0 });
  expect(invalid.status).toBe(400);
  expect(readFileSync(join(configDir, 'settings.toml'), 'utf8')).toBe(toml);
  // Desktop-shaped second client, then a native-shaped read of the same route.
  expect((await call('/api/panel/operator-defaults', 'POST', { branchPrefix: 'fixture-desktop' })).status).toBe(200);
  const readback = await (await call('/api/panel/operator-defaults?include=values')).json();
  expect(readback.values).toMatchObject({ branchPrefix: 'fixture-desktop', parallelCap: 8 });
  const conflict = await call('/api/panel/operator-defaults', 'POST', {
    settingsToml: data.settingsToml.text, settingsTomlRevision: data.settingsToml.revision,
  });
  expect(conflict.status).toBe(409);
  expect((await (await call('/api/panel/operator-defaults?include=values')).json()).values.branchPrefix).toBe('fixture-desktop');
});

it('persists encrypted fixture keys, reports presence, and uses the existing enable/check/removal refusals', async () => {
  for (const provider of ['openrouter', 'deepseek', 'anthropic', 'openai']) {
    expect((await call('/api/v2/keys', 'POST', { provider, key: 'fixture-refused-key' })).status).toBe(400);
    expect((await call('/api/v2/keys', 'POST', { provider, key: 'fixture-new-key-value' })).status).toBe(200);
    const stored = readFileSync(join(configDir, '.env.local'), 'utf8');
    expect(stored).toContain('=enc:');
    expect(stored).not.toContain('fixture-new-key-value');
    const inventory = await (await call('/api/v2/keys')).json();
    expect(inventory.providers.find((p: { id: string }) => p.id === provider).configured).toBe(true);
    expect(JSON.stringify(inventory)).not.toContain('fixture-new-key-value');
    expect((await call('/api/v2/keys', 'PATCH', { provider, enabled: false })).status).toBe(200);
    if (provider === 'openrouter') expect((await call('/api/v2/keys', 'PATCH', { provider, check: true })).status).toBe(409);
    expect((await call('/api/v2/keys', 'PATCH', { provider, enabled: true })).status).toBe(200);
    if (provider === 'openrouter') expect((await call('/api/v2/keys', 'PATCH', { provider, check: true })).status).toBe(200);
    expect((await call('/api/v2/keys', 'DELETE', { provider })).status).toBe(200);
    const removed = await (await call('/api/v2/keys')).json();
    expect(removed.providers.find((p: { id: string }) => p.id === provider).configured).toBe(false);
  }
});

it('projects native TOML at the server boundary and preserves hidden credentials across both kinds of saves', async () => {
  const previous = await (await call('/api/panel/operator-defaults?include=values')).json();
  const canary = ['fixture-private', 'canary-value'].join('-');
  const raw = `[operator]\nparallel_cap = 3\n# ${canary}\n[accepted_table]\ntoken = "${canary}"\n[targeting.triage]\nruntime = "codex"\nmodel = ""\neffort = "medium"\ntoken = "${canary}"\n`;
  expect((await call('/api/panel/operator-defaults', 'POST', { settingsToml: raw, settingsTomlRevision: previous.settingsToml.revision })).status).toBe(200);
  const native = await (await call('/api/panel/operator-defaults?include=native')).json();
  expect(JSON.stringify(native).includes(canary)).toBe(false);
  expect(native.settingsToml.additionalSettingsSet).toBe(true);
  expect(native.settingsToml.text).toContain('parallel_cap = 3');
  expect(native.values.targetingTriage).toEqual({ runtime: 'codex', model: '', effort: 'medium' });
  const saved = await call('/api/panel/operator-defaults?include=native', 'POST', {
    parallelCap: 5, settingsTomlRevision: native.settingsToml.revision,
  });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ ok: true });
  const refreshed = await (await call('/api/panel/operator-defaults?include=native')).json();
  expect(JSON.stringify(refreshed).includes(canary)).toBe(false);
  const replaced = await call('/api/panel/operator-defaults?include=native', 'POST', {
    settingsToml: '[operator]\nparallel_cap = 6\n', settingsTomlRevision: refreshed.settingsToml.revision,
  });
  expect(replaced.status).toBe(200);
  expect(await replaced.json()).toEqual({ ok: true });
  const ordinary = await (await call('/api/panel/operator-defaults?include=values')).json();
  expect(ordinary.values.parallelCap).toBe(6);
  expect(ordinary.settingsToml.text.includes(canary)).toBe(true);
  const refused = await call('/api/panel/operator-defaults?include=native', 'POST', {
    settingsToml: raw, settingsTomlRevision: ordinary.settingsToml.revision,
  });
  expect(refused.status).toBe(400);
  expect((await refused.text()).includes(canary)).toBe(false);
  const presentation = await (await call('/api/panel/operator-defaults?include=presentation')).json();
  expect(Object.keys(presentation.values).sort()).toEqual(['notificationsReviewReady', 'presentationQuietMode']);
  expect(JSON.stringify(presentation).includes(canary)).toBe(false);
});

it('serializes competing native field saves at their original revision instead of retrying over a newer setting', async () => {
  const before = await (await call('/api/panel/operator-defaults?include=native')).json();
  const responses = await Promise.all(['native-first', 'native-second'].map(branchPrefix => call(
    '/api/panel/operator-defaults?include=native', 'POST', { branchPrefix, settingsTomlRevision: before.settingsToml.revision },
  )));
  expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
  const after = await (await call('/api/panel/operator-defaults?include=native')).json();
  const winner = responses[0].status === 200 ? 'native-first' : 'native-second';
  expect(after.values.branchPrefix).toBe(winner);
  expect(readFileSync(join(configDir, 'settings.toml'), 'utf8')).toContain(`branch_prefix = "${winner}"`);
  const missingRevision = await call('/api/panel/operator-defaults?include=native', 'POST', { branchPrefix: 'unguarded' });
  expect(missingRevision.status).toBe(400);
  expect((await (await call('/api/panel/operator-defaults?include=native')).json()).values.branchPrefix).toBe(winner);
});
