import Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
import { firstDifference, seedSessionFixture, startSessionServer } from '../scripts/o8d/parity';

const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? join(targetDir, 'debug', 'o8d');
beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['test', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', targetDir, '--test', 'prompt_library_reads']);
}, 900_000);
const route = '/api/prompt-library';
const repoA = '/not-registered/prompt-fixture-a';
const repoB = '/not-registered/prompt-fixture-b';
const pathFor = (params: Record<string, string> = {}) => route + '?' + new URLSearchParams(params);
async function snapshot(response: Response) {
  return { status: response.status, type: response.headers.get('content-type'), cache: response.headers.get('cache-control'), body: await response.json() as Record<string, unknown> };
}
// Unsupported GET framing reaches the canonical TS producer on the same public
// socket, permitting fresh error parity without a second writer or a Next server.
async function typescript(origin: string, token: string, path: string) {
  return new Promise<Awaited<ReturnType<typeof snapshot>>>((resolve, reject) => {
    const request = httpRequest(origin + path, { method: 'GET', headers: { authorization: `Bearer ${token}`, 'transfer-encoding': 'chunked' } }, response => {
      expect(response.headers['x-o8d-native']).toBeUndefined();
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ status: response.statusCode!, type: response.headers['content-type'] ?? null, cache: response.headers['cache-control'] ?? null, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      response.once('error', reject);
    });
    request.once('error', reject); request.end();
  });
}

