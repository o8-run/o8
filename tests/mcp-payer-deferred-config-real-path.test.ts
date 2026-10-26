import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
const root = mkdtempSync(join(tmpdir(), 'o8-mcp-deferred-policy-'));
const peer = join(root, 'claude'), receipt = join(root, 'receipt.json');
const saved = 'fixture-deferred-server-key';
vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 116).toString('base64url'));
const { mutateProviderKey } = await import('@/lib/providers/key-store');
const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
const { closeMcpLaunchBrokers } = await import('@/lib/mcp/launch-broker');
const servers = await import('@/lib/mcp/external-servers');
const { testMcpConnection } = await import('@/lib/mcp/test-connection');
const { closeDb } = await import('@/lib/db');
writeFileSync(peer, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(receipt)},JSON.stringify({key:!!process.env.ANTHROPIC_API_KEY,master:!!process.env.O8_MASTER_KEY}));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);if(!m.id||m.method==='notifications/initialized')return;
const result=m.method==='tools/list'?{tools:[{name:'fixture',description:${JSON.stringify(saved)},inputSchema:{}}]}:{};
console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});
`, { mode: 0o755 });
beforeEach(() => {
  closeMcpLaunchBrokers();
  for (const server of servers.listExternalMcpServers()) servers.removeExternalMcpServer(server.id);
  mutateProviderKey('ANTHROPIC_API_KEY', { key: saved });
});
afterAll(() => { closeMcpLaunchBrokers(); closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function configured() {
  return servers.insertExternalMcpServer({ name: 'deferred', transport: 'stdio', command: peer,
    env: { ANTHROPIC_API_KEY: saved }, enabled: true });
}
function probe(config: ReturnType<typeof servers.externalServerToMcpConfig>, timeout?: number) {
  if (config.type !== 'stdio') throw new Error('Wrong fixture transport');
  return testMcpConnection({ transport: 'stdio', command: config.command, args: config.args, env: config.env }, timeout);
}
it.each(['subscription', 'api'] as const)('registered lead config exposes no key and launches with fresh %s policy', async mode => {
  saveRuntimeBillingMode('claude-code', mode);
  const config = servers.externalServerToMcpConfig(configured(), root);
  expect(JSON.stringify(config).includes(saved)).toBe(false);
  const result = await probe(config);
  expect(result.ok).toBe(true); expect(JSON.stringify(result).includes(saved)).toBe(false);
  expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({ key: mode === 'api', master: false });
});
it('fails old references closed after broker shutdown and regenerates a working reference', async () => {
  const server = configured(), original = servers.externalServerToMcpConfig(server, root);
  expect((await probe(original)).ok).toBe(true);
  closeMcpLaunchBrokers();
  expect((await probe(original, 1500)).ok).toBe(false);
  const replacement = servers.externalServerToMcpConfig(server, root);
  expect(JSON.stringify(replacement) === JSON.stringify(original)).toBe(false);
  expect((await probe(replacement)).ok).toBe(true);
});
it('refuses a disabled registered server without starting it', async () => {
  const server = configured(), config = servers.externalServerToMcpConfig(server, root);
  servers.updateExternalMcpServer(server.id, { enabled: false });
  const result = await probe(config); expect(result.ok).toBe(false);
  expect(JSON.stringify(result).includes(saved)).toBe(false);
});
it('preserves Unicode RPC output across split native stdout chunks', async () => {
  const unicode = join(root, 'unicode.cjs');
  mkdirSync(join(root, 'unicode'), { recursive: true });
  writeFileSync(unicode, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id||m.method==='notifications/initialized')return;const b=Buffer.from(JSON.stringify({id:m.id,result:m.method==='tools/list'?{tools:[{name:'unicode',description:'fixture 🧪'}]}:{}})+'\\n');let i=0;const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i===b.length)clearInterval(t);},1);});`);
  const server = servers.insertExternalMcpServer({ name: 'unicode', transport: 'stdio', command: process.execPath, args: [unicode], enabled: true });
  const result = await probe(servers.externalServerToMcpConfig(server, root));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.tools[0].description).toBe('fixture 🧪');
});
it('drains all deferred stdout before reporting child exit to a slow reader', async () => {
  const script = join(root, 'burst.cjs');
  const frames = 32, payload = 512 * 1024;
  writeFileSync(script, `const frame=JSON.stringify({result:'x'.repeat(${payload})})+'\\n';let i=0;function next(){if(i++===${frames}){process.exit(0);return;}process.stdout.write(frame,next);}next();`);
  const server = servers.insertExternalMcpServer({ name: 'burst', transport: 'stdio', command: process.execPath, args: [script], enabled: true });
  const config = servers.externalServerToMcpConfig(server, root);
  if (config.type !== 'stdio') throw new Error('Wrong fixture transport');
  const result = await new Promise<{ code: number | null; lines: number; bytes: number }>((resolve, reject) => {
    const child = spawn(config.command, config.args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let lines = 0, bytes = 0;
    child.on('error', reject);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      for (const byte of chunk) if (byte === 10) lines++;
    });
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), 300);
    child.stdin.end();
    child.on('close', code => resolve({ code, lines, bytes }));
  });
  expect(result).toEqual({ code: 0, lines: frames, bytes: frames * (payload + 14) });
}, 15000);
