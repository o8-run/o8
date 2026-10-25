import { formatRippleSystemContext, parseRippleResolutionResult, type RippleAodlPatch, type RippleChoiceResolution } from '@/lib/mobile/ripple-contract';
import { readVisualDraft, saveVisualDraft, type VisualInstructionDraft } from './visual-draft-store';

export const VISUAL_MEANING_BUDGET_MS = 1_500;

/** Instruction-level seam: a future intent revision can consume the same bounded patch. */
export function visualMeaningKey(draft: VisualInstructionDraft): string {
  const { request } = draft;
  return JSON.stringify([draft.principal, request.target, request.id, request.utterance, request.clarification,
    request.frames.map(frame => [frame.id, frame.observation?.id, frame.observation?.revision,
      frame.observation?.imageHash, frame.candidates, frame.pins])]);
}
export function currentMeaningCheck(draft: VisualInstructionDraft) {
  return draft.meaningCheck?.key === visualMeaningKey(draft) ? draft.meaningCheck : undefined;
}
export function visualMeaningPatch(draft: VisualInstructionDraft): RippleAodlPatch | null {
  const check = currentMeaningCheck(draft);
  const resolution = parseRippleResolutionResult(check?.resolution);
  if (check?.status !== 'accepted' || resolution?.kind !== 'choice'
    || !resolution.options.some(option => option.value === check.selectedValue)) return null;
  return { path: resolution.aodlPath, value: check.selectedValue!, source: 'ripple', resolutionId: resolution.id };
}
export function visualMeaningContext(draft: VisualInstructionDraft) {
  const patch = visualMeaningPatch(draft);
  return patch ? `\n${formatRippleSystemContext([patch])}` : '';
}

function markedTarget(draft: VisualInstructionDraft) {
  const frame = draft.request.frames.at(-1);
  if (!frame || !frame.observation && !frame.strokes.length && !frame.pins.length) return null;
  const candidates = frame.candidates ?? [];
  const selected = draft.request.clarification?.path === 'intent.target'
    ? candidates.find(candidate => candidate.id === draft.request.clarification?.value) : undefined;
  if (candidates.length > 1 && !selected) return null;
  const target = selected ?? candidates[0];
  return { name: target?.name ?? 'Marked region', role: target?.role ?? 'region',
    ...(target ? { id: target.id, rect: target.rect } : {}), frameId: frame.id,
    ...(frame.observation ? { crop: frame.observation.crop } : {}),
    ...(frame.pins.length ? { notes: frame.pins.map(pin => pin.text).join('\n').slice(0, 1000) } : {}) };
}

/** Race the whole request and body read, even when a transport ignores AbortSignal. */
export async function checkVisualMeaning(draft: VisualInstructionDraft, current: () => boolean, transport: typeof fetch): Promise<VisualInstructionDraft | null> {
  const target = markedTarget(draft);
  if (!target || draft.request.utterance.length > 4000) return draft;
  const cached = currentMeaningCheck(draft);
  if (cached) return cached.status === 'choice' ? null : draft;
  const key = visualMeaningKey(draft);
  const started = performance.now();
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  type Result = { status: 'none' | 'choice' | 'error' | 'timeout'; resolution?: RippleChoiceResolution };
  const timeout = new Promise<Result>(resolve => { timer = setTimeout(() => { resolve({ status: 'timeout' }); abort.abort(); }, VISUAL_MEANING_BUDGET_MS); });
  const request = (async (): Promise<Result> => {
    try {
      const response = await transport('/api/mobile/ripple/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: abort.signal, body: JSON.stringify({ utterance: draft.request.utterance, markedTarget: target }) });
      if (!response.ok) return { status: 'error' };
      const resolution = parseRippleResolutionResult(await response.json());
      if (!resolution) return { status: 'error' };
      return resolution.kind === 'choice' ? { status: 'choice', resolution } : { status: 'none' };
    } catch { return { status: 'error' }; }
  })();
  const raced = await Promise.race([timeout, request]);
  clearTimeout(timer);
  const latencyMs = Math.max(0, performance.now() - started);
  const result: Result = latencyMs >= VISUAL_MEANING_BUDGET_MS ? { status: 'timeout' } : raced;
  if (result.status === 'timeout') abort.abort();
  const stored = readVisualDraft(draft.principal, draft.request.target);
  if (!current() || stored && (stored.status !== 'draft' || visualMeaningKey(stored) !== key)) return null;
  const checked = { ...(stored ?? draft), meaningCheck: { key, ...result, latencyMs } };
  // This receipt is advisory. Normal draft/queue saves carry it durably; its
  // background write must never extend the resolver's send deadline.
  void saveVisualDraft(checked, { advisory: true }).catch(() => {});
  const latest = readVisualDraft(draft.principal, draft.request.target);
  if (!current() || latest && (latest.status !== 'draft' || visualMeaningKey(latest) !== key)) return null;
  return result.status === 'choice' ? null : latest ?? checked;
}
