// Real-path regression for #4965 failure 1: a worker that fails to launch
// because of a lifecycle hold (or a credential preflight) must return a
// structured, recoverable response through the REAL dispatch route handler,
// never a bare HTTP 500 that the operator's card reads as "still loading".
//
// Mechanic: src/app/api/orchestrator/dispatch/route.ts translated every known
// dispatch failure except PacketStorageAdmissionError, so the lifecycle-lock
// hold thrown by dispatchPacketLaunch (state:'held', reason:'launch_in_progress'
// | 'launch_effect_unknown') fell through to operatorError(..., 500), whose body
// masks the message as "o8 API error (500)". The wait:false branch also omitted
// the DispatchPreflightError (credential) handler the wait:true branch already
// had. This drives the real POST handler and asserts the recoverable states.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PacketStorageAdmissionError } from '@/lib/orchestrator/storage-admission';
import { DispatchPreflightError } from '@/lib/runtimes/shared/auth-detect';
import type { PacketStorageAdmissionReceipt } from '@/lib/orchestrator/storage-admission';
import type { RuntimeAuthStatus } from '@/lib/runtimes/shared/auth-detect';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-dispatch-held-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

const dispatchMission = vi.hoisted(() => vi.fn());
const prepareMissionDispatch = vi.hoisted(() => vi.fn());
const resolveMissionDispatchTarget = vi.hoisted(() => vi.fn(() => 'mission-under-test'));

vi.mock('@/lib/orchestrator/operator-mission-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/orchestrator/operator-mission-service')>(),
  resolveMissionDispatchTarget,
  prepareMissionDispatch,
  dispatchMission,
}));

const route = await import('@/app/api/orchestrator/dispatch/route');

function heldReceipt(reason: string): PacketStorageAdmissionReceipt {
  return {
    schema: 'o8/packet-storage-admission/v1',
    state: 'held',
    reason,
    reservationId: 'reservation-1',
    mutationId: 'mutation-1',
    ownerId: 'owner-1',
    ownerGeneration: 1,
    estimateBytes: 0,
    estimateSource: 'unknown',
    historySamples: 0,
    volumeId: null,
    physicalAvailableBytes: null,
    reservedBeforeBytes: null,
    requiredReserveBytes: null,
    dispatchHeadroomBytes: null,
    recordedAt: Date.now(),
  };
}

function authStatus(): RuntimeAuthStatus {
  return {
    house: 'claude',
    runtime: 'claude-code',
    installed: true,
    ready: false,
    authenticated: false,
    unavailableReason: 'needs_auth',
    detail: 'Claude Code is installed but not signed in.',
    fix: 'Run claude login, then retry the dispatch.',
    checkedAt: Date.now(),
  };
}

function dispatchRequest(body: unknown): NextRequest {
  return new NextRequest('http://127.0.0.1/api/orchestrator/dispatch', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Host: '127.0.0.1' },
  });
}

describe('#4965 dispatch route surfaces recoverable launch/credential states', () => {
  beforeEach(() => {
    dispatchMission.mockReset();
    prepareMissionDispatch.mockReset();
    resolveMissionDispatchTarget.mockReset();
    resolveMissionDispatchTarget.mockReturnValue('mission-under-test');
  });

  it('maps a lifecycle-lock hold (wait:true MCP path) to a recoverable 409, not a bare 500', async () => {
    dispatchMission.mockRejectedValue(
      new PacketStorageAdmissionError(
        'Dispatch held because this exact packet generation is already launching.',
        heldReceipt('launch_in_progress'),
      ),
    );

    const response = await route.POST(dispatchRequest({ missionId: 'mission-under-test' }));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      error: {
        code: 'dispatch_held',
        reason: 'launch_in_progress',
      },
    });
    // The operator must see the reason and a retry, not "o8 API error (500)".
    expect(body.error.message).not.toContain('o8 API error');
    expect(body.error.nextAction).toBeTruthy();
  });

  it('maps a lifecycle-lock hold on the async wait:false branch to a recoverable 409', async () => {
    prepareMissionDispatch.mockRejectedValue(
      new PacketStorageAdmissionError(
        'Dispatch held because the prior launch owner ended before its result was reconciled.',
        heldReceipt('launch_effect_unknown'),
      ),
    );

    const response = await route.POST(dispatchRequest({ missionId: 'mission-under-test', wait: false }));

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      error: { code: 'dispatch_held', reason: 'launch_effect_unknown' },
    });
    expect(body.error.nextAction).toBeTruthy();
  });

  it('maps a credential preflight failure on the wait:false branch to 400, not a bare 500', async () => {
    prepareMissionDispatch.mockRejectedValue(new DispatchPreflightError(authStatus()));

    const response = await route.POST(dispatchRequest({ missionId: 'mission-under-test', wait: false }));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: false,
      error: { code: 'dispatch_cli_auth_unavailable' },
    });
    expect(body.error.message).toContain('Claude Code is installed but not signed in.');
  });
});
