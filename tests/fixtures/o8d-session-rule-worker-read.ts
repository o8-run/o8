import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { GET } from '../../src/app/api/orchestrator/session-rules/route';
async function main() {
  const root = process.env.CORTEX_IDE_DATA_DIR!;
  if (readFileSync(join(root, 'fixture-owner'), 'utf8') !== 'o8d-native-read/v1') throw Error('Isolated fixture required');
  const worker = readFileSync(join(root, 'session-rule-worker-token'), 'utf8');
  const replies = [];
  for (const query of ['?threadId=thoughts-review', '?threadId=thoughts-other', '']) {
    const response = await GET(new NextRequest('http://localhost/api/orchestrator/session-rules' + query, { headers: { host: 'localhost', authorization: 'Bearer ' + worker } }));
    replies.push({ status: response.status, body: await response.json() });
  }
  writeFileSync(join(root, 'session-rule-worker-replies.json'), JSON.stringify(replies));
}
void main().catch(() => { console.error('Isolated worker route proof failed'); process.exitCode = 1; });
