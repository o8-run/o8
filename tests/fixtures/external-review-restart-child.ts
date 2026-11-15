import { NextRequest } from 'next/server';
import { GET } from '@/lib/tasks/detail-route';
import { closeDb } from '@/lib/db';
import { getOrCreateWsToken } from '@/lib/ws-auth';

async function main() {
  const taskId = process.argv[2];
  const response = await GET(new NextRequest(`http://localhost/api/tasks/${taskId}`, {
    headers: { authorization: `Bearer ${getOrCreateWsToken()}` },
  }), { params: Promise.resolve({ taskId }) });
  if (!response.ok) throw new Error(`Cold task read failed: ${response.status}`);
  console.log(`RESTART_RESULT:${JSON.stringify(await response.json())}`);
  closeDb();
  process.exit(0);
}
void main().catch(() => { closeDb(); process.exit(1); });
