import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import { requirePanelAuth } from '@/lib/panel/auth';
import { ActionPluginError, actionReceipts, changeActionPlugin, clearActionPluginState, invokeActionPlugin, linkActionSource, listActionPlugins, reviewActionSource } from '@/lib/action-plugins/host';
import { readCustomizeBody } from '@/lib/customize/http';
import { CustomizeError } from '@/lib/customize/storage';
import { reviewGithubActionSource } from '@/lib/action-plugins/github-source';
import { githubSourceSchema } from '@/lib/action-plugins/source-storage';
import { launchPluginTerminal, pluginTerminalReceipts, stopPluginTerminalRun } from '@/lib/action-plugins/host';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('review'), directory: z.string().min(1), repo: z.string().optional() }).strict(),
  githubSourceSchema.omit({ kind: true }).extend({ action: z.literal('review-github'), repo: z.string().optional() }).strict(),
  z.object({ action: z.literal('link'), directory: z.string().min(1), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), repo: z.string().optional() }).strict(),
  z.object({ action: z.literal('invoke'), id: z.string(), actionId: z.string(), revision: z.string(), repo: z.string().optional() }).strict(),
  z.object({ action: z.enum(['enable', 'disable', 'remove']), id: z.string(), revision: z.string() }).strict(),
  z.object({ action: z.literal('clear-state'), id: z.string(), revision: z.string(), confirmed: z.literal(true) }).strict(),
  z.object({ action: z.literal('launch-terminal'), id: z.string(), terminalId: z.string(), revision: z.string().regex(/^[a-f0-9]{64}$/), requestId: z.string().uuid(), repo: z.string().optional() }).strict(),
  z.object({ action: z.literal('stop-terminal'), receiptId: z.string().uuid() }).strict(),
]);

function failure(error: unknown) {
  if (error instanceof ActionPluginError || error instanceof CustomizeError) return NextResponse.json({ ok: false, error: { code: error.code, message: error.message } }, { status: error.status });
  if (error instanceof ZodError || error instanceof SyntaxError) return NextResponse.json({ ok: false, error: { code: 'invalid_input', message: 'Check the action manifest and required fields.' } }, { status: 400 });
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return NextResponse.json({ ok: false, error: { code: 'not_found', message: 'The selected local file or installation no longer exists.' } }, { status: 404 });
  return NextResponse.json({ ok: false, error: { code: 'action_error', message: 'Could not complete this local action operation.' } }, { status: 500 });
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  try {
    const plugin = request.nextUrl.searchParams.get('plugin');
    return NextResponse.json({ ok: true, ...listActionPlugins(), receipts: actionReceipts(plugin ?? undefined), terminals: pluginTerminalReceipts(plugin ?? undefined) });
  }
  catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  // Reviewing, linking and invoking run local code. The CLI calls this as a plain
  // loopback request, so refuse the credentials that name someone else.
  const { role } = resolveRequestPrincipalContext(request);
  if (role !== 'operator' && role !== 'anonymous') {
    return NextResponse.json({ ok: false, error: 'operator_required' }, { status: 403 });
  }
  try {
    const input = inputSchema.parse(await readCustomizeBody(request));
    if (input.action === 'review') return NextResponse.json({ ok: true, review: await reviewActionSource(input.directory, input.repo, request.signal) });
    if (input.action === 'review-github') return NextResponse.json({ ok: true, review: await reviewGithubActionSource({ kind: 'github', repository: input.repository, commit: input.commit, directory: input.directory }, input.repo, request.signal) });
    if (input.action === 'link') return NextResponse.json({ ok: true, installed: await linkActionSource(input.directory, input.expectedRevision, input.repo, request.signal) });
    if (input.action === 'invoke') return NextResponse.json({ ok: true, receipt: await invokeActionPlugin(input.id, input.actionId, 'local-operator', request.signal, input.revision, input.repo) });
    if (input.action === 'clear-state') return NextResponse.json({ ok: true, ...clearActionPluginState(input.id, input.revision) });
    if (input.action === 'launch-terminal') return NextResponse.json({ ok: true, terminal: await launchPluginTerminal(input) });
    if (input.action === 'stop-terminal') return NextResponse.json({ ok: true, terminal: stopPluginTerminalRun(input.receiptId) });
    return NextResponse.json({ ok: true, ...changeActionPlugin(input.id, input.revision, input.action) });
  } catch (error) { return failure(error); }
}
