import { NextResponse } from 'next/server';
import {
  registerManagedRun,
  finishManagedRun,
  findManagedRun,
  killManagedRun,
  listManagedRuns,
  bindManagedRunProvider,
  recordManagedRunSettlement,
} from '@/lib/runtimes/managed-runs/registry';
import type { ManagedRunRecord } from '@/lib/runtimes/managed-runs/types';
import { inspectOwnedManagedRun, terminateManagedRun } from '@/lib/runtimes/managed-runs/termination';
import { externalSettlementQuiet, parseSettlementBinding, settlementBindingDigest } from '@/lib/runtimes/managed-runs/settlement';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { serverTimingHeaders } from '@/lib/performance/server-timing';
import { getLane } from '@/lib/lane/registry';
import { recordAutomationSourceEvent } from '@/lib/automations/source-events';
import { inspectPacketManagedRunAdmission } from '@/lib/lane/packet-stop-hold';
import { withPacketManagedRunLifecycleLock } from '@/lib/runtimes/managed-runs/packet-lifecycle';
import { resolveManagedRunExitReceipt } from '@/lib/runtimes/managed-runs/receipt-path';
import { admitsReviewerManagedRun } from '@/lib/lane/reviewer-managed-run';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Managed-run sessions are always `cortex-run-<id>`; never let a caller act on any other session. */
const RUN_SESSION_RE = /^cortex-run-[A-Za-z0-9]+$/;
const MAX_FIELD = 4096; // cap persisted/echoed strings — no unbounded command/cwd

function workerView(run: ManagedRunRecord) {
  const { settlement, termination, ...visible } = run;
  return { ...visible, settlementState: settlement ? externalSettlementQuiet(run) ? 'quiet' : 'unknown' : null,
    termination: termination ? { confirmedDead: termination.confirmedDead } : null };
}

/** GET — list managed runs (reconciled against live tmux). */
export async function GET(request: Request) {
  const startedAt = performance.now();
  const principal = resolveRequestPrincipalContext(request);
  if (principal.role !== 'operator' && principal.role !== 'worker') {
    return NextResponse.json(
      { schema: 'o8/managed-runs/v1', runs: [], error: 'operator_or_worker_required' },
      { status: 403, headers: serverTimingHeaders(startedAt) },
    );
  }
  try {
    const allRuns = await listManagedRuns();
    const runs = principal.role === 'worker'
      ? allRuns.filter((run) => Boolean(principal.packetId) && run.packetId === principal.packetId).map(workerView)
      : allRuns;
    return NextResponse.json(
      { schema: 'o8/managed-runs/v1', settlementContract: 'o8/managed-run-settlement/v1', runs },
      { headers: serverTimingHeaders(startedAt) },
    );
  } catch (err) {
    return NextResponse.json(
      { schema: 'o8/managed-runs/v1', runs: [], error: err instanceof Error ? err.message : String(err) },
      { status: 500, headers: serverTimingHeaders(startedAt) },
    );
  }
}

type RegisterBody = {
  action?: 'register' | 'finish' | 'kill' | 'output' | 'bind-session' | 'settlement';
  id?: string;
  session?: string;
  command?: string;
  title?: string | null;
  cwd?: string;
  repo?: string | null;
  packetId?: string | null;
  laneId?: string | null;
  panePid?: number;
  mode?: string;
  startedAt?: string;
  exitCode?: number;
  processGroupId?: number;
  processMarker?: string;
  exitReceiptPath?: unknown;
  reason?: 'stream_sigint' | 'operator_stop';
  outputChunk?: string;
  outputSequence?: number;
  observedAt?: number;
  settlementBinding?: unknown;
  bindingDigest?: string;
  receiptId?: string;
  sequence?: number;
  state?: 'active' | 'unknown' | 'quiet';
  providerSessionId?: string | null;
  cancelledBeforeLaunch?: boolean;
  stopRequestId?: string | null;
};

function managedRunRepoPath(run: ManagedRunRecord): string {
  return (run.laneId ? getLane(run.laneId)?.repoPath : null) ?? run.cwd;
}

