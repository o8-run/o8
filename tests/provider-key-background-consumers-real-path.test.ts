import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
const state = vi.hoisted(() => ({ dir: '', binary: '', record: '' }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir, migrateDataDirOnce: () => {} }));
vi.mock('@/lib/runtimes/shared/cli-resolver', () => ({ resolveCli: async () => ({ path: state.binary, version: '0.140.0' }) }));
vi.mock('@/lib/orchestrator/compaction-scorer', () => ({ scoreCompactionSegment: async () => null }));
state.dir = mkdtempSync(join(tmpdir(), 'o8-background-credentials-'));
state.binary = join(state.dir, 'fixture-codex'); state.record = join(state.dir, 'observed.json');
writeFileSync(state.binary, `#!/usr/bin/env node
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(state.record)},JSON.stringify({key:process.env.OPENAI_API_KEY||null,alias:process.env.CODEX_API_KEY||null,copy:process.env.LOGIN_PROVIDER_COPY||null}));
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
if(process.argv.includes('app-server'))require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)send({id:m.id,result:m.method==='model/list'?{data:[]}:{config:{}}});});
else {send({type:'item.completed',item:{type:'agent_message',text:'Fixture summary'}});send({type:'turn.completed',usage:{input_tokens:2,output_tokens:2}});}
`); chmodSync(state.binary, 0o755);
const keys = await import('@/app/api/v2/keys/route');
const billing = await import('@/app/api/runtime/billing/route');
const { digest, autoCompactOrchestratorThread } = await import('@/lib/orchestrator/auto-compact');
const { getCodexSpeedCatalogue } = await import('@/lib/codex/service-tier-catalogue');
const request = (path: string, body: unknown, method = 'POST') => new NextRequest(`http://localhost/api/${path}`, { method, headers: { host: 'localhost' }, body: JSON.stringify(body) });
beforeEach(() => {
  writeFileSync(join(state.dir, '.env.local'), ''); rmSync(join(state.dir, 'runtime-billing'), { force: true, recursive: true });
  vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 91).toString('base64url'));
  for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'LOGIN_PROVIDER_COPY']) vi.stubEnv(name, 'fixture-login-provider');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: {} })));
});
afterAll(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(state.dir, { force: true, recursive: true }); });
it.each(['digest', 'compact', 'catalogue'].flatMap(target => ['subscription', 'api', 'disable', 'remove'].map(action => [target, action])))('%s obeys %s for saved and matching login credentials', async (target, action) => {
  expect((await billing.POST(request('runtime/billing', { runtimeId: 'codex', mode: action === 'subscription' ? 'subscription' : 'api' }))).status).toBe(action === 'subscription' ? 200 : 409);
  expect((await keys.POST(request('v2/keys', { provider: 'openai', key: 'fixture-login-provider' }))).status).toBe(200);
  if (action === 'disable') expect((await keys.PATCH(request('v2/keys', { provider: 'openai', enabled: false }, 'PATCH'))).status).toBe(200);
  if (action === 'remove') expect((await keys.DELETE(request('v2/keys', { provider: 'openai' }, 'DELETE'))).status).toBe(200);
  if (target === 'digest') await digest('Fixture material', state.dir);
  else if (target === 'catalogue') await getCodexSpeedCatalogue(join(state.dir, `catalogue-${action}`));
  else {
    const threadId = `thoughts-credential-${action}`;
    mkdirSync(join(state.dir, 'chat-history'), { recursive: true });
    writeFileSync(join(state.dir, 'chat-history', `${threadId}.json`), JSON.stringify({ repoPath: state.dir, messages: Array.from({ length: 6 }, (_, i) => ({ id: String(i), role: i % 2 ? 'assistant' : 'user', content: 'Fixture turn' })) }));
    expect((await autoCompactOrchestratorThread({ repoPath: state.dir, threadId, keepTailCount: 2, force: true })).applied).toBe(true);
  }
  const seen = JSON.parse(readFileSync(state.record, 'utf8'));
  expect(seen).toEqual({ key: null, alias: null, copy: null });
});

it('the native worker identity probe filters saved and inherited provider credentials at its real child entry point', async () => {
  expect((await keys.POST(request('v2/keys', { provider: 'openai', key: 'fixture-login-provider' }))).status).toBe(200);
  const helper = join(state.dir, 'fixture-identity');
  writeFileSync(helper, `#!/usr/bin/env node
const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(state.record)},JSON.stringify({key:!!process.env.OPENAI_API_KEY,alias:!!process.env.CODEX_API_KEY,copy:!!process.env.LOGIN_PROVIDER_COPY,master:!!process.env.O8_MASTER_KEY,service:process.env.BRAVE_API_KEY}));
process.stdout.write(JSON.stringify({version:1,platform:'darwin',bootId:'fixture-boot',startId:'kernel:1:000001'}));
`); chmodSync(helper, 0o755);
  vi.stubEnv('O8_PI_WRITE_BIN', helper); vi.stubEnv('BRAVE_API_KEY', 'fixture-search-service');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    // Select the native branch on every runner; the executable and child environment are real.
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { probeOwnedProcessIdentity } = await import('@/lib/runtimes/shared/owned-session/process-identity');
    expect(await probeOwnedProcessIdentity(process.pid, 'native-helper')).toMatchObject({ state: 'live', source: 'native-helper' });
    expect(JSON.parse(readFileSync(state.record, 'utf8'))).toEqual({ key: false, alias: false, copy: false, master: false, service: undefined });
  } finally { Object.defineProperty(process, 'platform', platform); }
});
