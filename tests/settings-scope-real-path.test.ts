import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parse } from 'smol-toml';
import { afterAll, beforeAll, expect, it } from 'vitest';

// Scoped settings through the real operator-defaults route of the settings host.
let host: ChildProcess;
let origin = '';
let configDir = '';
const headers = { authorization: 'Bearer fixture-settings-scope-operator', 'Content-Type': 'application/json' };
beforeAll(async () => {
  host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx',
    'scripts/next/dev-server.ts', '--settings', '--shell'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: 'fixture-settings-scope-operator' }, stdio: ['ignore', 'pipe', 'ignore'],
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
}, 60_000);
afterAll(async () => {
  if (host?.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); }
});
/** Reads a nested TOML path without `any`. */
const at = (document: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], document);
const call = (path: string, method = 'GET', body?: unknown) => fetch(origin + path, {
  method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const read = async (project?: string) => {
  const response = await call(`/api/panel/operator-defaults?include=native${project ? `&project=${encodeURIComponent(project)}` : ''}`);
  expect(response.status).toBe(200);
  return response.json();
};
const write = async (query: string, body: Record<string, unknown>) => {
  const { settingsToml } = await read();
  return call(`/api/panel/operator-defaults?include=native&${query}`, 'POST', { ...body, settingsTomlRevision: settingsToml.revision });
};

it('reads a flat settings file as the global layer and keeps it there on the first scoped write', async () => {
  writeFileSync(join(configDir, 'settings.toml'), '[operator]\nparallel_cap = 4\n\n[git]\nbranch_prefix = "flat-global"\n');
  const flat = await read('project-a');
  expect(flat.scope).toMatchObject({
    projectId: 'project-a',
    layers: { global: { parallelCap: 4, branchPrefix: 'flat-global' }, project: {}, machine: {} },
  });
  expect(flat.values).toMatchObject({ parallelCap: 4, branchPrefix: 'flat-global' });
  expect(flat.scope.keys).toContain('parallelCap');
  expect(flat.scope.keys).not.toContain('knowledgeSources');

  expect((await write('scope=project&project=project-a', { parallelCap: 6 })).status).toBe(200);
  const file = parse(readFileSync(join(configDir, 'settings.toml'), 'utf8'));
  expect(at(file, 'operator', 'parallel_cap')).toBe(4);
  expect(at(file, 'git', 'branch_prefix')).toBe('flat-global');
  expect(at(file, 'scope', 'version')).toBe(1);
  expect(at(file, 'scope', 'project', 'project-a', 'operator', 'parallel_cap')).toBe(6);
});

it('round-trips each layer, resolves machine over project over global, re-resolves on a project switch and falls through on clear', async () => {
  writeFileSync(join(configDir, 'settings.toml'), '[operator]\nparallel_cap = 4\n');
  expect((await write('scope=project&project=project-a', { parallelCap: 6 })).status).toBe(200);
  let a = await read('project-a');
  expect(a.values.parallelCap).toBe(6);
  expect(a.scope.layers.project).toEqual({ parallelCap: 6 });
  // Another project, or none, resolves without project A's layer.
  expect((await read('project-b')).values.parallelCap).toBe(4);
  expect((await read()).values.parallelCap).toBe(4);

  expect((await write('scope=machine', { parallelCap: 9 })).status).toBe(200);
  a = await read('project-a');
  expect(a.values.parallelCap).toBe(9);
  expect(a.scope.layers.machine).toEqual({ parallelCap: 9 });
  expect((await read('project-b')).values.parallelCap).toBe(9);
  // The machine layer is this server's, so every reader on it uses the value.
  expect((await (await call('/api/panel/operator-defaults?include=values')).json()).values.parallelCap).toBe(9);

  // Global writes keep their route and do not disturb the layers above them.
  expect((await write('', { parallelCap: 5 })).status).toBe(200);
  a = await read('project-a');
  expect(a.scope.layers).toMatchObject({ global: { parallelCap: 5 }, project: { parallelCap: 6 }, machine: { parallelCap: 9 } });

  expect((await write('scope=machine', { parallelCap: null })).status).toBe(200);
  expect((await read('project-a')).values.parallelCap).toBe(6);
  expect((await write('scope=project&project=project-a', { parallelCap: null })).status).toBe(200);
  a = await read('project-a');
  expect(a.values.parallelCap).toBe(5);
  expect(a.scope.layers).toMatchObject({ project: {}, machine: {} });
  const file = parse(readFileSync(join(configDir, 'settings.toml'), 'utf8'));
  expect(at(file, 'scope', 'project')).toBeUndefined();
  expect(at(file, 'scope', 'machine')).toBeUndefined();
});

it('refuses invalid, global-only, multi-key and stale scoped writes without changing the file', async () => {
  writeFileSync(join(configDir, 'settings.toml'), '[operator]\nparallel_cap = 4\n');
  const before = readFileSync(join(configDir, 'settings.toml'), 'utf8');
  expect((await write('scope=project&project=project-a', { parallelCap: 0 })).status).toBe(400);
  expect((await write('scope=machine', { knowledgeSources: [] })).status).toBe(400);
  expect((await write('scope=machine', { parallelCap: 3, branchPrefix: 'x' })).status).toBe(400);
  expect((await write('scope=project', { parallelCap: 3 })).status).toBe(400);
  const stale = await call('/api/panel/operator-defaults?include=native&scope=machine', 'POST', { parallelCap: 3, settingsTomlRevision: 'stale' });
  expect(stale.status).toBe(409);
  expect(readFileSync(join(configDir, 'settings.toml'), 'utf8')).toBe(before);
});

it('refuses a scoped routing value that would break the routing it resolves into', async () => {
  writeFileSync(join(configDir, 'settings.toml'), '[models]\ndefault_dispatch_runtime = "claude-code"\ndefault_dispatch_model = ""\n');
  const before = readFileSync(join(configDir, 'settings.toml'), 'utf8');
  // The carrier only runs codex; a global write refuses this pair as well.
  expect((await write('scope=machine', { workerExecutionCarrier: 'ori' })).status).toBe(400);
  expect((await write('scope=project&project=project-a', { workerExecutionCarrier: 'ori' })).status).toBe(400);
  expect(readFileSync(join(configDir, 'settings.toml'), 'utf8')).toBe(before);
  // Pinned to codex in the same layer, the carrier is accepted.
  expect((await write('scope=machine', { defaultDispatchRuntime: 'codex' })).status).toBe(200);
  expect((await write('scope=machine', { workerExecutionCarrier: 'ori' })).status).toBe(200);
});

it('keeps global settings when another layer is invalid and refuses prototype ids', async () => {
  writeFileSync(join(configDir, 'settings.toml'),
    '[operator]\nparallel_cap = 4\n\n[scope.project.other.operator]\nparallel_cap = "x"\n\n[scope.machine.elsewhere.operator]\nparallel_cap = "x"\n');
  expect((await (await call('/api/panel/operator-defaults?include=values')).json()).values.parallelCap).toBe(4);
  const other = await read('other');
  expect(other.values.parallelCap).toBe(4);
  expect(other.scope.layers.project).toEqual({});
  expect((await write('scope=project&project=__proto__', { parallelCap: 3 })).status).toBe(400);
  expect((await write('scope=project&project=constructor', { parallelCap: 3 })).status).toBe(400);
  expect((await read('constructor')).scope.projectId).toBeNull();
});