/** POST — register a run (default), finish one (action:'finish'), or kill one (action:'kill'). */
export async function POST(req: Request) {
  try { return await post(req); } catch (error) {
    const message = error instanceof Error ? error.message : 'managed_run_failed';
    const unavailable = message === 'managed_run_persistence_unavailable';
    return NextResponse.json({ ok: false, error: message }, { status: unavailable ? 503 : 409 });
  }
}

async function post(req: Request) {
  const principal = resolveRequestPrincipalContext(req);
  if (principal.role !== 'operator' && principal.role !== 'worker') {
    return NextResponse.json({ ok: false, error: 'operator_or_worker_required' }, { status: 403 });
  }
  let body: RegisterBody;
  try {
    body = (await req.json()) as RegisterBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }
  const view = (run: ManagedRunRecord | null) => run && (principal.role === 'worker' ? workerView(run) : run);
  if (body.action === 'settlement' || body.action === 'bind-session' || body.settlementBinding !== undefined) {
    if (principal.role !== 'operator') {
      return NextResponse.json({ ok: false, error: 'operator_settlement_required' }, { status: 403 });
    }
  }
  if (body.action === 'bind-session') {
    const run = bindManagedRunProvider(body.id ?? '', body.bindingDigest ?? '', body.providerSessionId);
    return NextResponse.json({ ok: true, run });
  }
  if (body.action === 'settlement') {
    if (!['active', 'unknown', 'quiet'].includes(body.state ?? '')
      || !Number.isSafeInteger(body.sequence) || Number(body.sequence) < 1
      || (body.providerSessionId !== null && typeof body.providerSessionId !== 'string')) {
      return NextResponse.json({ ok: false, error: 'invalid_settlement_receipt' }, { status: 400 });
    }
    const run = recordManagedRunSettlement(body.id ?? '', {
      receiptId: body.receiptId ?? '', bindingDigest: body.bindingDigest ?? '', sequence: Number(body.sequence),
      state: body.state!, providerSessionId: body.providerSessionId!,
      cancelledBeforeLaunch: body.cancelledBeforeLaunch === true, stopRequestId: body.stopRequestId ?? null,
    });
    // Receiving a quiet seal alone never proves that the wrapper/process tree exited.
    if (run.settlement?.wrapperFinished) await listManagedRuns();
    return NextResponse.json({ ok: true, run: findManagedRun(run.id) });
  }
  if (body.action === 'register' || !body.action) {
    const ownershipRefusal = workerPacketRefusal(principal, body.packetId)
      || (body.laneId ? workerPacketRefusal(principal, getLane(body.laneId)?.packetId) : null);
    if (ownershipRefusal) {
      return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
    }
  } else if (principal.role === 'worker') {
    const key = body.session ?? body.id ?? '';
    const target = (await listManagedRuns()).find((run) => run.session === key || run.id === key);
    const ownershipRefusal = workerPacketRefusal(principal, target?.packetId);
    if (ownershipRefusal) {
      return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
    }
  }

  if (body.action === 'output') {
    const key = body.session ?? body.id;
    const target = key ? findManagedRun(key) : null;
    if (!target) return NextResponse.json({ ok: false, error: 'run_not_found' }, { status: 404 });
    if (typeof body.outputChunk !== 'string' || Buffer.byteLength(body.outputChunk, 'utf8') > 8 * 1024) {
      return NextResponse.json({ ok: false, error: 'invalid_output_chunk' }, { status: 400 });
    }
    if (!Number.isSafeInteger(body.outputSequence) || Number(body.outputSequence) < 1) {
      return NextResponse.json({ ok: false, error: 'invalid_output_sequence' }, { status: 400 });
    }
    recordAutomationSourceEvent({
      sourceKind: 'managed_run',
      sourceId: target.id,
      repoPath: managedRunRepoPath(target),
      eventType: 'output',
      fingerprint: `managed-run:${target.id}:output:${body.outputSequence}`,
      occurredAt: Number.isFinite(body.observedAt) ? Number(body.observedAt) : Date.now(),
      payload: { chunk: body.outputChunk, mode: target.mode, session: target.session },
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'finish') {
    const key = body.session ?? body.id;
    if (!key) {
      return NextResponse.json({ ok: false, error: 'missing_id' }, { status: 400 });
    }
    const target = findManagedRun(key);
    const quiet = target?.settlement ? await inspectOwnedManagedRun(target) : false;
    const rec = finishManagedRun(key, typeof body.exitCode === 'number' ? body.exitCode : null, quiet);
    if (rec?.status === 'settling') {
      return NextResponse.json({ ok: false, error: 'settlement_unconfirmed', run: view(rec) }, { status: 409 });
    }
    if (rec?.status === 'finished') {
      recordAutomationSourceEvent({
        sourceKind: 'managed_run',
        sourceId: rec.id,
        repoPath: managedRunRepoPath(rec),
        eventType: rec.exitCode === 0 ? 'exit_clean' : 'exit_failed',
        fingerprint: `managed-run:${rec.id}:finished:${rec.exitCode ?? 'unknown'}`,
        payload: { exitCode: rec.exitCode ?? null, status: rec.status, mode: rec.mode },
      });
    }
    return NextResponse.json({ ok: Boolean(rec), run: view(rec) });
  }

  if (body.action === 'kill') {
    const session = body.session;
    // Only ever kill o8-owned managed-run sessions — never an orchestrator,
    // agent-runtime, dashboard, or unrelated tmux session passed by name.
    if (!session || !RUN_SESSION_RE.test(session)) {
      return NextResponse.json({ ok: false, error: 'invalid_session' }, { status: 400 });
    }
    const target = findManagedRun(session);
    if (!target) {
      return NextResponse.json({ ok: false, error: 'run_not_found' }, { status: 404 });
    }
    const reason = body.reason === 'stream_sigint' ? 'stream_sigint' : 'operator_stop';
    const exitCode = reason === 'stream_sigint' ? 130 : null;
    const termination = await terminateManagedRun(target, { reason, exitCode });
    if (!termination.confirmedDead) {
      return NextResponse.json(
        { ok: false, error: 'termination_unconfirmed', run: view(findManagedRun(session)),
          termination: principal.role === 'worker' ? { confirmedDead: false } : termination },
        { status: 409 },
      );
    }
    const rec = killManagedRun(session, exitCode, termination);
    if (rec?.status === 'killed') {
      recordAutomationSourceEvent({
        sourceKind: 'managed_run',
        sourceId: rec.id,
        repoPath: managedRunRepoPath(rec),
        eventType: 'killed',
        fingerprint: `managed-run:${rec.id}:killed:${rec.finishedAt ?? 'unknown'}`,
        payload: { exitCode: rec.exitCode ?? null, reason, status: rec.status },
      });
    }
    return NextResponse.json({ ok: Boolean(rec), run: view(rec),
      termination: principal.role === 'worker' ? { confirmedDead: termination.confirmedDead } : termination });
  }

  // ── register (default) ──
  if (body.action && body.action !== 'register') {
    return NextResponse.json({ ok: false, error: 'unknown_action' }, { status: 400 });
  }
  if (!body.id || !body.session || !body.command || !body.cwd) {
    return NextResponse.json(
      { ok: false, error: 'missing_fields', need: ['id', 'session', 'command', 'cwd'] },
      { status: 400 },
    );
  }
  // Session must be the canonical cortex-run-<id> and match the id, so a caller
  // can't register a record that later legitimizes killing a foreign session.
  if (!RUN_SESSION_RE.test(body.session) || body.session !== `cortex-run-${body.id}`) {
    return NextResponse.json({ ok: false, error: 'invalid_session' }, { status: 400 });
  }
  const exitReceiptPath = resolveManagedRunExitReceipt(body.id, body.exitReceiptPath);
  if (body.exitReceiptPath !== undefined && !exitReceiptPath) {
    return NextResponse.json({ ok: false, error: 'invalid_exit_receipt_path' }, { status: 400 });
  }
  if (body.processMarker !== undefined && !/^[A-Za-z0-9._-]{1,160}$/.test(body.processMarker)) {
    return NextResponse.json({ ok: false, error: 'invalid_process_marker' }, { status: 400 });
  }
  if (body.processGroupId !== undefined
    && (!Number.isSafeInteger(body.processGroupId) || body.processGroupId <= 0)) {
    return NextResponse.json({ ok: false, error: 'invalid_process_group' }, { status: 400 });
  }
  if (body.command.length > MAX_FIELD || body.cwd.length > MAX_FIELD || (body.title?.length ?? 0) > MAX_FIELD || (body.startedAt?.length ?? 0) > MAX_FIELD) {
    return NextResponse.json({ ok: false, error: 'field_too_long' }, { status: 400 });
  }
  const binding = body.settlementBinding === undefined ? null : parseSettlementBinding(body.settlementBinding);
  if (body.settlementBinding !== undefined && !binding) {
    return NextResponse.json({ ok: false, error: 'invalid_settlement_binding' }, { status: 400 });
  }

  const commitRegistration = () => {
    const proposed: ManagedRunRecord = {
      id: body.id!,
      session: body.session!,
      command: body.command!,
      title: body.title?.trim() || null,
      cwd: body.cwd!,
      repo: body.repo ?? null,
      packetId: body.packetId?.trim() || null,
      laneId: body.laneId ?? null,
      panePid: typeof body.panePid === 'number' ? body.panePid : null,
      processGroupId: typeof body.processGroupId === 'number' ? body.processGroupId : null,
      processMarker: typeof body.processMarker === 'string' ? body.processMarker : null,
      ...(body.exitReceiptPath === undefined ? {} : { exitReceiptPath: exitReceiptPath! }),
      mode: body.mode === 'detach' ? 'detach' : 'stream',
      startedAt: typeof body.startedAt === 'string' && body.startedAt.trim()
        ? body.startedAt.trim()
        : new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      status: 'running',
      termination: null,
      settlement: binding ? {
        binding, bindingDigest: settlementBindingDigest(binding, body.cwd!),
        providerSessionId: binding.providerSessionId, receipt: null, stopRequestId: null,
        stopRequestedAt: null, wrapperFinished: false,
      } : null,
    };
    const rec = registerManagedRun(proposed);
    recordAutomationSourceEvent({
      sourceKind: 'managed_run',
      sourceId: rec.id,
      repoPath: managedRunRepoPath(rec),
      eventType: 'started',
      fingerprint: `managed-run:${rec.id}:started:${rec.startedAt}`,
      occurredAt: Date.parse(rec.startedAt) || Date.now(),
      payload: { command: rec.command, mode: rec.mode, packetId: rec.packetId, laneId: rec.laneId },
    });
    return NextResponse.json({ ok: true, run: view(rec) });
  };

  const packetId = body.packetId?.trim() ?? '';
  if (!packetId) return commitRegistration();
  return withPacketManagedRunLifecycleLock(packetId, async () => {
    const admission = inspectPacketManagedRunAdmission(packetId);
    const reviewerAllowed = !admission.allowed && principal.role === 'operator'
      && await admitsReviewerManagedRun(packetId, body.laneId, body.cwd!);
    if (!admission.allowed && !reviewerAllowed) {
      const hint = admission.reason === 'packet_not_found'
        ? 'Inspect the packet ID and dispatch a valid packet before retrying o8 run.'
        : admission.reason === 'packet_held'
          ? 'Ask the operator to inspect the hold and reset the packet before dispatching a new turn.'
          : 'Ask the operator to use rerun_with_feedback to start a new turn before retrying o8 run.';
      return NextResponse.json({
        ok: false,
        error: 'packet_not_accepting_managed_runs',
        reason: admission.reason,
        packetStatus: admission.status,
        message: `Packet ${packetId} is ${admission.status ?? 'missing'} and cannot start managed runs. ${hint}`,
        hint,
      }, { status: 409 });
    }
    return commitRegistration();
  });
}
