import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
async function main() {
  const root = process.env.CORTEX_IDE_DATA_DIR!;
  if (readFileSync(join(root, 'session-rule-oracle-owner'), 'utf8') !== 'classic-only' || process.env.O8_API_FRONT_DOOR === '1') throw Error('Isolated classic oracle required');
  const input = JSON.parse(readFileSync(join(root, 'session-rule-oracle-input.json'), 'utf8'));
  if (input.rule) { crypto.randomUUID = () => input.rule.id; syncBuiltinESMExports(); }
  const { getSqlite } = await import('../../src/lib/db');
  const db = getSqlite(); if (input.rule) db.function('datetime', (_value: string) => input.rule.createdAt);
  const handler = await import('../../src/app/api/orchestrator/session-rules/route');
  const request = new NextRequest('http://localhost:12345/api/orchestrator/session-rules' + (input.query ?? ''), { method: input.method,
    headers: { host: 'localhost:12345', authorization: 'Bearer ' + readFileSync(join(root, 'ws-token'), 'utf8').trim(), 'content-type': 'application/json' },
    ...(input.method === 'POST' ? { body: JSON.stringify(input.body) } : {}) });
  const response = input.method === 'POST' ? await handler.POST(request) : await handler.DELETE(request);
  writeFileSync(join(root, 'session-rule-oracle-output.json'), JSON.stringify({ status: response.status, cache: response.headers.get('cache-control'), type: response.headers.get('content-type'), body: await response.json() }));
}
void main().catch(error => { console.error(error instanceof Error ? error.stack : 'Oracle failed'); process.exitCode = 1; });
