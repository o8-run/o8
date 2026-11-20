/** Owned, isolated classic route oracle. Fixed clock/UUID reproduce native-generated metadata. */
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
async function main() {
const root = process.env.CORTEX_IDE_DATA_DIR!;
if (readFileSync(join(root, 'fixture-owner'), 'utf8') !== 'o8d-native-read/v1') throw Error('Owned fixture required');
if (readFileSync(join(root, 'prompt-oracle-owner'), 'utf8') !== 'classic-only') throw Error('Isolated oracle profile required');
if (process.env.O8_API_FRONT_DOOR === '1') throw Error('Classic isolated oracle required');
const input = JSON.parse(readFileSync(join(root, 'prompt-oracle-input.json'), 'utf8'));
if (typeof input.now === 'number') Date.now = () => input.now;
if (typeof input.uuid === 'string') {
  crypto.randomUUID = () => input.uuid;
  syncBuiltinESMExports();
}
const rootRoute = await import('../../src/app/api/prompt-library/route');
const entryRoute = await import('../../src/app/api/prompt-library/[id]/route');
const useRoute = await import('../../src/app/api/prompt-library/[id]/use/route');
const id = input.path.split('/')[3]?.split('?')[0];
const req = new NextRequest('http://127.0.0.1:12345' + input.path, {
  method: input.method, headers: { host: '127.0.0.1:12345', 'content-type': 'application/json' },
  ...(input.method === 'POST' || input.method === 'PATCH' ? { body: JSON.stringify(input.body) } : {}),
});
const context = { params: Promise.resolve({ id }) };
const response = input.path === '/api/prompt-library' ? await rootRoute.POST(req)
  : input.path.endsWith('/use') ? await useRoute.POST(req, context)
  : input.method === 'PATCH' ? await entryRoute.PATCH(req, context) : await entryRoute.DELETE(req, context);
writeFileSync(join(root, 'prompt-oracle-output.json'), JSON.stringify({ status: response.status,
  type: response.headers.get('content-type'), cache: response.headers.get('cache-control'), body: await response.json() }));

}
void main().catch(error => { console.error("Prompt oracle failed", error instanceof Error ? error.stack : "unknown"); process.exitCode = 1; });
