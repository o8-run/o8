import { createHash } from 'node:crypto';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({ dir: '', peer: '' }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.dir }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir, migrateDataDirOnce: () => {} }));
vi.mock('@/lib/lane/orchestrator-backends/acp', () => ({ resolveAcpLaunch: () => ({ command: process.execPath, args: [state.peer] }) }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-key-model-probe-')); state.peer = join(state.dir, 'peer.cjs');
writeFileSync(state.peer, `const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);const value=JSON.stringify({key:process.env.OPENAI_API_KEY||null,alias:process.env.CODEX_API_KEY||null,keyDigest:process.env.OPENAI_API_KEY?require('node:crypto').createHash('sha256').update(process.env.OPENAI_API_KEY).digest('hex'):null,aliasDigest:process.env.CODEX_API_KEY?require('node:crypto').createHash('sha256').update(process.env.CODEX_API_KEY).digest('hex'):null});if(m.id)send({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:1}:m.method==='session/new'?{sessionId:'fixture',configOptions:[{id:'model',type:'select',currentValue:value,options:[{value:'fixture-model'}]}]}:{}})});`);
const keys = await import('@/app/api/v2/keys/route');
const billing = await import('@/app/api/runtime/billing/route');
const catalogue = await import('@/app/api/orchestrator/backend-models/route');
const request = (path: string, body: unknown, method = 'POST') => new NextRequest(`http://localhost/api/${path}`, { method, headers: { host: 'localhost' }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.stubEnv('HOME', state.dir);
  writeFileSync(join(state.dir, '.env.local'), ''); rmSync(join(state.dir, 'runtime-billing'), { recursive: true, force: true });
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 82).toString('base64url')); vi.stubEnv('OPENAI_API_KEY', ''); vi.stubEnv('CODEX_API_KEY', 'fixture-stale');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(state.dir, { recursive: true, force: true }); });
it.each(['subscription', 'api', 'disable', 'remove'])('catalogue refresh honors %s through the real ACP child', async action => {
  expect((await billing.POST(request('runtime/billing', { runtimeId: 'opencode', mode: action === 'subscription' ? 'subscription' : 'api' }))).status).toBe(200);
  expect((await keys.POST(request('v2/keys', { provider: 'openai', key: 'fixture-probe-key' }))).status).toBe(200);
  if (action === 'disable') expect((await keys.PATCH(request('v2/keys', { provider: 'openai', enabled: false }, 'PATCH'))).status).toBe(200);
  if (action === 'remove') expect((await keys.DELETE(request('v2/keys', { provider: 'openai' }, 'DELETE'))).status).toBe(200);
  const response = await catalogue.GET(new NextRequest('http://localhost/api/orchestrator/backend-models?backend=opencode&refresh=1', { headers: { host: 'localhost' } }));
  const result = await response.json(); expect(result.error).toBeUndefined();
  const value = action === 'api' ? '[redacted]' : null;
  const digest = action === 'api' ? createHash('sha256').update('fixture-probe-key').digest('hex') : null;
  expect(JSON.parse(result.currentModel)).toEqual({ key: value, alias: value, keyDigest: digest, aliasDigest: digest });
});
it('an unidentified ACP runtime fails closed even when another runtime opted into API billing', async () => {
  expect((await billing.POST(request('runtime/billing', { runtimeId: 'opencode', mode: 'api' }))).status).toBe(200);
  expect((await keys.POST(request('v2/keys', { provider: 'openai', key: 'fixture-probe-key' }))).status).toBe(200);
  const { AcpClient } = await import('@/lib/acp/client');
  const client = new AcpClient({ command: process.execPath, args: [state.peer] } as never);
  try { await client.initialize(); const result = await client.newSession(state.dir, []); expect(JSON.parse(result.configOptions[0].currentValue!)).toEqual({ key: null, alias: null, keyDigest: null, aliasDigest: null }); }
  finally { client.kill(); }
});
