import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import {
  BroadcastPostError,
  handleBroadcastPost,
} from '@/lib/broadcast/post';
import { broadcastNoStore } from '@/lib/broadcast/route-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const event = handleBroadcastPost(body, resolveRequestPrincipalContext(request));
    return broadcastNoStore({
      schema: 'o8/broadcast.post/v1',
      ok: true,
      event,
    }, event.kind === 'focus' ? 200 : 201);
  } catch (error) {
    if (error instanceof BroadcastPostError) {
      return broadcastNoStore({
        schema: 'o8/broadcast.post.error/v1',
        ok: false,
        error: { code: error.code, message: error.message },
      }, error.status);
    }
    console.error('[broadcast] Post persistence failed:', error);
    return broadcastNoStore({
      schema: 'o8/broadcast.post.error/v1',
      ok: false,
      error: {
        code: 'broadcast_post_failed',
        message: 'Broadcast post could not be persisted.',
      },
    }, 503);
  }
}
