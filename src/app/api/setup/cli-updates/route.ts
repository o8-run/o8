import { CliOperationRefusal } from '@/lib/setup/cli-operation-admission';
import { NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { CodexUpdateRefusal } from '@/lib/setup/codex-cli-update';
import { updateSelectedStableCli } from '@/lib/setup/stable-cli-update';
import { invalidateCliCache } from '@/lib/runtimes/shared/cli-resolver';
import { checkCliUpdates, CLI_UPDATE_RUNTIME_IDS } from '@/lib/setup/cli-updates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const refresh = params.get('refresh') === '1';
    const runtimeId = params.get('runtime') ?? undefined;
    if (runtimeId && !CLI_UPDATE_RUNTIME_IDS.includes(runtimeId)) return NextResponse.json({ error: 'Unknown CLI.' }, { status: 400 });
    if (refresh) {
      for (const id of runtimeId ? [runtimeId] : CLI_UPDATE_RUNTIME_IDS) invalidateCliCache(id);
    }
    if (request.headers.get('accept')?.includes('text/event-stream')) {
      const total = runtimeId ? 1 : CLI_UPDATE_RUNTIME_IDS.length;
      const encoder = new TextEncoder();
      let connected = true;
      let completed = 0;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let scheduled: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      const cleanup = () => {
        clearInterval(heartbeat); clearTimeout(scheduled);
        if (abort) request.signal.removeEventListener('abort', abort);
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (event: string, data: unknown) => {
            if (!connected) return;
            try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }
            catch { connected = false; cleanup(); }
          };
          const close = () => {
            cleanup();
            if (connected) { connected = false; controller.close(); }
          };
          abort = close;
          request.signal.addEventListener('abort', abort, { once: true });
          if (request.signal.aborted) { close(); return; }
          send('progress', { completed, total });
          heartbeat = setInterval(() => send('progress', { completed, total }), 1000);
          // Flush the response before potentially slow synchronous version probes.
          scheduled = setTimeout(() => {
            void checkCliUpdates(refresh, runtimeId, tool => send('tool', { tool, completed: ++completed, total }))
              .then(tools => send('result', { tools, checkedAt: new Date().toISOString() }))
              .catch(() => send('error', { error: 'Unable to check CLI updates.' }))
              .finally(close);
          }, 0);
        },
        cancel() { connected = false; cleanup(); },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
    }
    return NextResponse.json({ tools: await checkCliUpdates(refresh, runtimeId), checkedAt: new Date().toISOString() });
  } catch {
    return NextResponse.json({ error: 'Unable to check CLI updates.' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (resolveRequestPrincipal(request) !== 'operator') {
    return NextResponse.json({ code: 'operator-required', error: 'Only the operator can install a CLI update.' }, { status: 403 });
  }
  let runtimeId: import('@/lib/setup/cli-installation').StableCli = 'codex';
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'runtime')
      || ('runtime' in body && body.runtime !== 'codex' && body.runtime !== 'claude-code' && body.runtime !== 'grok' && body.runtime !== 'opencode' && body.runtime !== 'gemini')) {
      return NextResponse.json({ code: 'invalid-request', error: 'This action accepts no package, command, version, or path arguments.' }, { status: 400 });
    }
    if ('runtime' in body && body.runtime === 'claude-code') runtimeId = 'claude-code';
    if ('runtime' in body && body.runtime === 'grok') runtimeId = 'grok';
    if ('runtime' in body && body.runtime === 'opencode') runtimeId = 'opencode';
    if ('runtime' in body && body.runtime === 'gemini') runtimeId = 'gemini';
  } catch {
    return NextResponse.json({ code: 'invalid-request', error: 'Expected an empty object or a supported runtime.' }, { status: 400 });
  }
  if (request.headers.get('accept')?.includes('text/event-stream')) {
    const encoder = new TextEncoder(); let connected = true;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => { if (connected) { try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { connected = false; } } };
        try {
          const result = await updateSelectedStableCli(runtimeId, stage => send('progress', { runtime: runtimeId, stage }));
          send('result', result);
        } catch (error) {
          const refusal = (error instanceof CodexUpdateRefusal || error instanceof CliOperationRefusal) ? error : new CodexUpdateRefusal('update-failed', 'Unable to update this CLI.', 503);
          send('error', { code: refusal.code, error: refusal.message });
        } finally { if (connected) controller.close(); }
      },
      // Closing a view must not interrupt an installer halfway through writing.
      cancel() { connected = false; },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
  }
  try {
    return NextResponse.json(await updateSelectedStableCli(runtimeId));
  } catch (error) {
    const refusal = (error instanceof CodexUpdateRefusal || error instanceof CliOperationRefusal) ? error : new CodexUpdateRefusal('update-failed', 'Unable to update this CLI.', 503);
    return NextResponse.json({ code: refusal.code, error: refusal.message }, { status: refusal.status });
  }
}
