import { afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'o8-mcp-private-registry-'));
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
it('a real stdio MCP launch keeps offline private npm config, certificates and tool overrides', async () => {
  const config = join(root, 'private.npmrc');
  const receipt = join(root, 'receipt.json');
  const binary = join(root, 'peer.cjs');
  const registry = 'https://fixture-registry.invalid/private/';
  writeFileSync(config, `registry=${registry}\n`);
  for (const name of ['NPM_CONFIG_REGISTRY', 'npm_config_registry', 'NPM_CONFIG_GLOBALCONFIG', 'npm_config_globalconfig']) vi.stubEnv(name, undefined);
  const controls = { NPM_CONFIG_USERCONFIG: config, npm_config_userconfig: config, REQUESTS_CA_BUNDLE: join(root, 'ca.pem'),
    PNPM_HOME: join(root, 'pnpm'), YARN_CACHE_FOLDER: join(root, 'yarn'), O8_CODEBASE_MEMORY_BIN: join(root, 'memory'), LC_NUMERIC: 'C' };
  for (const [name, value] of Object.entries(controls)) vi.stubEnv(name, value);
  vi.stubEnv('ANTHROPIC_API_KEY', 'fixture-provider-must-not-travel');
  writeFileSync(binary, `
const fs=require('node:fs');
const npm=require('node:child_process').execFileSync('npm',['config','get','registry','--offline'],{encoding:'utf8',cwd:${JSON.stringify(root)}}).trim();
const wanted=${JSON.stringify(controls)};
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({registry:npm===${JSON.stringify(registry)},
 controls:Object.entries(wanted).every(([k,v])=>process.env[k]===v),provider:!!process.env.ANTHROPIC_API_KEY}));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(!m.id)return;
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='tools/list'?{tools:[{name:'fixture'}]}:{}})+'\\n')});
`);
  const { testMcpConnection } = await import('@/lib/mcp/test-connection');
  expect((await testMcpConnection({ transport: 'stdio', command: process.execPath, args: [binary] })).ok).toBe(true);
  expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({ registry: true, controls: true, provider: false });
});
