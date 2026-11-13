import type { ApprovalAuditEvent } from '@/lib/approvals/types';

/** Bound audit events after the existing list has applied its scope and visibility rules. */
export function pageApprovalAudit<T extends { audit: ApprovalAuditEvent[]; updatedAt: number }>(
  approvals: T[],
  limit: number,
): { approvals: T[]; total: number } {
  const events = approvals.flatMap(approval => approval.audit.map(event => ({
    approval,
    event,
    timestamp: Number.isFinite(event?.timestamp) ? event.timestamp : approval.updatedAt,
  })));
  // Stable ties match the native view's approval/event order.
  events.sort((a, b) => b.timestamp - a.timestamp);
  const selected = new Map<T, ApprovalAuditEvent[]>();
  for (const { approval, event } of events.slice(0, limit)) {
    const audit = selected.get(approval) ?? [];
    audit.push(event);
    selected.set(approval, audit);
  }
  return {
    approvals: [...selected].map(([approval, audit]) => ({ ...approval, audit })),
    total: events.length,
  };
}
