import { getDeviceManager } from '@/lib/devices/service';
import { DeviceControllers } from '@/lib/devices/controllers';
import type { DeviceControllerContext } from '@/lib/devices/controller-store';
import { DeviceError } from '@/lib/devices/types';
import { jsonResult, type McpTool, type McpToolResult } from './shared';
import { isNativeCortexReader } from '@/lib/cortex/owner-process';
import { getWsBase } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';

// Longer than the device helper's own 30-second command limit.
const DEVICE_OWNER_DEADLINE_MS = 45_000;

export const DEVICE_TOOLS: McpTool[] = [{
  name: 'o8_device',
  description: 'Control a shared iOS simulator already open in Devices. Session identity is assigned automatically to this conversation and worker. Inspect status, acquire, and use press/swipe/scroll/type/snapshot. Occupied devices require an explicit handoff to a waiting session; release cancels your ownership or wait. Never use a raw helper or separate daemon to bypass ownership. Viewing stays passive until the operator explicitly takes control.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    action: { type: 'string', enum: ['status', 'acquire', 'release', 'handoff', 'press', 'swipe', 'scroll', 'type', 'snapshot'] },
    deviceId: { type: 'string' }, targetSession: { type: 'string' },
    x: { type: 'integer', minimum: 0, maximum: 10000 }, y: { type: 'integer', minimum: 0, maximum: 10000 },
    toX: { type: 'integer', minimum: 0, maximum: 10000 }, toY: { type: 'integer', minimum: 0, maximum: 10000 },
    direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, text: { type: 'string', maxLength: 4096 },
  }, required: ['action'] },
}];

/**
 * With the native transport on, the WS process owns the device manager (#5422)
 * and the panel starts the simulator there. Next serves operator MCP and the
 * worker device endpoint after their own checks, so it hands the action to that
 * owner. The owner returns the whole result; Next's host pages it, so a later
 * o8_result_page reaches the same cache.
 */
async function callDeviceOwner(args: Record<string, unknown>, context?: DeviceControllerContext): Promise<McpToolResult> {
  let response: Response;
  let reply: { result?: McpToolResult; error?: { code?: string; message?: string } };
  try {
    response = await fetch(`${getWsBase().replace(/^ws:/, 'http:')}/api/devices/owner`, {
      method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(DEVICE_OWNER_DEADLINE_MS),
      headers: { authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ args, context }),
    });
    reply = await response.json();
  } catch {
    // The owner may have run the input before the reply was lost.
    throw new DeviceError('device_result_unconfirmed', 'The device action may or may not have run. Check status before retrying.', 504);
  }
  if (response.ok && reply.result) return reply.result;
  throw new DeviceError(reply.error?.code || 'device_request_failed', reply.error?.message || 'Device controls are unavailable. Retry from the panel.', response.ok ? 500 : response.status);
}

export async function handleDevice(args: Record<string, unknown>, context?: DeviceControllerContext): Promise<McpToolResult> {
  if (process.env.O8_NEXT_O8D === '1' && !isNativeCortexReader()) return callDeviceOwner(args, context);
  const action = String(args.action);
  const fields: Record<string, string[]> = { status: [], acquire: ['deviceId'], release: ['deviceId'], handoff: ['deviceId', 'targetSession'],
    press: ['deviceId', 'x', 'y'], swipe: ['deviceId', 'x', 'y', 'toX', 'toY'], scroll: ['deviceId', 'direction'], type: ['deviceId', 'text'], snapshot: ['deviceId'] };
  if (!fields[action] || Object.keys(args).some(key => key !== 'action' && !fields[action].includes(key))) {
    throw new DeviceError('device_action_invalid', 'Choose a supported device action.', 400);
  }
  const manager = getDeviceManager();
  const authority = new DeviceControllers(manager.root);
  if (action === 'status') {
    const state = await manager.state();
    return jsonResult({ devices: state.devices ?? [], controllers: state.controllers ?? [] });
  }
  if (!context) throw new DeviceError('device_identity_required', 'Reconnect this worker to assign its device controller.', 409);
  const deviceId = args.deviceId;
  if (typeof deviceId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(deviceId)) throw new DeviceError('device_action_invalid', 'Choose an iOS simulator from Devices.', 400);
  const state = await manager.state();
  if (state.phase !== 'running' || !state.devices?.some(device => device.id === deviceId && device.platform === 'ios' && device.state === 'running')) {
    throw new DeviceError('device_unavailable', 'Open the iOS simulator in Devices first.', 409);
  }
  if (action === 'acquire') await authority.acquire(deviceId, context);
  else if (action === 'release') await authority.release(deviceId, context);
  else if (action === 'handoff') {
    const { controllerFor } = await import('@/lib/devices/controller-store');
    const controller = await controllerFor(manager.root, deviceId, context);
    if (typeof args.targetSession !== 'string') throw new DeviceError('device_action_invalid', 'Choose a waiting controller.', 400);
    await authority.handoff(deviceId, controller.session, args.targetSession, false);
  } else {
    const coordinate = (key: string): number => {
      if (!Number.isSafeInteger(args[key]) || Number(args[key]) < 0 || Number(args[key]) > 10000) throw new DeviceError('device_action_invalid', 'Input coordinates must be integers from 0 to 10000.', 400);
      return Number(args[key]);
    };
    let command = [action];
    let point: { x: number; y: number } | undefined;
    if (action === 'press' || action === 'swipe') {
      point = { x: coordinate('x'), y: coordinate('y') };
      command = [action, String(point.x), String(point.y), ...(action === 'swipe' ? [String(coordinate('toX')), String(coordinate('toY'))] : [])];
    } else if (action === 'type') {
      if (typeof args.text !== 'string' || !args.text || args.text.length > 4096 || args.text.startsWith('-') || args.text.includes('\0')) throw new DeviceError('device_action_invalid', 'Enter text without command options.', 400);
      command.push(args.text);
    } else if (action === 'scroll') {
      if (!['up', 'down', 'left', 'right'].includes(String(args.direction))) throw new DeviceError('device_action_invalid', 'Choose a scroll direction.', 400);
      command.push(String(args.direction));
    }
    const result = await authority.input(deviceId, context, action, command, point);
    return jsonResult({ ok: true, ...(action === 'snapshot' ? { snapshot: result } : {}) });
  }
  return jsonResult({ ok: true, controllers: await authority.roster() });
}
