import { NextRequest } from 'next/server';
import { GET } from '../../src/app/api/repos/[id]/integration-queue/route';
import { getOrCreateWsToken } from '../../src/lib/ws-auth';
import { closeDb } from '../../src/lib/db';

async function main() {
  const id = process.argv[2];
  const response = await GET(new NextRequest(`http://localhost/api/repos/${id}/integration-queue`, {
    headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
  }), { params: Promise.resolve({ id }) });
  console.log(`[integration-queue] QUEUE_RESTART_RESULT:${JSON.stringify({ status: response.status, body: await response.json() })}`);
  closeDb();
  process.exit(0);
}
void main().catch(() => { closeDb(); process.exit(1); });
