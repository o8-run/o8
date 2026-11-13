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
export function preparationFailureDetails(input: unknown): { cause: string; cleanup?: PreparationCleanup } {
  if (input instanceof WorktreePreparationCleanupError) return { cause: input.message, cleanup: input.cleanup };
  const message = input instanceof Error ? input.message : String(input);
  const index = message.indexOf(LEGACY_RETIREMENT_MARKER);
  return index < 0 ? { cause: message } : { cause: message.slice(0, index),
    cleanup: { status: 'needs_cleanup', reason: message.slice(index + LEGACY_RETIREMENT_MARKER.length) } };
}
