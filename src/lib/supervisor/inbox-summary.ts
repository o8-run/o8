import type { SupervisorInboxItem } from './inbox';

export interface SupervisorInboxSummary {
  active: number;
  humanRequired: number;
  pending: number;
  healing: number;
  escalated: number;
  selfHealed: number;
  resolved: number;
  dismissed: number;
  total: number;
}

export function summarizeInboxItems(items: ReadonlyArray<Pick<SupervisorInboxItem, 'status'>>): SupervisorInboxSummary {
  return items.reduce<SupervisorInboxSummary>((summary, item) => {
    summary.total += 1;
    switch (item.status) {
      case 'human_required':
        summary.humanRequired += 1;
        summary.active += 1;
        break;
      case 'pending':
        summary.pending += 1;
        summary.active += 1;
        break;
      case 'healing':
        summary.healing += 1;
        summary.active += 1;
        break;
      case 'escalated':
        summary.escalated += 1;
        summary.active += 1;
        break;
      case 'self_healed':
        summary.selfHealed += 1;
        break;
      case 'resolved':
        summary.resolved += 1;
        break;
      case 'dismissed':
        summary.dismissed += 1;
        break;
      default:
        break;
    }
    return summary;
  }, {
    active: 0,
    humanRequired: 0,
    pending: 0,
    healing: 0,
    escalated: 0,
    selfHealed: 0,
    resolved: 0,
    dismissed: 0,
    total: 0,
  });
}
