import { headersIndicateLoopback } from '@/lib/auth/loopback-request';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import type { DeviceControllerContext } from '@/lib/devices/controller-store';
import { DeviceError } from '@/lib/devices/types';
import { handleDevice } from '@/lib/mcp/operator-handlers/devices';

const headers = { 'Cache-Control': 'no-store' };
const failure = (code: string, message: string, status: number) => Response.json({ error: { code, message } }, { status, headers });

function deviceContext(value: unknown): DeviceControllerContext | undefined | null {
  if (value === undefined) return undefined;
  const input = value as Record<string, unknown> | null;
  return input && typeof input === 'object' && typeof input.conversation === 'string' && typeof input.worker === 'string'
    && Number.isSafeInteger(input.pid) ? { conversation: input.conversation, worker: input.worker, pid: Number(input.pid) } : null;
}

/**
 * Native transport only: Next's o8_device hand-off. Next has already checked the
 * operator or the packet worker it acts for. The WS process owns the device
 * manager, runs the action and returns the whole result, so Next pages a large
 * one in its own result cache, where o8_result_page will look for it.
 */
export async function POST(request: Request): Promise<Response> {
  if (!headersIndicateLoopback(name => request.headers.get(name)) || resolveRequestPrincipalContext(request).role !== 'operator') {
    return failure('device_operator_required', 'Device controls require the local operator.', 403);
  }
  let args: Record<string, unknown>;
  let context: DeviceControllerContext | undefined | null;
  try {
    const text = await request.text();
    if (text.length > 16_384) throw new Error('Too large');
    const input = JSON.parse(text) as { args?: unknown; context?: unknown };
    if (!input.args || typeof input.args !== 'object' || Array.isArray(input.args)) throw new Error('Invalid');
    args = input.args as Record<string, unknown>;
    context = deviceContext(input.context);
    if (context === null) throw new Error('Invalid');
  } catch {
    return failure('device_action_invalid', 'Choose a supported device tool action.', 400);
  }
  try {
    return Response.json({ result: await handleDevice(args, context) }, { headers });
  } catch (error) {
    if (error instanceof DeviceError) return failure(error.code, error.message, error.status);
    return failure('device_request_failed', 'Device controls are unavailable. Retry from the panel.', 500);
  }
}