it.skipIf(process.platform !== 'linux')('lists saved prompts through the public socket with exact SQL, validation, row mapping and POST passthrough', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-prompt-library-')));
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  const database = join(directory, 'cortex-ide.db');
  try {
    await seedSessionFixture(directory);
    const token = readFileSync(join(directory, 'ws-token'), 'utf8').trim();
    const db = new Database(database);
    try {
      const insert = db.prepare(`INSERT INTO prompt_library (id,title,body,body_fingerprint,tags_json,scope,repo_path,source_kind,source_id,created_at,updated_at,last_used_at,use_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const add = (id: string, title: string, body: string, tags = '[]', scope = 'global', repo: string | null = null, updated = 100, used: number | null = null, kind = 'manual', source: string | null = null) => insert.run(id,title,body,createHash('sha256').update(id).digest('hex'),tags,scope,repo,kind,source,100,updated,used,used ? 3 : 0);
      db.transaction(() => {
        add('global-used', 'Literal credential', 'alpha beta\n' + token, '["primary"]', 'global', null, 200, 500);
        add('repo-a', 'Repo A', 'alpha work', '["repo"]', 'repo', repoA, 300, null, 'automation', 'automation-fixture');
        add('repo-b', 'Repo B', 'other work', '[]', 'repo', repoB, 400);
        add('tie-z', 'Tie earlier', 'tie text', '[]', 'global', null, 200);
        add('tie-a', 'Tie later', 'tie text', '[]', 'global', null, 200);
        add('tags-object', 'Object tags', 'object tags', '{"ignored":true}', 'global', null, 110);
        add('tags-mixed', 'Mixed tags', 'mixed tags', '[" Café ",4,null,false,{"x":"y"},"keep","keep"]', 'global', null, 110);
        add('accent-lower', 'café', 'lower accent', '[]', 'global', null, 120);
        add('accent-upper', 'CAFÉ', 'upper accent', '[]', 'global', null, 130);
        add('wildcard', 'Literal pattern', 'literal 100%_\\ value');
        add('eight', 'Terms', 'one two three four five six seven eight');
        add('nel', 'alpha\u0085beta', 'non-whitespace separator');
        for (let index = 0; index < 103; index++) add('bulk-' + index, 'Bulk ' + index, 'bulk text');
      })();
    } finally { db.close(); }
    const params: Record<string, string>[] = [ {}, { scope: 'all', limit: '100' }, { scope: 'global' }, { scope: 'repo', repoPath: repoA }, { scope: 'available', repoPath: ' \ufeff' + repoA + '\u00a0 ' }, { scope: 'repo', repoPath: repoB },
      { query: 'alpha beta' }, { query: 'CAFÉ' }, { query: '%_\\' }, { query: 'ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT ABSENT' }, { query: 'alpha\u0085beta' }, { query: 'tie' }, { query: 'mixed tags' }, { query: 'object tags' },
      { query: 'bulk' }, { query: 'bulk', limit: '1000' }, { query: 'bulk', limit: '2.5' }, { query: 'bulk', limit: '3suffix' }, { query: 'bulk', limit: ' \ufeff+2' }, { query: 'bulk', limit: '9'.repeat(100) },
      { scope: 'unknown' }, { limit: '0' }, { limit: 'bad' }, { limit: '9'.repeat(309) }, { query: 'x'.repeat(201) }, { scope: 'repo' }, { scope: 'repo', query: 'x'.repeat(201) }, { query: '😀'.repeat(100) }, { query: '😀'.repeat(101) },
    ];
    const cases = params.map(pathFor);
    const reference = await startParityReference({ directory, nativeHttp: true, o8d: false }); await reference.stopNext();
    server = { ...reference, origin: reference.url.replace('ws:', 'http:').replace('/ws', '') };
    const call = (path: string, bearer = token) => fetch(server!.origin + path, { headers: { authorization: `Bearer ${bearer}` } });
    const expected = [];
    for (const path of cases) expected.push(await snapshot(await call(path)));
    expect((expected[0].body.prompts as { id: string }[])[0].id).toBe('global-used');
    expect((expected[11].body.prompts as { id: string }[]).map(row => row.id)).toEqual(['tie-a', 'tie-z']);
    expect((expected[14].body.prompts as unknown[]).length).toBe(50); expect((expected[15].body.prompts as unknown[]).length).toBe(100);
    expect((expected[16].body.prompts as unknown[]).length).toBe(2);
    expect(expected[20].body).toMatchObject({ error: { code: 'invalid_scope_filter' } }); expect(expected[21].body).toMatchObject({ error: { code: 'invalid_limit' } });
    expect(expected[24].body).toMatchObject({ error: { code: 'query_too_long' } }); expect(expected[25].body).toMatchObject({ error: { code: 'repo_path_required' } });
    const denied = await snapshot(await call(route, '')); expect(denied.status).toBe(401);
    const postBody = { title: 'Created through WS', body: 'POST café\n100%_\\ " literal\n' + token, tags: [' one ', 'one', 'two'], scope: 'global', repoPath: null };
    const post = () => fetch(server!.origin + route, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(postBody) });
    const expectedPost = await snapshot(await post()); expect(expectedPost.status).toBe(201);
    const recordedPrompt = expectedPost.body.prompt as Record<string, unknown>;
    const cleanup = new Database(database); try { cleanup.prepare('DELETE FROM prompt_library WHERE id = ?').run(recordedPrompt.id); } finally { cleanup.close(); }
    const singlePath = route + '/global-used'; const single = await snapshot(await call(singlePath));
    await server.stop(); server = undefined;
    const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const stderrPath = join(directory, 'daemon-stderr'); const wrapper = join(directory, 'capture-o8d');
    writeFileSync(wrapper, '#!/bin/sh\nexec ' + quote(binary) + ' "$@" 2>' + quote(stderrPath) + '\n', { mode: 0o700 });
    server = await startSessionServer(directory, false, wrapper);
    for (const [index, path] of cases.entries()) {
      const response = await call(path);
      expect(response.headers.get('x-o8d-native'), 'Native route was not reached: ' + path).toBe('1');
      expect(firstDifference(expected[index], await snapshot(response)), path).toBeNull();
    }
    const refusal = await call(route, ''); expect(refusal.headers.get('x-o8d-native')).toBeNull(); expect(await snapshot(refusal)).toEqual(denied);
    const retained = await call(singlePath); expect(retained.headers.get('x-o8d-native')).toBeNull(); expect(await snapshot(retained)).toEqual(single);
    const written = await post(); expect(written.headers.get('x-o8d-native')).toBeNull(); const actualPost = await snapshot(written);
    const created = actualPost.body.prompt as Record<string, unknown>;
    const stable = (value: Awaited<ReturnType<typeof snapshot>>) => ({ ...value, body: { ...value.body, prompt: { ...(value.body.prompt as object), id: '<id>', createdAt: 0, updatedAt: 0 } } });
    expect(stable(actualPost)).toEqual(stable(expectedPost)); expect(created.id).toMatch(/^prompt-/); expect(created.createdAt).toBeTypeOf('number');
    const persisted = new Database(database); try { expect(persisted.prepare('SELECT body FROM prompt_library WHERE id = ?').get(created.id)).toEqual({ body: postBody.body }); } finally { persisted.close(); }
    const fresh = await call(pathFor({ query: 'Created through WS' })); expect(fresh.headers.get('x-o8d-native')).toBe('1'); expect((await fresh.json()).prompts[0].id).toBe(created.id);
    const mutate = (sql: string) => { const connection = new Database(database); try { connection.exec(sql); } finally { connection.close(); } };
    const compareFallback = async (path: string) => {
      const oracle = await typescript(server!.origin, token, path); const response = await call(path);
      expect(response.headers.get('x-o8d-native')).toBeNull(); expect(await snapshot(response)).toEqual(oracle);
    };
    mutate("UPDATE prompt_library SET tags_json = '{broken' WHERE id = 'tags-mixed'");
    await compareFallback(pathFor({ query: 'mixed tags' }));
    mutate("UPDATE prompt_library SET tags_json = '[]' WHERE id = 'tags-mixed'");
    mutate('ALTER TABLE prompt_library RENAME COLUMN body_fingerprint TO unavailable_fingerprint');
    try { await compareFallback(pathFor({ query: 'bulk' })); } finally { mutate('ALTER TABLE prompt_library RENAME COLUMN unavailable_fingerprint TO body_fingerprint'); }
    mutate('ALTER TABLE prompt_library RENAME TO unavailable_prompt_library');
    try { await compareFallback(route); } finally { mutate('ALTER TABLE unavailable_prompt_library RENAME TO prompt_library'); }
    expect(readFileSync(stderrPath, 'utf8') + readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8')).not.toContain(token);
    await server.stop(); server = undefined;
    const missingDb = join(directory, 'missing-reader.sqlite');
    writeFileSync(wrapper, '#!/bin/sh\nexport O8D_SESSION_DB_PATH=' + quote(missingDb) + '\nexec ' + quote(binary) + ' "$@" 2>' + quote(stderrPath) + '\n', { mode: 0o700 });
    server = await startSessionServer(directory, false, wrapper); await compareFallback(pathFor({ query: 'bulk' })); expect(existsSync(missingDb)).toBe(false);
    expect(readFileSync(stderrPath, 'utf8') + readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8')).not.toContain(token);
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);
