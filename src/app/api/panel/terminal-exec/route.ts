export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { resolvePortInfo } from '@/lib/panel/api-port';

/**
 * POST /api/panel/terminal-exec
 * Sends a command to a dashboard terminal session owned by the WS bridge.
 */
export async function POST(request: Request) {
  try {
    const wsToken = getOrCreateWsToken();
    const { wsPort } = resolvePortInfo();
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
    }
    const { sessionName, command } = body;

    if (!sessionName || !command) {
      return NextResponse.json({ error: 'sessionName and command required' }, { status: 400 });
    }

    // Validate session name (prevent injection)
    if (!/^cortex-dash-[a-f0-9]+$/.test(sessionName)) {
      return NextResponse.json({ error: 'Invalid session name' }, { status: 400 });
    }

    const response = await fetch(`http://127.0.0.1:${wsPort}/terminal-exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${wsToken}`,
      },
      body: JSON.stringify({ sessionName, command }),
      cache: 'no-store',
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      return NextResponse.json({ error: data.error || 'Failed to execute command' }, { status: response.status });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to execute command' },
      { status: 500 },
    );
  }
}
