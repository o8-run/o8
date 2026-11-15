import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import {
  AutomationAttentionError,
  recordAutomationAttention,
} from '@/lib/broadcast/automation-attention';
import { broadcastNoStore } from '@/lib/broadcast/route-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const result = recordAutomationAttention(body, resolveRequestPrincipalContext(request));
    return broadcastNoStore({
      schema: 'o8/broadcast.automation-say/v1',
      ok: true,
      result,
    });
  } catch (error) {
    if (error instanceof AutomationAttentionError) {
      return broadcastNoStore({
        schema: 'o8/broadcast.automation-say.error/v1',
        ok: false,
        error: { code: error.code, message: error.message },
      }, error.status);
    }
    console.error('[broadcast] Automation attention persistence failed:', error);
    return broadcastNoStore({
      schema: 'o8/broadcast.automation-say.error/v1',
      ok: false,
      error: {
        code: 'automation_attention_failed',
        message: 'Scheduled Symon attention could not be persisted.',
      },
    }, 503);
  }
}
