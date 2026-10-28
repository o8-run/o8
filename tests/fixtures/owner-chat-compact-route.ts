import { writeFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { POST } from '../../src/app/api/orchestrator/compact/route';
import { closeDb } from '../../src/lib/db';

async function main() {
  const [repoPath, threadId, resultPath] = process.argv.slice(2);
  const response = await POST(new NextRequest('http://localhost/api/orchestrator/compact', {
    method: 'POST', headers: { host: 'localhost' },
    body: JSON.stringify({ repoPath, threadId, keepTailCount: 2, trigger: 'manual' }),
  }));
  writeFileSync(resultPath, JSON.stringify({ status: response.status, ...await response.json() }));
}
void main().finally(() => closeDb());
