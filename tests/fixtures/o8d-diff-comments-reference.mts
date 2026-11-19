import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { createRequire } from 'node:module';
const root = process.env.CORTEX_IDE_DATA_DIR!;
if (readFileSync(join(root, 'fixture-owner'), 'utf8') !== 'o8d-native-read/v1') throw Error('Owned fixture required');
const require = createRequire(import.meta.url);
const { getSqlite } = require('../../src/lib/db') as typeof import('../../src/lib/db');
const { createDiffComment, resolveDiffComment } = require('../../src/lib/mobile/diff-comments') as typeof import('../../src/lib/mobile/diff-comments');
if (process.argv.includes('--classic')) {
  const created = createDiffComment({ sessionKey: 'fixture-session', path: 'classic.ts', lineNumber: 1, side: 'old', text: 'classic note' });
  if (!created || !resolveDiffComment(created.id)) throw Error('Classic comment write failed');
}
let fenced: unknown;
if (process.argv.includes('--check-writers')) {
  const errors: string[] = [];
  const before = getSqlite().prepare('SELECT count(*) n FROM mobile_diff_comments').get();
  for (const write of [() => createDiffComment({ sessionKey: 'fixture-session', path: 'blocked.ts', lineNumber: 1, side: 'new', text: 'must not write' }), () => resolveDiffComment('fixture-id')]) {
    try { write(); errors.push('not refused'); } catch (error) { errors.push(error instanceof Error ? error.message : 'unknown'); }
  }
  fenced = { errors, before, after: getSqlite().prepare('SELECT count(*) n FROM mobile_diff_comments').get() };
}
const { GET } = require('../../src/app/api/mobile/diff-comments/route') as typeof import('../../src/app/api/mobile/diff-comments/route');
const response = await GET(new NextRequest('http://127.0.0.1/api/mobile/diff-comments?sessionKey=fixture-session'));
writeFileSync(process.argv[2], JSON.stringify({ status: response.status, body: await response.json(), ...(fenced ? { fenced } : {}) }));
