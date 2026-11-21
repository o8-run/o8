import {
  reconcileCommittedPacketStorageReservations,
  type CommittedStorageReconciliationResult,
} from '@/lib/orchestrator/committed-storage-reconciliation';
import {
  reconcileExpiredPacketStorageReservations,
  type PacketStorageAdmissionReconciliationResult,
} from '@/lib/orchestrator/storage-admission';
import { recurring } from '@/lib/background-work/ledger';

export const STORAGE_ADMISSION_RECONCILIATION_INTERVAL_MS = 5 * 60_000;

export interface StorageAdmissionLedgerReconciliationResult {
  expired: PacketStorageAdmissionReconciliationResult;
  committed: CommittedStorageReconciliationResult;
}

export async function reconcileStorageAdmissionLedger(): Promise<StorageAdmissionLedgerReconciliationResult> {
  const expired = await reconcileExpiredPacketStorageReservations();
  const committed = await reconcileCommittedPacketStorageReservations();
  return { expired, committed };
}

interface TimerHandle {
  unref?: () => unknown;
}

/** Run immediately at startup, then keep the same fail-closed sweep active. */
export function startStorageAdmissionReconciliation(input: {
  reconcile?: () => Promise<StorageAdmissionLedgerReconciliationResult>;
  schedule?: (callback: () => void, intervalMs: number) => TimerHandle;
  onPeriodicResult?: (result: StorageAdmissionLedgerReconciliationResult) => void;
  onPeriodicError?: (error: unknown) => void;
} = {}): { initial: Promise<StorageAdmissionLedgerReconciliationResult>; timer: TimerHandle } {
  const reconcile = input.reconcile ?? reconcileStorageAdmissionLedger;
  const schedule = input.schedule ?? ((callback, intervalMs) => recurring('storage-admission-reconcile', callback, intervalMs));
  const onPeriodicResult = input.onPeriodicResult ?? (() => {});
  const onPeriodicError = input.onPeriodicError ?? ((error: unknown) => {
    console.warn(
      `[storage-admission] Periodic reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  let running: Promise<StorageAdmissionLedgerReconciliationResult> | null = null;
  const run = () => {
    if (running) return running;
    const current = reconcile();
    running = current;
    void current.then(
      () => { if (running === current) running = null; },
      () => { if (running === current) running = null; },
    );
    return current;
  };
  const initial = run();
  const timer = schedule(() => {
    void run().then(onPeriodicResult).catch(onPeriodicError);
  }, STORAGE_ADMISSION_RECONCILIATION_INTERVAL_MS);
  timer.unref?.();
  return { initial, timer };
}
