import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { parseOperatorDefaultsToml, serializeOperatorDefaultsToml } from '@/lib/settings/toml';
import fixture from './fixtures/settings-explicit-intent.json';

let host: ChildProcess, origin = '', directory = '', stderr = '';
const path = '/api/panel/operator-defaults?include=native';
const headers = { authorization: 'Bearer fixture-explicit-settings', 'content-type': 'application/json' };
beforeAll(async () => {
  host = spawn(process.execPath, ['--import', './scripts/register-server-only-stub.mjs', '--import', 'tsx', 'scripts/next/dev-server.ts', '--settings', '--shell'], {
    env: { ...process.env, O8_NEXT_API_TOKEN: 'fixture-explicit-settings', O8_THINKING_EFFORT: '', O8_CODEX_WORKER_EFFORT: '', O8_CLAUDE_WORKER_EFFORT: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  host.stderr!.on('data', chunk => stderr += chunk);
  const lines = createInterface({ input: host.stdout! });
  for await (const line of lines) {
    try { const value = JSON.parse(line); origin = value.origin || origin; directory = value.configDir || directory; } catch { continue; }
    if (origin && directory) { lines.close(); break; }
  }
  expect(Boolean(origin && directory), stderr).toBe(true);
  directory = realpathSync(directory);
}, 120_000);
beforeEach(() => { for (const name of ['settings.toml', 'operator-defaults.json']) rmSync(join(directory, name), { force: true }); });
afterAll(async () => { if (host?.exitCode === null) { host.kill('SIGTERM'); await once(host, 'exit'); } });
const read = async () => {
  const response = await fetch(origin + path, { headers });
  expect(response.status).toBe(200);
  return response.json();
};
const post = (body: Record<string, unknown>) => fetch(origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
it.each(['fresh', 'legacy-high', 'legacy-max', 'toml-high', 'toml-max'] as const)(
  'saves displayed native editor text as stored intent for a %s profile', async profile => {
    const explicit = profile === 'fresh' ? undefined : profile.endsWith('high') ? 'high' : 'max';
    expect(existsSync(join(directory, 'settings.toml'))).toBe(false);
    expect(existsSync(join(directory, 'operator-defaults.json'))).toBe(false);
    if (profile.startsWith('legacy')) writeFileSync(join(directory, 'operator-defaults.json'), JSON.stringify({ thinkingEffort: explicit }));
    if (profile.startsWith('toml')) writeFileSync(join(directory, 'settings.toml'), `[models]\nthinking_effort = "${explicit}"\n`);
    const before = await read();
    const originalIntent = explicit ? { thinkingEffort: explicit } : {};
    const classicResponse = await fetch(origin + '/api/panel/operator-defaults?include=values', { headers });
    expect(classicResponse.status).toBe(200);
    const classic = await classicResponse.json();
    expect(classic.settingsToml.revision).toBe(before.settingsToml.revision);
    if (!profile.startsWith('toml')) {
      expect(Object.keys(parseOperatorDefaultsToml(classic.settingsToml.text)).length).toBeGreaterThan(1);
    }
    // Edit exactly the returned editor text. Resolved values remain read-only.
    const displayed = before.settingsToml.text as string;
    const edited = /^parallel_cap\s*=/m.test(displayed)
      ? displayed.replace(/^parallel_cap\s*=.*$/m, 'parallel_cap = 9')
      : `${displayed}\n[operator]\nparallel_cap = 9\n`;
    expect((await post({ settingsToml: edited, settingsTomlRevision: before.settingsToml.revision })).status).toBe(200);
    const after = await save({ parallelCap: 7 });
    expect(after.values.thinkingEffort).toBe(explicit ?? before.values.thinkingEffort);
    expect(after.sources.thinkingEffort).toBe(explicit ? 'file' : 'default');
    for (const key of ['codexWorkerEffort', 'claudeWorkerEffort']) {
      expect(after.values[key]).toBe(before.values[key]);
      expect(after.sources[key]).toBe('default');
    }
    expect(parseOperatorDefaultsToml(displayed)).toEqual(originalIntent);
    expect(Object.keys(before.values).length).toBeGreaterThan(Object.keys(originalIntent).length);
    expect(before.sources.thinkingEffort).toBe(explicit ? 'file' : 'default');
    expect(parseOperatorDefaultsToml(readFileSync(join(directory, 'settings.toml'), 'utf8'))).toEqual({ ...originalIntent, parallelCap: 7 });
  });
it.each(['triage', 'action'] as const)('preserves hidden %s keys when native editor text omits the tier', async tier => {
  const other = tier === 'triage' ? 'action' : 'triage';
  writeFileSync(join(directory, 'settings.toml'), '[accepted_table]\nopaque = "keep-me"\n'
    + `[targeting.${tier}]\nruntime = "codex"\nmodel = "m"\neffort = "low"\nhidden_extra = "keep-me-too"\n`
    + `[targeting.${other}]\nruntime = "codex"\nmodel = "m"\neffort = "low"\n`
    + '[models]\nthinking_effort = "high"\n');
  const before = await read();
  expect(before.settingsToml.additionalSettingsSet).toBe(true);
  expect(before.settingsToml.text).not.toMatch(/hidden_extra|keep-me|accepted_table/);
  const response = await post({ settingsToml: '[operator]\nparallel_cap = 9\n', settingsTomlRevision: before.settingsToml.revision });
  expect(response.status).toBe(200);
  const raw = readFileSync(join(directory, 'settings.toml'), 'utf8');
  const stored = parse(raw);
  expect(stored.accepted_table).toEqual({ opaque: 'keep-me' });
  expect(stored.targeting).toEqual({ [tier]: { hidden_extra: 'keep-me-too' } });
  expect(stored.models).not.toHaveProperty('thinking_effort');
  const after = await read();
  expect(after.values.parallelCap).toBe(9);
  expect(after.sources.thinkingEffort).toBe('default');
  expect(after.sources[tier === 'triage' ? 'targetingTriage' : 'targetingAction']).toBe('default');
  expect(after.settingsToml.additionalSettingsSet).toBe(true);
  expect(after.settingsToml.text).not.toContain('hidden_extra');
  const backup = readFileSync(join(directory, 'operator-defaults.json'), 'utf8');
  expect((await post({ settingsToml: '[operator]\nparallel_cap = 3\n', settingsTomlRevision: before.settingsToml.revision })).status).toBe(409);
  expect(readFileSync(join(directory, 'settings.toml'), 'utf8')).toBe(raw);
  expect(readFileSync(join(directory, 'operator-defaults.json'), 'utf8')).toBe(backup);
  await save({ parallelCap: 7 });
  expect(parse(readFileSync(join(directory, 'settings.toml'), 'utf8')).targeting).toEqual(stored.targeting);
});
async function save(update: Record<string, unknown>) {
  const before = await read();
  const response = await post({ ...update, settingsTomlRevision: before.settingsToml.revision });
  expect(response.status).toBe(200);
  return read();
}
it('keeps inherited effort default after the first unrelated save/reload, but records an explicit fallback value', async () => {
  const before = await read();
  const after = await save(fixture.unrelatedUpdate);
  expect(parseOperatorDefaultsToml(readFileSync(join(directory, 'settings.toml'), 'utf8'))).toEqual(fixture.unrelatedUpdate);
  expect(JSON.parse(readFileSync(join(directory, 'operator-defaults.json'), 'utf8'))).toEqual(fixture.unrelatedUpdate);
  for (const key of fixture.effortKeys) {
    expect(after.values[key]).toEqual(before.values[key]);
    expect(after.sources[key]).toBe('default');
  }
  const saved = readFileSync(join(directory, 'settings.toml'), 'utf8');
  writeFileSync(join(directory, 'settings.toml'), '[broken');
  const lastGood = await read();
  expect(lastGood.values).toEqual(after.values);
  for (const key of fixture.effortKeys) expect(lastGood.sources[key]).toBe('default');
  writeFileSync(join(directory, 'settings.toml'), saved);
  for (const key of fixture.effortKeys) {
    const explicit = await save({ [key]: before.values[key] });
    expect(explicit.values[key]).toEqual(before.values[key]);
    expect(explicit.sources[key]).toBe('file');
  }
});
it('retains materialized profiles and explicit max, whose original intent cannot be recovered', async () => {
  const before = await read();
  const existing = { ...before.values, ...fixture.existingExplicit };
  writeFileSync(join(directory, 'settings.toml'), serializeOperatorDefaultsToml(existing));
  const after = await save(fixture.unrelatedUpdate);
  expect(parseOperatorDefaultsToml(readFileSync(join(directory, 'settings.toml'), 'utf8'))).toEqual({ ...existing, ...fixture.unrelatedUpdate });
  for (const key of fixture.effortKeys) { expect(after.values[key]).toBe('max'); expect(after.sources[key]).toBe('file'); }
  // A legacy JSON profile can already contain the entire fallback projection,
  // including empty and null values; its original intent is also unrecoverable.
  rmSync(join(directory, 'settings.toml'));
  writeFileSync(join(directory, 'operator-defaults.json'), JSON.stringify(existing));
  await save(fixture.unrelatedUpdate);
  expect(parseOperatorDefaultsToml(readFileSync(join(directory, 'settings.toml'), 'utf8'))).toEqual({ ...existing, ...fixture.unrelatedUpdate });
});
it('keeps editor intent sparse through a following field save and last-good reload', async () => {
  const before = await read();
  const editor = await fetch(origin + '/api/panel/operator-defaults?include=values', {
    method: 'POST', headers,
    body: JSON.stringify({ settingsToml: '[operator]\nparallel_cap = 9\n', settingsTomlRevision: before.settingsToml.revision }),
  });
  expect(editor.status).toBe(200);
  const editorBackup = JSON.parse(readFileSync(join(directory, 'operator-defaults.json'), 'utf8'));
  const after = await save({ parallelCap: 7 });
  expect(after.sources.thinkingEffort).toBe('default');
  expect(editorBackup).toEqual({ parallelCap: 9 });
  expect(parseOperatorDefaultsToml(readFileSync(join(directory, 'settings.toml'), 'utf8'))).toEqual({ parallelCap: 7 });
  expect(JSON.parse(readFileSync(join(directory, 'operator-defaults.json'), 'utf8'))).toEqual({ parallelCap: 7 });
  for (const key of fixture.effortKeys) {
    expect(after.values[key]).toEqual(before.values[key]);
    expect(after.sources[key]).toBe('default');
  }
  writeFileSync(join(directory, 'settings.toml'), '[broken');
  const lastGood = await read();
  expect(lastGood.values).toEqual(after.values);
  for (const key of fixture.effortKeys) expect(lastGood.sources[key]).toBe('default');
});
it('retains previously stored legacy-only effort when migrating it on a field save', async () => {
  writeFileSync(join(directory, 'operator-defaults.json'), JSON.stringify(fixture.existingExplicit));
  const after = await save(fixture.unrelatedUpdate);
  expect(parseOperatorDefaultsToml(readFileSync(join(directory, 'settings.toml'), 'utf8'))).toEqual({ ...fixture.existingExplicit, ...fixture.unrelatedUpdate });
  for (const key of fixture.effortKeys) { expect(after.values[key]).toBe('max'); expect(after.sources[key]).toBe('file'); }
});
it('retains explicit editor max through a field save and last-good reload', async () => {
  const before = await read();
  const editor = await fetch(origin + '/api/panel/operator-defaults?include=values', {
    method: 'POST', headers,
    body: JSON.stringify({ settingsToml: '[models]\nthinking_effort = "max"\ncodex_worker_effort = "max"\nclaude_worker_effort = "max"\n', settingsTomlRevision: before.settingsToml.revision }),
  });
  expect(editor.status).toBe(200);
  const after = await save(fixture.unrelatedUpdate);
  expect(parseOperatorDefaultsToml(readFileSync(join(directory, 'settings.toml'), 'utf8'))).toEqual({ ...fixture.existingExplicit, ...fixture.unrelatedUpdate });
  writeFileSync(join(directory, 'settings.toml'), '[broken');
  const lastGood = await read();
  expect(lastGood.values).toEqual(after.values);
  for (const key of fixture.effortKeys) {
    expect(after.values[key]).toBe('max');
    expect(after.sources[key]).toBe('file');
    expect(lastGood.sources[key]).toBe('file');
  }
});
it('preserves unknown TOML tables, direct-editor comments and last-good effective values under the existing contract', async () => {
  writeFileSync(join(directory, 'settings.toml'), fixture.unknownToml);
  await save(fixture.unrelatedUpdate);
  const raw = readFileSync(join(directory, 'settings.toml'), 'utf8');
  expect(raw).toContain('[accepted_table]');
  expect(raw).toContain('opaque = "fixture-preserved"');
  // Field serialization already drops comments; exact direct-editor saves keep them.
  const revision = (await read()).settingsToml.revision;
  const exact = '# Exact editor comment\n[operator]\nparallel_cap = 9\n';
  const editor = await fetch(origin + '/api/panel/operator-defaults?include=values', { method: 'POST', headers, body: JSON.stringify({ settingsToml: exact, settingsTomlRevision: revision }) });
  expect(editor.status).toBe(200);
  expect(readFileSync(join(directory, 'settings.toml'), 'utf8')).toBe(exact);
  writeFileSync(join(directory, 'settings.toml'), '[broken');
  const fallback = await read();
  expect(fallback.values.parallelCap).toBe(9);
});
it('keeps revision conflicts terminal and rejects invalid changes without changing either file', async () => {
  const initial = await read();
  await save(fixture.unrelatedUpdate);
  const state = () => ['settings.toml', 'operator-defaults.json'].map(name => readFileSync(join(directory, name), 'utf8'));
  const before = state();
  expect((await post({ thinkingEffort: 'max', settingsTomlRevision: initial.settingsToml.revision })).status).toBe(409);
  expect(state()).toEqual(before);
  const revision = (await read()).settingsToml.revision;
  expect((await post({ thinkingEffort: 'not-an-effort', settingsTomlRevision: revision })).status).toBe(400);
  expect(state()).toEqual(before);
});

it('keeps native editor omissions default and explicit high through field saves', async () => {
  const editor = async (text: string) => {
    const revision = (await read()).settingsToml.revision;
    const response = await post({ settingsToml: text, settingsTomlRevision: revision });
    expect(response.status).toBe(200);
    return read();
  };
  await editor('[operator]\nparallel_cap = 9\n');
  const sparse = await save({ parallelCap: 7 });
  expect(sparse.sources.thinkingEffort).toBe('default');
  expect(parseOperatorDefaultsToml(readFileSync(join(directory, 'settings.toml'), 'utf8'))).toEqual({ parallelCap: 7 });
  const explicit = await editor('[operator]\nparallel_cap = 9\n[models]\nthinking_effort = "high"\n');
  expect(explicit.values.thinkingEffort).toBe('high');
  expect(explicit.sources.thinkingEffort).toBe('file');
  const kept = await save({ parallelCap: 7 });
  expect(kept.values.thinkingEffort).toBe('high');
  expect(kept.sources.thinkingEffort).toBe('file');
  // Replacing the declared document unsets a previously explicit effort.
  const reset = await editor('[operator]\nparallel_cap = 9\n');
  expect(reset.sources.thinkingEffort).toBe('default');
  expect((await save({ parallelCap: 7 })).sources.thinkingEffort).toBe('default');
});
