import { NextRequest } from 'next/server';
import { GET, POST as resolveApproval } from '@/lib/approvals/route';
import { forwardRuntimeApproval, isRuntimeApprovalRequest } from '@/lib/approvals/runtime-owner';

export { GET };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (process.env.O8_NEXT_O8D === '1') {
    const body = await request.clone().json().catch(() => null);
    if (((body?.action === 'approve' || body?.action === 'reject') && body?.terminalAdapter !== undefined) || isRuntimeApprovalRequest(body)) return forwardRuntimeApproval(request, body);
  }
  return resolveApproval(request);
}
