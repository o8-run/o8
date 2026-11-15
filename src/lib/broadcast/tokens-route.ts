
import { broadcastNoStore, requireBroadcastOperator } from '@/lib/broadcast/route-auth';
import { getSpectatorTokenStore } from '@/lib/broadcast/spectator-token-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface BroadcastTokenBody {
  action?: unknown;
  id?: unknown;
  label?: unknown;
  repoGrants?: unknown;
}

export async function POST(request: Request) {
  const denied = requireBroadcastOperator(request);
  if (denied) return denied;
  const body = await request.json().catch(() => null) as BroadcastTokenBody | null;
  if (!body || (body.action !== 'mint' && body.action !== 'revoke')) {
    return broadcastNoStore({
      schema: 'o8/broadcast.token.error/v1',
      ok: false,
      error: { code: 'invalid_action', message: 'action must be mint or revoke.' },
    }, 400);
  }
  try {
    if (body.action === 'mint') {
      if (body.label !== undefined && typeof body.label !== 'string') {
        return broadcastNoStore({
          schema: 'o8/broadcast.token.error/v1',
          ok: false,
          error: { code: 'invalid_label', message: 'label must be a string.' },
        }, 400);
      }
      if (typeof body.label === 'string' && body.label.trim().replace(/\s+/g, ' ').length > 120) {
        return broadcastNoStore({
          schema: 'o8/broadcast.token.error/v1',
          ok: false,
          error: { code: 'invalid_label', message: 'label must be at most 120 characters.' },
        }, 400);
      }
      if (
        body.repoGrants !== undefined
        && (!Array.isArray(body.repoGrants) || body.repoGrants.some((grant) => typeof grant !== 'string'))
      ) {
        return broadcastNoStore({
          schema: 'o8/broadcast.token.error/v1',
          ok: false,
          error: { code: 'invalid_repo_grants', message: 'repoGrants must be an array of strings.' },
        }, 400);
      }
      const result = getSpectatorTokenStore().mint({
        label: typeof body.label === 'string' ? body.label : null,
        repoGrants: Array.isArray(body.repoGrants) ? body.repoGrants : [],
      });
      return broadcastNoStore({
        schema: 'o8/broadcast.token.mint/v1',
        ok: true,
        token: result.record,
        bearer: result.bearer,
      });
    }
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    if (!id) {
      return broadcastNoStore({
        schema: 'o8/broadcast.token.error/v1',
        ok: false,
        error: { code: 'missing_token_id', message: 'id is required to revoke a Broadcast token.' },
      }, 400);
    }
    const revoked = getSpectatorTokenStore().revoke(id);
    return revoked
      ? broadcastNoStore({ schema: 'o8/broadcast.token.revoke/v1', ok: true, token: revoked })
      : broadcastNoStore({
        schema: 'o8/broadcast.token.error/v1',
        ok: false,
        error: { code: 'token_not_found', message: 'Active Broadcast token not found.' },
      }, 404);
  } catch (error) {
    console.error('[broadcast] Token mutation failed:', error);
    return broadcastNoStore({
      schema: 'o8/broadcast.token.error/v1',
      ok: false,
      error: {
        code: 'broadcast_token_persistence_failed',
        message: 'Broadcast token mutation failed.',
      },
    }, 503);
  }
}
