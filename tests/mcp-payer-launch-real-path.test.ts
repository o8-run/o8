import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { NextRequest } from 'next/server';

const root = mkdtempSync(join(tmpdir(), 'o8-mcp-payer-'));
const saved = 'fixture-mcp-payer-secret';
vi.stubEnv('O8_MASTER_KEY', Buffer.alloc(32, 81).toString('base64url'));
vi.stubEnv('ANTHROPIC_API_KEY', '');
vi.stubEnv('NPM_TOKEN', saved);
const keys = await import('@/app/api/v2/keys/route');
const billing = await import('@/app/api/runtime/billing/route');
const servers = await import('@/lib/mcp/external-servers');
const { getSymonMcpCatalog } = await import('@/lib/mcp/symon-tools');
const { testMcpConnection } = await import('@/lib/mcp/test-connection');
const { closeDb } = await import('@/lib/db');
const request = (path: string, body: unknown) => new NextRequest(`http://localhost/api/${path}`, {
  method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify(body),
});
const record = join(root, 'receipt.json');
const binary = join(root, 'claude');
writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  key: !!process.env.ANTHROPIC_API_KEY,
  alias: !!process.env.NPM_TOKEN,
  argv: process.argv.slice(2),
}));
const send = m => console.log(JSON.stringify(m));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (!m.id) return;
  if (m.method === 'tools/list') {
    if (process.env.FIXTURE_FAIL) {
      console.error(process.env.ANTHROPIC_API_KEY || 'no key');
      send({ id: m.id, error: { code: -1, message: process.env.ANTHROPIC_API_KEY || 'no key' } });
    } else send({ id: m.id, result: { tools: [{ name: 'fixture', inputSchema: {} }] } });
  } else send({ id: m.id, result: {} });
});
`, { mode: 0o755 });

beforeEach(async () => {
  for (const server of servers.listExternalMcpServers()) servers.removeExternalMcpServer(server.id);
  const validation = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}));
  try { expect((await keys.POST(request('v2/keys', { provider: 'anthropic', key: saved }))).status).toBe(200); }
  finally { validation.mockRestore(); }
});
afterAll(() => {
  for (const server of servers.listExternalMcpServers()) servers.removeExternalMcpServer(server.id);
  closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

it.each(['subscription', 'api'])('configured CLI discovery applies persisted %s billing', async mode => {
  expect((await billing.POST(request('runtime/billing', { runtimeId: 'claude-code', mode }))).status).toBe(200);
  servers.insertExternalMcpServer({ name: 'payer', transport: 'stdio', command: binary,
    args: ['mcp', 'serve'], enabled: true, symonInjection: true });
  const catalog = await getSymonMcpCatalog({ refresh: true });
  expect(catalog.tools).toHaveLength(1);
  expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ key: mode === 'api', alias: false, argv: ['mcp', 'serve'] });
  expect(JSON.stringify(catalog).includes(saved)).toBe(false);
});

it.each(['subscription', 'api'])('connection probe applies persisted %s billing and redacts failure output', async mode => {
  expect((await billing.POST(request('runtime/billing', { runtimeId: 'claude-code', mode }))).status).toBe(200);
  const result = await testMcpConnection({ transport: 'stdio', command: binary, args: ['mcp', 'serve'], env: { FIXTURE_FAIL: '1' } });
  expect(result.ok).toBe(false);
  expect(JSON.parse(readFileSync(record, 'utf8')).key).toBe(mode === 'api');
  expect(JSON.stringify(result).includes(saved)).toBe(false);
});

it.each(['subscription', 'api'])('generic configured stdio servers stay credential-free under %s billing', async mode => {
  expect((await billing.POST(request('runtime/billing', { runtimeId: 'claude-code', mode }))).status).toBe(200);
  servers.insertExternalMcpServer({ name: 'generic', transport: 'stdio', command: process.execPath,
    args: [binary], env: { SERVICE_AUTH: 'fixture-service' }, enabled: true, symonInjection: true });
  expect((await getSymonMcpCatalog({ refresh: true })).tools).toHaveLength(1);
  const receipt = JSON.parse(readFileSync(record, 'utf8'));
  expect(receipt.key).toBe(false); expect(receipt.alias).toBe(false);
});

it.each(['unicode', 'split'])('refuses %s credential configuration before dispatch', async kind => {
  await billing.POST(request('runtime/billing', { runtimeId: 'claude-code', mode: 'subscription' }));
  rmSync(record, { force: true });
  const value = kind === 'unicode'
    ? `"${[...saved].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}"`
    : JSON.stringify([saved.slice(0, 10), saved.slice(10)]);
  const result = await testMcpConnection({ transport: 'stdio', command: binary, args: ['-c', `mcp_servers.fixture.args=${value}`] });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result).includes(saved)).toBe(false);
  expect(() => readFileSync(record)).toThrow();
});

it.each(['', '%'])('refuses encoded saved credentials with unrelated URL noise %s before network dispatch', async noise => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ result: { tools: [] } }));
  try {
    const encoded = [...saved].map(char => `%${char.charCodeAt(0).toString(16)}`).join('');
    const result = await testMcpConnection({ transport: 'http', url: `http://localhost/mcp?noise=${noise}&auth=${encoded}` });
    expect(result.ok).toBe(false); expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result).includes(saved)).toBe(false);
  } finally { fetch.mockRestore(); }
});


it.each(['subscription', 'api'])('configured HTTP discovery scrubs decoded SSE output under %s billing', async mode => {
  await billing.POST(request('runtime/billing', { runtimeId: 'claude-code', mode }));
  const http = createServer(async (incoming, response) => {
    let raw = ''; for await (const chunk of incoming) raw += String(chunk);
    const message = JSON.parse(raw);
    if (!message.id) { response.writeHead(202).end(); return; }
    const payload = JSON.stringify({ id: message.id, result: message.method === 'tools/list'
      ? { tools: [{ name: 'fixture', description: saved, inputSchema: {} }] } : {} });
    const escaped = payload.replace(saved, [...saved].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
    response.setHeader('content-type', 'text/event-stream'); response.end(`data: ${escaped}\n\n`);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  servers.insertExternalMcpServer({ name: 'http', transport: 'http', command: url, enabled: true, symonInjection: true });
  try {
    const catalog = await getSymonMcpCatalog({ refresh: true });
    expect(catalog.tools).toHaveLength(1);
    expect(JSON.stringify(catalog).includes(saved)).toBe(false);
    const probe = await testMcpConnection({ transport: 'http', url });
    expect(probe.ok).toBe(true); expect(JSON.stringify(probe).includes(saved)).toBe(false);
  } finally { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); }
});
