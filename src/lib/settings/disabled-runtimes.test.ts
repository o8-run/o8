import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-disabled-runtimes-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { getOperatorDefaults, getOperatorDefaultsTomlPath, getOperatorDefaultsTomlState } = await import('@/lib/operator/defaults');
const { parseOperatorDefaultsToml } = await import('./toml');
const { GET, POST } = await import('@/app/api/panel/operator-defaults/route');

const tomlPath = getOperatorDefaultsTomlPath();
beforeEach(() => {
  rmSync(tomlPath, { force: true });
  rmSync(join(dataDir, 'operator-defaults.json'), { force: true });
});

const native = 'http://127.0.0.1/api/panel/operator-defaults?include=native';
const post = (body: unknown) => POST(new Request(native, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));

describe('disabledRuntimes (Settings › Providers switch)', () => {
  it('defaults to every runtime on', async () => {
    const data = await getOperatorDefaults();
    expect(data.values.disabledRuntimes).toEqual([]);
    expect(data.sources.disabledRuntimes).toBe('default');
  });

  it('persists through the native settings POST and reads back from settings.toml', async () => {
    const { revision } = await getOperatorDefaultsTomlState();
    const response = await post({ disabledRuntimes: ['cursor', 'cursor', 'grok'], settingsTomlRevision: revision });
    expect(response.status).toBe(200);
    expect(readFileSync(tomlPath, 'utf8')).toMatch(/\[providers\][\s\S]*disabled_runtimes/);
    const read = await (await GET(new Request(native))).json();
    expect(read.values.disabledRuntimes).toEqual(['cursor', 'grok']);
    expect(read.sources.disabledRuntimes).toBe('file');

    const next = await getOperatorDefaultsTomlState();
    expect((await post({ disabledRuntimes: [], settingsTomlRevision: next.revision })).status).toBe(200);
    expect((await getOperatorDefaults()).values.disabledRuntimes).toEqual([]);
  });

  it('refuses names that are not dispatchable runtimes', async () => {
    const { revision } = await getOperatorDefaultsTomlState();
    const response = await post({ disabledRuntimes: ['not-a-runtime'], settingsTomlRevision: revision });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(() => parseOperatorDefaultsToml('[providers]\ndisabled_runtimes = ["nope"]\n')).toThrow();
    expect(parseOperatorDefaultsToml('[providers]\ndisabled_runtimes = []\n').disabledRuntimes).toEqual([]);
  });
});
