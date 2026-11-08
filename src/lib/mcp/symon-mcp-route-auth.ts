import { NextResponse } from 'next/server';
import { resolveRequestPrincipal } from '@/lib/auth/principal';

export function authorizeSymonMcpRoute(request: Request): NextResponse | null {
  const principal = resolveRequestPrincipal(request);
  if (principal === 'worker') {
    return NextResponse.json(
      { ok: false, error: 'A dispatched worker cannot use Symon MCP tools.' },
      { status: 403 },
    );
  }
  if (principal !== 'operator') {
    return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
  }
  return null;
}
