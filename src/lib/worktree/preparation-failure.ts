import { redactThreadText } from '@/lib/threads/redaction';

export interface PreparationCleanup { status: 'needs_cleanup'; reason: string }
const LEGACY_RETIREMENT_MARKER = ' Exact retirement was refused; durable workspace ownership was retained: ';

/** Retirement failure is secondary; never replace the preparation error with it. */
export class WorktreePreparationCleanupError extends Error {
  readonly cleanup: PreparationCleanup;
  constructor(creation: unknown, retirement: unknown) {
    super(creation instanceof Error ? creation.message : String(creation), { cause: creation });
    this.cleanup = { status: 'needs_cleanup', reason: retirement instanceof Error ? retirement.message : String(retirement) };
  }
}

/** Also read older combined receipts without rewriting their durable history. */
export function preparationFailureDetails(input: unknown, storedCleanup?: PreparationCleanup): { cause: string; cleanup?: PreparationCleanup } {
  const message = input instanceof Error ? input.message : String(input);
  const index = input instanceof WorktreePreparationCleanupError ? -1 : message.indexOf(LEGACY_RETIREMENT_MARKER);
  const cleanup = input instanceof WorktreePreparationCleanupError ? input.cleanup
    : storedCleanup ?? (index < 0 ? undefined : { status: 'needs_cleanup', reason: message.slice(index + LEGACY_RETIREMENT_MARKER.length) });
  return { cause: redactThreadText(index < 0 ? message : message.slice(0, index)),
    ...(cleanup ? { cleanup: { status: 'needs_cleanup', reason: redactThreadText(cleanup.reason) } } : {}) };
}
