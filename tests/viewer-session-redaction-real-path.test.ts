import { viewerCredentialCorpus } from './fixtures/viewer-credential-corpus';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ home: '' }));
// Relocate the user-state boundary; the readers and persisted JSONL files are real.
vi.mock('os', async importOriginal => {
  const original = await importOriginal<typeof import('os')>();
  return { ...original, default: { ...original, homedir: () => fixture.home }, homedir: () => fixture.home };
});
let server: Server; let origin: string;
const authority = 'fixture-session-authority-' + 'z'.repeat(32);
beforeAll(async () => {
  fixture.home = mkdtempSync(join(tmpdir(), 'o8-viewer-session-'));
  const { WS_TOKEN_PATH } = await import('@/lib/ws-auth'); writeFileSync(WS_TOKEN_PATH, authority);
  const { handleNativeHttp } = await import('@/lib/ws-server/native-http-routes');
  server = createServer(async (req, res) => { if (!await handleNativeHttp(req, res)) res.writeHead(404).end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Listener did not bind');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(fixture.home, { recursive: true, force: true });
});

it.each(['patch', 'edit'])('withholds uncertified %s fragments from persisted session previews', async format => {
  const secret = 'fixture-unlabelled-fragment\n' + viewerCredentialCorpus.map(item => item.text).join('\n');
  let load: () => Promise<{ GET: (req: NextRequest) => Promise<Response> }>;
  if (format === 'patch') {
    const directory = join(fixture.home, '.codex', 'sessions', '2026', '01', '01'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'fixture.jsonl'), JSON.stringify({ payload: { type: 'custom_tool_call', name: 'apply_patch', input: `*** Begin Patch\n*** Update File: fixture.txt\n@@\n-old\n${secret.split('\n').map(line => '+' + line).join('\n')}\n*** End Patch` } }));
    load = () => import('@/app/api/codex/diffs/route');
  } else {
    const directory = join(fixture.home, '.claude', 'projects', 'fixture'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'fixture.jsonl'), JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'fixture.txt', old_string: 'old', new_string: secret } }] } }));
    load = () => import('@/app/api/claude-code/diffs/route');
  }
  const route = format === 'patch' ? '/api/codex/diffs' : '/api/claude-code/diffs';
  const req = new NextRequest(`${origin}${route}?limit=20`, { headers: { authorization: `Bearer ${authority}` } });
  for (const response of [await (await load()).GET(req), await fetch(req)]) {
    expect(response.status).toBe(200);
    const body = await response.json(); expect(body.diffs).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('fixture-unlabelled-fragment');
    for (const item of viewerCredentialCorpus) expect(JSON.stringify(body)).not.toContain(item.clear);
    expect(body.redaction.spans).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/diffs/0/newText', kind: 'credential' })]));
  }
});
