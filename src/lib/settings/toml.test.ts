import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'smol-toml';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-settings-toml-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const {
  OPERATOR_DEFAULTS_FALLBACK,
  applyOperatorDefaultsToml,
  getOperatorDefaults,
  getOperatorDefaultsTomlState,
  getOperatorDefaultsTomlPath,
  resolveOrchestratorBackendSync,
} = await import('@/lib/operator/defaults');
const {
  OPERATOR_DEFAULTS_TOML_MAPPING,
  parseOperatorDefaultsToml,
} = await import('./toml');
const { GET, POST } = await import('@/app/api/panel/operator-defaults/route');

const tomlPath = getOperatorDefaultsTomlPath();
const jsonPath = join(dataDir, 'operator-defaults.json');

beforeEach(() => {
  rmSync(tomlPath, { force: true });
  rmSync(jsonPath, { force: true });
});

function postDefaults(body: unknown): Request {
  return new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function currentRevision(): Promise<string> {
  return (await getOperatorDefaultsTomlState()).revision;
}

async function applyToml(raw: string): Promise<void> {
  await applyOperatorDefaultsToml(raw, await currentRevision());
}

describe('settings.toml operator defaults', () => {
  it('persists a disabled volume reserve through GUI and TOML saves', async () => {
    const saved = await POST(postDefaults({ storageReserveRatio: 0 }));
    expect(saved.status).toBe(200);
    expect(parseOperatorDefaultsToml(readFileSync(tomlPath, 'utf8')).storageReserveRatio).toBe(0);
    const readback = await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    expect((await readback.json()).values.storageReserveRatio).toBe(0);

    const tomlSaved = await POST(postDefaults({
      settingsToml: '[git]\nstorage_reserve_ratio = 0\nstorage_reserve_floor_gb = 3\n',
      settingsTomlRevision: await currentRevision(),
    }));
    expect(tomlSaved.status).toBe(200);
    expect((await getOperatorDefaults()).values).toMatchObject({
      storageReserveRatio: 0, storageReserveFloorGb: 3,
    });
  });

  it.each([null, '', [], false])('rejects a non-numeric reserve without interpreting %j as zero', async (value) => {
    await applyToml('[git]\nstorage_reserve_ratio = 0.15\n');
    const before = readFileSync(tomlPath, 'utf8');
    const saved = await POST(postDefaults({ storageReserveRatio: value }));
    expect(saved.status).toBe(400);
    expect(readFileSync(tomlPath, 'utf8')).toBe(before);
    expect((await getOperatorDefaults()).values.storageReserveRatio).toBe(0.15);
  });

  it('maps every OperatorDefaults key to settings.toml (exhaustive-key-coverage)', () => {
    expect(Object.keys(OPERATOR_DEFAULTS_TOML_MAPPING).sort()).toEqual(
      Object.keys(OPERATOR_DEFAULTS_FALLBACK).sort(),
    );
  });

  it('applies a valid TOML edit through the consumer read path', async () => {
    const response = await POST(postDefaults({
      settingsToml: `
[orchestrator]
backend = "codex"
`,
      settingsTomlRevision: await currentRevision(),
    }));

    expect(response.status).toBe(200);
    expect(resolveOrchestratorBackendSync()).toBe('codex');
    expect((await getOperatorDefaults()).values.orchestratorBackend).toBe('codex');
  });

  it('persists the enabled-by-default background title inference control', async () => {
    expect((await getOperatorDefaults()).values.autoTitleInferenceEnabled).toBe(true);
    const result = await POST(postDefaults({ autoTitleInferenceEnabled: false }));
    expect(result.status).toBe(200);
    expect((await getOperatorDefaults()).values.autoTitleInferenceEnabled).toBe(false);
    expect(parseOperatorDefaultsToml(readFileSync(tomlPath, 'utf8')).autoTitleInferenceEnabled).toBe(false);
    const read = await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    expect((await read.json()).values.autoTitleInferenceEnabled).toBe(false);
  });

  it('persists the subscription-only Symon voice setting at its documented path', async () => {
    const response = await POST(postDefaults({
      settingsToml: `
[symon.voice]
subscriptionOnly = true
`,
      settingsTomlRevision: await currentRevision(),
    }));

    expect(response.status).toBe(200);
    expect((await getOperatorDefaults()).values.symonVoiceSubscriptionOnly).toBe(true);
    expect(parseOperatorDefaultsToml(readFileSync(tomlPath, 'utf8')).symonVoiceSubscriptionOnly)
      .toBe(true);
  });

  it('persists the Astra orchestrator model through settings.toml and the route consumer', async () => {
    const response = await POST(postDefaults({
      settingsToml: `
[models]
orchestrator_model = "gpt-6-astra"
`,
      settingsTomlRevision: await currentRevision(),
    }));

    expect(response.status).toBe(200);
    expect(parseOperatorDefaultsToml(readFileSync(tomlPath, 'utf8')).orchestratorModel)
      .toBe('gpt-6-astra');
    expect((await getOperatorDefaults()).values.orchestratorModel).toBe('gpt-6-astra');
  });

  it('defaults Fleet to five and Strict while preserving explicit Advisory choices', async () => {
    const initial = await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    expect((await initial.json()).values).toMatchObject({ parallelCap: 5, overlapGate: 'strict' });

    const saved = await POST(postDefaults({ overlapGate: 'advisory' }));
    expect(saved.status).toBe(200);
    const readback = await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    expect((await readback.json()).values.overlapGate).toBe('advisory');
    expect(parseOperatorDefaultsToml(readFileSync(tomlPath, 'utf8')).overlapGate).toBe('advisory');
  });

  it('persists APFS dependency images through the real route and store', async () => {
    expect((await getOperatorDefaults()).values.apfsDependencyImages)
      .toBe(process.platform === 'darwin');

    const response = await POST(postDefaults({ apfsDependencyImages: true }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.values.apfsDependencyImages).toBe(true);
    expect(payload.sources.apfsDependencyImages).toBe('file');
    expect(parseOperatorDefaultsToml(readFileSync(tomlPath, 'utf8')).apfsDependencyImages)
      .toBe(true);

    const readResponse = await GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    expect((await readResponse.json()).values.apfsDependencyImages).toBe(true);
  });

  it('rejects an invalid value with its key and leaves settings unchanged', async () => {
    await applyToml(`
[models]
thinking_effort = "high"
`);
    const beforeToml = readFileSync(tomlPath, 'utf8');
    const beforeValues = (await getOperatorDefaults()).values;

    const response = await POST(postDefaults({
      settingsToml: `
[models]
thinking_effort = "many"
`,
      settingsTomlRevision: await currentRevision(),
    }));
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.error).toBe('models.thinking_effort expected a valid thinking effort.');
    expect(readFileSync(tomlPath, 'utf8')).toBe(beforeToml);
    expect((await getOperatorDefaults()).values).toEqual(beforeValues);
  });

  it('round-trips a GUI change without dropping mapped or unknown keys', async () => {
    await applyToml(`
# This direct-editor comment remains until a GUI rewrite.
[operator]
parallel_cap = 4
future_toggle = "keep-me"

[agent_extension]
mode = "custom"
`);

    const response = await POST(postDefaults({
      thinkingEffort: 'xhigh',
      branchPrefix: 'agent',
      requireApproval: 'always',
    }));
    await response.json();
    expect(response.status).toBe(200);
    const raw = readFileSync(tomlPath, 'utf8');
    const reparsed = parseOperatorDefaultsToml(raw);
    const rawDocument = parse(raw) as Record<string, Record<string, unknown>>;
    const expectedPersisted = {
      ...OPERATOR_DEFAULTS_FALLBACK,
      parallelCap: 4,
      thinkingEffort: 'xhigh',
      branchPrefix: 'agent',
      requireApproval: 'always',
    };

    expect(Object.keys(reparsed).sort()).toEqual(Object.keys(OPERATOR_DEFAULTS_FALLBACK).sort());
    for (const key of Object.keys(OPERATOR_DEFAULTS_FALLBACK) as Array<keyof typeof OPERATOR_DEFAULTS_FALLBACK>) {
      expect(reparsed[key], `TOML key for ${key} evaporated`).toEqual(expectedPersisted[key]);
    }
    expect(rawDocument.operator.future_toggle).toBe('keep-me');
    expect(rawDocument.agent_extension.mode).toBe('custom');
  });

  it('uses last-good defaults when settings.toml is unparseable', async () => {
    await applyToml(`
[orchestrator]
backend = "claude"
`);
    writeFileSync(tomlPath, '[orchestrator\nbackend = "codex"\n');

    expect((await getOperatorDefaults()).values.orchestratorBackend).toBe('claude');
    expect(resolveOrchestratorBackendSync()).toBe('claude');
    expect(readFileSync(tomlPath, 'utf8')).toBe('[orchestrator\nbackend = "codex"\n');
  });

  it('rejects a stale full-document save without overwriting the agent edit', async () => {
    const editorRevision = await currentRevision();
    await applyOperatorDefaultsToml(`
[orchestrator]
backend = "codex"
`, editorRevision);
    const agentFile = readFileSync(tomlPath, 'utf8');

    const response = await POST(postDefaults({
      settingsToml: '[orchestrator]\nbackend = "claude"\n',
      settingsTomlRevision: editorRevision,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'settings.toml changed on disk — reload to see the current file',
    });
    expect(readFileSync(tomlPath, 'utf8')).toBe(agentFile);
    expect(resolveOrchestratorBackendSync()).toBe('codex');
  });

  it('requires a revision for every full-document save', async () => {
    const response = await POST(postDefaults({
      settingsToml: '[orchestrator]\nbackend = "codex"\n',
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'settingsTomlRevision is required to save settings.toml.',
    });
    expect(() => readFileSync(tomlPath, 'utf8')).toThrow();
  });

  it('serializes concurrent field updates without losing either value', async () => {
    await applyToml('[operator]\nparallel_cap = 4\n');

    const [effortResponse, branchResponse] = await Promise.all([
      POST(postDefaults({ thinkingEffort: 'xhigh' })),
      POST(postDefaults({ branchPrefix: 'concurrent' })),
    ]);

    expect(effortResponse.status).toBe(200);
    expect(branchResponse.status).toBe(200);
    const resolved = (await getOperatorDefaults()).values;
    expect(resolved.thinkingEffort).toBe('xhigh');
    expect(resolved.branchPrefix).toBe('concurrent');
  });

  it('merges a field update onto the latest direct settings.toml edit', async () => {
    await applyToml('[orchestrator]\nbackend = "claude"\n');
    writeFileSync(tomlPath, '[orchestrator]\nbackend = "codex"\nagent_note = "keep"\n');

    const response = await POST(postDefaults({ branchPrefix: 'latest' }));

    expect(response.status).toBe(200);
    const resolved = (await getOperatorDefaults()).values;
    expect(resolved.orchestratorBackend).toBe('codex');
    expect(resolved.branchPrefix).toBe('latest');
    const document = parse(readFileSync(tomlPath, 'utf8')) as {
      orchestrator: Record<string, unknown>;
    };
    expect(document.orchestrator.agent_note).toBe('keep');
  });

  it('preserves unknown scalar and nested table keys inside a known targeting table', async () => {
    await applyToml(`
[targeting.triage]
runtime = "codex"
model = ""
effort = "low"
future_toggle = true

[targeting.triage.future_table]
mode = "keep-me"
`);

    const response = await POST(postDefaults({ parallelCap: 6 }));
    expect(response.status).toBe(200);
    const document = parse(readFileSync(tomlPath, 'utf8')) as {
      targeting: { triage: Record<string, unknown> };
    };
    expect(document.targeting.triage.future_toggle).toBe(true);
    expect(document.targeting.triage.future_table).toEqual({ mode: 'keep-me' });
  });

  it('rejects an unsupported orchestrator model through TOML and field APIs', async () => {
    const tomlResponse = await POST(postDefaults({
      settingsToml: '[models]\norchestrator_model = "gpt5"\n',
      settingsTomlRevision: await currentRevision(),
    }));
    expect(tomlResponse.status).toBe(400);
    await expect(tomlResponse.json()).resolves.toMatchObject({
      error: expect.stringContaining('models.orchestrator_model expected a supported model id; received "gpt5"'),
    });

    const apiResponse = await POST(postDefaults({ orchestratorModel: 'gpt5' }));
    expect(apiResponse.status).toBe(400);
    await expect(apiResponse.json()).resolves.toMatchObject({
      error: expect.stringContaining('orchestratorModel "gpt5" is unsupported'),
    });
  });

  it.each([
    ['userinfo', 'local_models', 'inference_base_url', 'localInferenceBaseUrl', 'http://user:secret@localhost:11434'],
    ['signed query token', 'telemetry', 'ingest_url', 'telemetryIngestUrl', 'https://telemetry.example/ingest?X-Amz-Signature=secret'],
  ])('rejects credential-bearing URL %s through TOML and field APIs', async (_shape, section, key, apiKey, url) => {
    const tomlResponse = await POST(postDefaults({
      settingsToml: `[${section}]\n${key} = ${JSON.stringify(url)}\n`,
      settingsTomlRevision: await currentRevision(),
    }));
    expect(tomlResponse.status).toBe(400);
    await expect(tomlResponse.json()).resolves.toMatchObject({
      error: expect.stringContaining('use an environment variable or keychain for authenticated endpoints'),
    });

    const apiResponse = await POST(postDefaults({ [apiKey]: url }));
    expect(apiResponse.status).toBe(400);
    await expect(apiResponse.json()).resolves.toMatchObject({
      error: expect.stringContaining('use an environment variable or keychain for authenticated endpoints'),
    });
  });
});


it('keeps stored TOML credentials out of native error responses and recovery logs', async () => {
  const canary = ['fixture-private', 'parse-canary'].join('-');
  await applyToml(`[operator]\nparallel_cap = 3\n[accepted_table]\ntoken = "${canary}"\n`);
  // A direct file edit can leave valid stored credentials beside broken syntax.
  writeFileSync(tomlPath, `[accepted_table]\ntoken = "${canary}" trailing-invalid-text\n`);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const response = await GET(new Request('http://127.0.0.1/api/panel/operator-defaults?include=native'));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(JSON.stringify(payload).includes(canary)).toBe(false);
    expect(payload.settingsToml.text).toBe('');
    expect(payload.settingsToml.error).toBeTruthy();
    const { getOperatorDefaultsSync } = await import('@/lib/operator/defaults');
    expect(getOperatorDefaultsSync().values.parallelCap).toBe(3);
    expect(log.mock.calls.flat().map(String).join(' ').includes(canary)).toBe(false);
  } finally {
    log.mockRestore();
  }
});
