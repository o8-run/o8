import { McpInputError } from '@/lib/mcp/api-error';
import { randomBytes, randomUUID } from 'node:crypto';
import { DEFAULT_RESOURCE_LEASE_TTL_MS } from '@/lib/leases/resource-lease-types';

import {
  apiFetch,
  errorText,
  jsonResult,
  requiredString,
  textResult,
  type McpTool,
  type McpToolResult,
} from './shared';

const WAIT_POLL_MS = 100;
const claimTokens = new Map<string, string>();

export const LEASE_TOOLS: McpTool[] = [
  {
    name: 'o8_lease_acquire',
    description: 'Acquire one named resource lease. Required: resource. ttlMs is milliseconds, default 7200000 (2 hours); wait defaults to false. With wait:true, remain queued in durable FIFO order until ownership is granted or this MCP process exits. Release from the same MCP process. Example: o8_lease_acquire({resource: "audit", ttlMs: 60000, wait: false}).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        resource: { type: 'string', minLength: 1, maxLength: 2048, description: 'Exact resource name; reuse it with o8_lease_status and o8_lease_release.' },
        ttlMs: { type: 'integer', minimum: 1000, maximum: 86400000, default: DEFAULT_RESOURCE_LEASE_TTL_MS, description: 'Lease duration in milliseconds, from 1000 through 86400000. Default 7200000 (2 hours).' },
        wait: { type: 'boolean', default: false, description: 'true queues until acquired; false returns immediately if held. Default false.' },
      },
      required: ['resource'],
    },
  },
  {
    name: 'o8_lease_release',
    description: 'Release a named resource only when this exact MCP process is its current holder. Required: resource, using the exact name passed to o8_lease_acquire. Example: o8_lease_release({resource: "audit"}).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { resource: { type: 'string', minLength: 1, maxLength: 2048 } },
      required: ['resource'],
    },
  },
  {
    name: 'o8_lease_status',
    description: 'Read the current holder, overdue state, fail-closed blocker, and FIFO waiters for one named resource. Required: resource. Example: o8_lease_status({resource: "audit"}).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { resource: { type: 'string', minLength: 1, maxLength: 2048 } },
      required: ['resource'],
    },
  },
  {
    name: 'o8_lease_list',
    description: 'List every active named resource holder and waiter queue. No required fields. Example: o8_lease_list({}).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: [],
    },
  },
];

function owner() {
  return {
    id: `mcp:${process.pid}`,
    label: `mcp-agent:${process.pid}`,
    pid: process.pid,
  };
}

function optionalTtl(args: Record<string, unknown>): number | undefined {
  const value = args.ttlMs;
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1_000 || Number(value) > 86_400_000) {
    throw new McpInputError('ttlMs must be an integer from 1000 through 86400000.');
  }
  return Number(value);
}

function sleep(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
}

export async function handleLeaseAcquire(args: Record<string, unknown>): Promise<McpToolResult> {
  const resource = requiredString(args, 'resource');
  if (args.wait !== undefined && typeof args.wait !== 'boolean') {
    throw new McpInputError('wait must be a boolean. Set wait:true to queue, or wait:false to return immediately.');
  }
  const ttlMs = optionalTtl(args);
  const wait = args.wait === true;
  const leaseOwner = owner();
  const waiterId = `waiter:mcp:${process.pid}:${randomUUID()}`;
  const claimToken = claimTokens.get(resource) ?? randomBytes(32).toString('base64url');
  claimTokens.set(resource, claimToken);
  try {
    for (;;) {
      const data = await apiFetch('/api/leases', {
        method: 'POST',
        body: JSON.stringify({
          action: 'acquire',
          resource,
          owner: leaseOwner,
          claimToken,
          waiterPid: wait ? process.pid : undefined,
          ttlMs,
          wait,
          waiterId,
        }),
        acceptedErrorStatuses: [409],
      }) as { result?: { state?: string } };
      const state = data.result?.state;
      if (state === 'acquired') return jsonResult(data);
      if (state === 'refused' || !wait) {
        return textResult(JSON.stringify(data), true);
      }
      if (state !== 'queued') {
        return textResult('o8_lease_acquire failed: backend returned no recognized lease state.', true);
      }
      await sleep();
    }
  } catch (error) {
    return textResult(`o8_lease_acquire failed: ${errorText(error)}`, true);
  }
}

export async function handleLeaseRelease(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const resource = requiredString(args, 'resource');
    const claimToken = claimTokens.get(resource);
    if (!claimToken) {
      return textResult(`o8_lease_release failed: this MCP process has no private claim for ${resource}.`, true);
    }
    const data = await apiFetch('/api/leases', {
      method: 'POST',
      body: JSON.stringify({
        action: 'release',
        resource,
        owner: owner(),
        claimToken,
      }),
      acceptedErrorStatuses: [404, 409],
    }) as { ok?: boolean };
    if (data.ok) claimTokens.delete(resource);
    return data.ok ? jsonResult(data) : textResult(JSON.stringify(data), true);
  } catch (error) {
    return textResult(`o8_lease_release failed: ${errorText(error)}`, true);
  }
}

export async function handleLeaseStatus(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const resource = encodeURIComponent(requiredString(args, 'resource'));
    return jsonResult(await apiFetch(`/api/leases?resource=${resource}`));
  } catch (error) {
    return textResult(`o8_lease_status failed: ${errorText(error)}`, true);
  }
}

export async function handleLeaseList(): Promise<McpToolResult> {
  try {
    return jsonResult(await apiFetch('/api/leases'));
  } catch (error) {
    return textResult(`o8_lease_list failed: ${errorText(error)}`, true);
  }
}
