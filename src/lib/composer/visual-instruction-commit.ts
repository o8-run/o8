import { readVisualDraft, saveVisualDraft, type VisualInstructionDraft } from './visual-draft-store';
import { submitVisualInstruction, VisualInstructionDeliveryError } from './visual-instruction-send';
import { invalidateVisualInspection } from './visual-inspection-client';
import { openVisualQuestion } from './visual-clarification';
import { checkVisualMeaning } from './visual-meaning';

const commits = new Map<string, Promise<Awaited<ReturnType<typeof submitVisualInstruction>> | null>>();
/** Send and deliberate voice delegation claim the same frozen request and queue ID. */
export function commitVisualInstruction(draft: VisualInstructionDraft, current: () => boolean = () => true, transport: typeof fetch = fetch) {
  const key = JSON.stringify([draft.principal, draft.request.target, draft.request.id]);
  const pending = commits.get(key); if (pending) return pending;
  const commit = (async () => {
    const stored = readVisualDraft(draft.principal, draft.request.target);
    if (stored && stored.request.id !== draft.request.id) throw new VisualInstructionDeliveryError('The visual draft changed. Review it before sending.');
    let frozen = structuredClone(stored ?? draft);
    if (frozen.status === 'saved') throw new VisualInstructionDeliveryError('This visual request is already saved in the chat.');
    // Unknown deliveries retry their frozen payload; they must never run fresh inference.
    if (frozen.status === 'draft') {
      if (openVisualQuestion(stored ?? draft)) return null;
      const checked = await checkVisualMeaning(frozen, current, transport);
      if (!checked) return null;
      frozen = structuredClone(checked);
    }
    try {
      invalidateVisualInspection(frozen.principal, frozen.request.id);
      await saveVisualDraft({ ...frozen, status: 'saving', error: undefined });
      if (!current()) throw new VisualInstructionDeliveryError('The account or conversation changed before dispatch. The original draft is retained.');
      const item = await submitVisualInstruction(frozen, transport);
      await saveVisualDraft({ ...frozen, status: 'saved', error: item.status === 'queued' ? 'Visual instruction queued in this chat.' : 'Visual instruction saved in this chat.' });
      return item;
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      await saveVisualDraft({ ...frozen, status: frozen.status !== 'unknown' && cause instanceof VisualInstructionDeliveryError && !cause.uncertain ? 'draft' : 'unknown', error }).catch(() => {});
      throw cause;
    }
  })();
  commits.set(key, commit);
  void commit.finally(() => { if (commits.get(key) === commit) commits.delete(key); }).catch(() => {});
  return commit;
}
