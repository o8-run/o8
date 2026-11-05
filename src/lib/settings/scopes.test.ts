import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';

import { OPERATOR_DEFAULTS_FALLBACK } from '@/lib/operator/defaults';
import {
  readSettingsLayers,
  resolveSettingsLayers,
  SCOPED_SETTING_KEYS,
  writeScopedSetting,
  type SettingsLayers,
} from './scopes';

const ids = { projectId: 'p1', machineId: 'm1' };
/** Reads a nested TOML path without `any`. */
const at = (document: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], document);


describe('resolveSettingsLayers precedence', () => {
  // [global, project, machine] -> [value, scope]; undefined means the layer is unset.
  const table: Array<[number | undefined, number | undefined, number | undefined, number, string]> = [
    [undefined, undefined, undefined, OPERATOR_DEFAULTS_FALLBACK.parallelCap, 'default'],
    [3, undefined, undefined, 3, 'global'],
    [undefined, 4, undefined, 4, 'project'],
    [3, 4, undefined, 4, 'project'],
    [undefined, undefined, 5, 5, 'machine'],
    [3, undefined, 5, 5, 'machine'],
    [undefined, 4, 5, 5, 'machine'],
    [3, 4, 5, 5, 'machine'],
  ];
  it.each(table)('global=%s project=%s machine=%s resolves to %s from %s', (global, project, machine, value, scope) => {
    const layers: SettingsLayers = {
      global: global === undefined ? {} : { parallelCap: global },
      project: project === undefined ? {} : { p1: { parallelCap: project } },
      machine: machine === undefined ? {} : { m1: { parallelCap: machine } },
    };
    const resolved = resolveSettingsLayers(layers, OPERATOR_DEFAULTS_FALLBACK, ids);
    expect(resolved.values.parallelCap).toBe(value);
    expect(resolved.scopes.parallelCap).toBe(scope);
  });

  it('resolves per key and ignores other projects and machines', () => {
    const layers: SettingsLayers = {
      global: { parallelCap: 3, branchPrefix: 'global' },
      project: { p1: { branchPrefix: 'project' }, p2: { parallelCap: 7 } },
      machine: { m2: { parallelCap: 8 } },
    };
    const resolved = resolveSettingsLayers(layers, OPERATOR_DEFAULTS_FALLBACK, ids);
    expect(resolved.values).toMatchObject({ parallelCap: 3, branchPrefix: 'project' });
    expect(resolved.scopes).toMatchObject({ parallelCap: 'global', branchPrefix: 'project' });
    // A project switch re-resolves against the other project's layer.
    expect(resolveSettingsLayers(layers, OPERATOR_DEFAULTS_FALLBACK, { ...ids, projectId: 'p2' }).values)
      .toMatchObject({ parallelCap: 7, branchPrefix: 'global' });
  });
});

describe('settings.toml layers', () => {
  const flat = '[operator]\nparallel_cap = 4\n\n[git]\nbranch_prefix = "flat"\n\n[providers.extra]\nkept = true\n';

  it('migrates a flat file into the global layer and keeps it there on the first scoped write', () => {
    expect(readSettingsLayers(flat)).toEqual({ global: { parallelCap: 4, branchPrefix: 'flat' }, project: {}, machine: {} });
    const written = writeScopedSetting(flat, 'project', 'p1', 'parallelCap', 6);
    const document = parse(written);
    expect(at(document, 'operator', 'parallel_cap')).toBe(4);
    expect(at(document, 'providers', 'extra', 'kept')).toBe(true);
    expect(at(document, 'scope', 'version')).toBe(1);
    expect(readSettingsLayers(written)).toEqual({
      global: { parallelCap: 4, branchPrefix: 'flat' }, project: { p1: { parallelCap: 6 } }, machine: {},
    });
  });

  it('round-trips each layer and clears back to the layer below', () => {
    let raw = writeScopedSetting(flat, 'project', 'p1', 'branchPrefix', 'proj');
    raw = writeScopedSetting(raw, 'machine', 'm1', 'branchPrefix', 'mach');
    expect(readSettingsLayers(raw)).toMatchObject({ project: { p1: { branchPrefix: 'proj' } }, machine: { m1: { branchPrefix: 'mach' } } });
    raw = writeScopedSetting(raw, 'machine', 'm1', 'branchPrefix', null);
    expect(resolveSettingsLayers(readSettingsLayers(raw), OPERATOR_DEFAULTS_FALLBACK, ids).values.branchPrefix).toBe('proj');
    raw = writeScopedSetting(raw, 'project', 'p1', 'branchPrefix', null);
    expect(resolveSettingsLayers(readSettingsLayers(raw), OPERATOR_DEFAULTS_FALLBACK, ids).values.branchPrefix).toBe('flat');
    expect(at(parse(raw), 'scope')).toEqual({ version: 1 });
  });

  it('validates values and keeps global-only keys out of the layers', () => {
    expect(() => writeScopedSetting(flat, 'machine', 'm1', 'parallelCap', 0)).toThrow();
    expect(() => writeScopedSetting(flat, 'machine', 'm1', 'knowledgeSources', [])).toThrow(/globally/);
    expect(SCOPED_SETTING_KEYS).not.toContain('telemetryIngestUrl');
  });
});
