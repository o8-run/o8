import { afterAll, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => { throw new Error('No attached MCP fixture'); } }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-acp-handshake-policy-'));
vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 113).toString('base64url'));
vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
const keys = await import('@/app/api/v2/keys/route'); const billing = await import('@/lib/providers/runtime-billing');
const { makeAcpBackend } = await import('@/lib/lane/orchestrator-backends/acp');
const request = (path: string, body: unknown, method = 'POST') => new NextRequest(`http://localhost/api/${path}`, { method, headers: { host: 'localhost' }, body: JSON.stringify(body) });
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(state.dir, { recursive: true, force: true }); });
it.each(['remove', 'subscription'])('rejects a first prompt after real API %s while ACP session creation waits', async action => {
  const dir = join(state.dir, action); mkdirSync(dir);
  const ready = join(dir, 'ready'); const release = join(dir, 'release'); const prompted = join(dir, 'prompted');
  const peer = `const fs=require('node:fs');const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}});else if(m.method==='session/new'){fs.writeFileSync(${JSON.stringify(ready)},'ready');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);send({jsonrpc:'2.0',id:m.id,result:{sessionId:'fixture'}});}},10);}else if(m.method==='session/prompt'){fs.writeFileSync(${JSON.stringify(prompted)},'prompt');send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}});}else if(m.id)send({jsonrpc:'2.0',id:m.id,result:{}});});`;
  expect(() => billing.saveRuntimeBillingMode('opencode', 'api')).not.toThrow();
  expect((await keys.POST(request('v2/keys', { provider: 'openai', key: 'fixture-handshake-provider' }))).status).toBe(200);
  const backend = makeAcpBackend({ id: 'opencode', label: 'Fixture', resolveLaunch: () => ({ command: process.execPath, args: ['-e', peer] }) });
  const events: OrchestratorEvent[] = [];
  const turn = backend.sendTurn(dir, 'Fixture', event => events.push(event), { threadId: action });
  try {
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 5_000 });
    if (action === 'remove') expect((await keys.DELETE(request('v2/keys', { provider: 'openai' }, 'DELETE'))).status).toBe(200);
    else billing.saveRuntimeBillingMode('opencode', 'subscription');
  } finally { writeFileSync(release, 'release'); }
  await turn;
  expect(existsSync(prompted)).toBe(false);
  expect(events.some(event => event.type === 'error' && /credentials or billing changed/i.test(event.error))).toBe(true);
});
