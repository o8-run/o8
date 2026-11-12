import { bindDesktopAccount, requireDesktopAccount } from '@/lib/auth/desktop-account';
import { getChatGPTPlanService } from '@/lib/chatgpt-plan/service';
import { ChatGPTPlanError } from '@/lib/chatgpt-plan/types';

export const dynamic = 'force-dynamic';

function failure(error: unknown): Response {
  const known = error instanceof ChatGPTPlanError ? error : new ChatGPTPlanError('connection_failed', 'The ChatGPT connection could not be updated.', 503);
  return Response.json({ error: known.message, code: known.code }, { status: known.status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request): Promise<Response> {
  try {
    const owner = await requireDesktopAccount(request);
    const attemptId = new URL(request.url).searchParams.get('attemptId');
    const data = attemptId ? await getChatGPTPlanService().attemptStatus(owner, attemptId) : await getChatGPTPlanService().status(owner);
    return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['action', 'accountId', 'attemptId'].includes(key))
      || (body.accountId !== undefined && typeof body.accountId !== 'string')
      || (body.attemptId !== undefined && typeof body.attemptId !== 'string')) {
      throw new ChatGPTPlanError('invalid_request', 'Choose a valid ChatGPT connection action.', 400);
    }
    if (body.action === 'bind') { await bindDesktopAccount(request); return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } }); }
    const owner = await requireDesktopAccount(request);
    const service = getChatGPTPlanService();
    if (body.action === 'start') return Response.json(await service.start(owner, body.accountId), { headers: { 'Cache-Control': 'no-store' } });
    if (body.action === 'finish' && body.attemptId) await service.finish(owner, body.attemptId);
    else if (body.action === 'select' && body.accountId) await service.select(owner, body.accountId);
    else if (body.action === 'welcome') await service.welcome(owner);
    else throw new ChatGPTPlanError('invalid_request', 'Choose a valid ChatGPT connection action.', 400);
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const owner = await requireDesktopAccount(request);
    const accountId = new URL(request.url).searchParams.get('accountId') || undefined;
    return Response.json(await getChatGPTPlanService().disconnect(owner, accountId), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error); }
}
