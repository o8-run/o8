import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { AcpEnvironmentConflict } from '@/lib/acp/connection-environment';
import {
  bindThreadProviderInstance, createProviderInstance, deleteProviderInstance, HOME_SELECTORS,
  listProviderInstances, readInstanceEnvironment, saveInstanceEnvironment, threadProviderInstance, updateProviderInstance,
} from '@/lib/providers/instances';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Instances with their env inventory; secret values are never returned. */
function inventory() {
  return listProviderInstances().map(instance => {
    let environment = null;
    try { environment = readInstanceEnvironment(instance.id); } catch { /* unavailable store: the editor retries */ }
    return { ...instance, environment };
  });
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  const thread = request.nextUrl.searchParams.get('thread');
  return NextResponse.json({ instances: inventory(), homeSelectors: HOME_SELECTORS,
    ...(thread ? { thread: { id: thread, instance: threadProviderInstance(thread) } } : {}) });
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;
  try {
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body.id === 'string' ? body.id : '';
    switch (body.action) {
      case 'create': return NextResponse.json({ instance: createProviderInstance(body.instance as Record<string, unknown> ?? {}) });
      case 'update': return NextResponse.json({ instance: updateProviderInstance(id, body.instance as Record<string, unknown> ?? {}) });
      case 'delete': return NextResponse.json({ deleted: deleteProviderInstance(id) });
      case 'env': {
        const environment = body.environment as { revision?: number; variables?: unknown } | undefined;
        return NextResponse.json(saveInstanceEnvironment(id, Number(environment?.revision), environment?.variables));
      }
      case 'bind': {
        bindThreadProviderInstance(String(body.thread ?? ''), id || null);
        return NextResponse.json({ ok: true });
      }
      default: return NextResponse.json({ error: 'action must be create, update, delete, env or bind' }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not save the provider instance.' },
      { status: error instanceof AcpEnvironmentConflict ? 409 : 400 });
  }
}
