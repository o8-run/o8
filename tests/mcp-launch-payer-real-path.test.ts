// Regression guard for #4694: a configured MCP server launched by Symon must
// never receive o8's saved provider key (or the master key) in its environment,
// even when the key is present in o8's own ambient env and the Claude runtime is
// on subscription billing. The leak was a raw `{ ...process.env }` spread in the
// stdio launch; the fix routes every MCP launch through the credential filter
// (`childEnvironment({ ..., inject: false })` in symon-tools, and the central
// `@/lib/providers/child-process` wrapper, which strips ambient provider
// credentials from any env lacking an authorized API-billing context).
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const fixture = path.join(process.cwd(), 'tests/fixtures/mcp-env-probe.mjs');
const probeOut = path.join(dataDir, 'mcp-env-probe.json');
const SAVED_KEY = 'sk-ant-FIXTURE-4694-should-never-reach-a-subscription-cli';

const priorIdleMs = process.env.O8_SYMON_MCP_IDLE_MS;
const priorAmbientKey = process.env.ANTHROPIC_API_KEY;
const priorMasterKey = process.env.O8_MASTER_KEY;

describe.sequential('MCP launch payer boundary (#4694)', () => {
  let serverId: string | undefined;

  beforeAll(async () => {
    process.env.O8_SYMON_MCP_IDLE_MS = '80';
    process.env.O8_MASTER_KEY ??= Buffer.alloc(32, 94).toString('base64url');
    // The real leak vector: o8's own process carries the saved key in ambient env.
    process.env.ANTHROPIC_API_KEY = SAVED_KEY;
    rmSync(probeOut, { force: true });

    const { mutateProviderKey } = await import('@/lib/providers/key-store');
    const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
    mutateProviderKey('ANTHROPIC_API_KEY', { key: SAVED_KEY });
    saveRuntimeBillingMode('claude', 'subscription');

    const { insertExternalMcpServer } = await import('@/lib/mcp/external-servers');
    serverId = insertExternalMcpServer({
      name: 'env-probe',
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: { MCP_ENV_PROBE_OUT: probeOut },
      enabled: true,
      symonInjection: true,
    }).id;
  });

  afterAll(async () => {
    if (serverId) {
      const { removeExternalMcpServer } = await import('@/lib/mcp/external-servers');
      removeExternalMcpServer(serverId);
    }
    const { closeDb } = await import('@/lib/db');
    closeDb();
    rmSync(probeOut, { force: true });
    if (priorIdleMs === undefined) delete process.env.O8_SYMON_MCP_IDLE_MS; else process.env.O8_SYMON_MCP_IDLE_MS = priorIdleMs;
    if (priorAmbientKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorAmbientKey;
    if (priorMasterKey === undefined) delete process.env.O8_MASTER_KEY; else process.env.O8_MASTER_KEY = priorMasterKey;
  });

  it('never passes the saved provider key or master key to a configured stdio MCP server', async () => {
    const { getSymonMcpCatalog } = await import('@/lib/mcp/symon-tools');
    // Launching the catalog spawns the configured stdio server through the real
    // StdioSession path; the fixture records the environment it was handed.
    const catalog = await getSymonMcpCatalog({ refresh: true });
    expect(catalog.tools.some((tool) => tool.name.includes('noop'))).toBe(true);

    const probe = JSON.parse(readFileSync(probeOut, 'utf8')) as {
      anthropic: string | null; masterKey: string | null; values: string[]; credentialNames: string[];
    };
    // The saved key must not arrive under its canonical name…
    expect(probe.anthropic).toBeNull();
    // …nor under any other name (exact-value match), nor the master key.
    expect(probe.values).not.toContain(SAVED_KEY);
    expect(probe.masterKey).toBeNull();
    expect(probe.credentialNames).not.toContain('ANTHROPIC_API_KEY');
    // Non-credential env (the server's own config) still reaches it.
    expect(probe.values).toContain(probeOut);
  });
});
