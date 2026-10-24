import { inspectionKey } from './visual-inspection';
import { readVisualDraft, saveVisualDraft, type VisualInstructionDraft } from './visual-draft-store';
import type { VisualLiveScope } from './visual-live-context';
import type { RippleChoiceResolution } from '@/lib/mobile/ripple-contract';
import { currentMeaningCheck } from './visual-meaning';

const questions = new Map<string, { key: string; resolution: RippleChoiceResolution }>();
const remembered = (draft: VisualInstructionDraft) => draft.visualQuestion ?? questions.get(draftScope(draft));
const draftScope = (draft: VisualInstructionDraft) => JSON.stringify([draft.principal, draft.request.id]);
const key = (draft: VisualInstructionDraft) => {
  const frame = draft.request.frames.at(-1);
  return frame?.observation ? inspectionKey({ principal: draft.principal, requestId: draft.request.id, observation: frame.observation,
    candidates: frame.candidates ?? [], utterance: draft.request.utterance }) : null;
};
type QuestionState =
  | { kind: 'none' }
  | { kind: 'target open' | 'target dismissed' | 'target confirmed' | 'meaning open' | 'meaning answered'; question: RippleChoiceResolution };

/** One active question owns answers. Delivery closes questions without erasing their vocabulary. */
function questionState(draft: VisualInstructionDraft): QuestionState {
  const meaning = currentMeaningCheck(draft);
  if (meaning?.resolution) {
    return { kind: draft.status === 'draft' && meaning.status === 'choice' ? 'meaning open' : 'meaning answered', question: meaning.resolution };
  }
  const target = remembered(draft);
  if (!target || target.key !== key(draft)) return { kind: 'none' };
  const kind = draft.visualQuestion?.dismissed ? 'target dismissed' : draft.request.clarification ? 'target confirmed'
    : draft.status === 'draft' ? 'target open' : 'target dismissed';
  return { kind, question: target.resolution };
}
export function currentVisualQuestion(draft: VisualInstructionDraft): RippleChoiceResolution | null {
  const state = questionState(draft);
  return state.kind === 'target open' || state.kind === 'meaning open' ? state.question : null;
}
/** Explicit optional clarification uses local evidence. Uncalibrated image judgments stay observational. */
export function openVisualQuestion(draft: VisualInstructionDraft): RippleChoiceResolution | null {
  const state = questionState(draft);
  switch (state.kind) {
    case 'target open': case 'meaning open': return state.question;
    case 'target dismissed': case 'target confirmed': case 'meaning answered': return null;
    case 'none': break;
  }
  const frame = draft.request.frames.at(-1); const inputKey = key(draft);
  if (draft.status !== 'draft' || !inputKey || draft.request.clarification || !frame?.candidates || frame.candidates.length < 2 || frame.candidates.length > 4) return null;
  const question: RippleChoiceResolution = { id: `question-${crypto.randomUUID()}`, kind: 'choice', aodlPath: 'intent.target',
    question: 'Which marked component should change?', options: frame.candidates.map((candidate, index, candidates) => {
      const other = candidates.length === 2 ? candidates[1 - index] : null;
      const dx = other ? candidate.rect[0] + candidate.rect[2] / 2 - other.rect[0] - other.rect[2] / 2 : 0;
      const dy = other ? candidate.rect[1] + candidate.rect[3] / 2 - other.rect[1] - other.rect[3] / 2 : 0;
      const position = other ? Math.abs(dx) > Math.abs(dy) ? dx < 0 ? 'Left' : 'Right' : dy < 0 ? 'Upper' : 'Lower' : String(index + 1);
      return { label: `${position}: ${candidate.name}`.slice(0, 64), value: candidate.id };
    }) };
  const pendingQuestion = { key: inputKey, resolution: question };
  questions.set(draftScope(draft), pendingQuestion);
  void saveVisualDraft({ ...draft, visualQuestion: pendingQuestion }).catch(() => {});
  if (questions.size > 32) questions.delete(questions.keys().next().value!);
  return question;
}
export async function confirmVisualQuestion(draft: VisualInstructionDraft, value: string) {
  const current = readVisualDraft(draft.principal, draft.request.target);
  const question = current && currentVisualQuestion(current);
  if (!current || !question || currentVisualQuestion(draft)?.id !== question.id || !question.options.some(option => option.value === value)) return false;
  const meaning = currentMeaningCheck(current);
  if (meaning?.status === 'choice') {
    if (currentMeaningCheck(draft)?.key !== meaning.key) return false;
    await saveVisualDraft({ ...current, meaningCheck: { ...meaning, status: 'accepted', selectedValue: value } }, { advisory: true });
    return true;
  }
  if (key(current) !== key(draft)) return false;
  await saveVisualDraft({ ...current, request: { ...current.request, clarification: { id: question.id, path: question.aodlPath, value, question: question.question } } });
  return true;
}
export async function dismissVisualQuestion(draft: VisualInstructionDraft) {
  const current = readVisualDraft(draft.principal, draft.request.target);
  const question = current && currentVisualQuestion(current);
  if (!current || !question || currentVisualQuestion(draft)?.id !== question.id) return;
  const state = questionState(current);
  const meaning = currentMeaningCheck(current);
  if (state.kind === 'meaning open' && meaning) {
    await saveVisualDraft({ ...current, meaningCheck: { ...meaning, status: 'dismissed' } }, { advisory: true });
  } else if (state.kind === 'target open' && current.visualQuestion) {
    await saveVisualDraft({ ...current, visualQuestion: { ...current.visualQuestion, dismissed: true } });
  }
}
export function visualQuestionContext(scope: VisualLiveScope) {
  const draft = readVisualDraft(scope.principal, scope.target);
  const question = draft && currentVisualQuestion(draft);
  return question ? `One optional visual clarification is open: ${question.question} Options: ${question.options.map(option => option.label).join('; ')}. An answer only updates the marked draft; it never submits a coding task.` : '';
}
export async function answerVisualQuestion(scope: VisualLiveScope, text: string): Promise<string | null> {
  const draft = readVisualDraft(scope.principal, scope.target);
  if (!draft) return null;
  const state = questionState(draft);
  const answer = text.trim().replace(/[.!?]+$/, '').toLowerCase();
  switch (state.kind) {
    case 'target open': case 'meaning open': {
      if (answer === 'skip') { await dismissVisualQuestion(draft); return 'Clarification skipped. The marked draft has not been sent.'; }
      const matches = matchingOptions(draft, state.question, answer);
      if (matches.length === 1 && await confirmVisualQuestion(draft, matches[0].value)) {
        return `That ${state.kind === 'target open' ? 'target' : 'meaning'} is confirmed in the marked draft. It has not been sent.`;
      }
      return `${state.question.question} ${state.question.options.map(option => option.label).join('; ')}. The draft has not been sent.`;
    }
    case 'none': case 'target dismissed': case 'target confirmed': case 'meaning answered': {
      const prior = remembered(draft);
      if (state.kind === 'none' && draft.status === 'draft' && prior && prior.key !== key(draft)) {
        questions.delete(draftScope(draft));
        await saveVisualDraft({ ...draft, visualQuestion: undefined });
        return 'The marked target or instruction changed. Review the current draft before answering or sending.';
      }
      const closed = [prior?.resolution, draft.meaningCheck?.resolution];
      const isAnswer = /^(skip|[1-4]|first|second|third|fourth)$/.test(answer)
        || closed.some(question => question && matchingOptions(draft, question, answer).length > 0);
      if (!isAnswer) return null;
      if (draft.status !== 'draft' || state.kind === 'target dismissed') return 'That clarification is closed. No new instruction has been sent.';
      if (state.kind === 'target confirmed') return 'That target is already confirmed. The marked draft has not been sent.';
      if (state.kind === 'meaning answered' && draft.meaningCheck?.status === 'accepted') return 'That meaning is already confirmed. The marked draft has not been sent.';
      return 'No clarification is open. The marked draft has not been sent. Use Send in the composer when ready.';
    }
  }
}

function matchingOptions(draft: VisualInstructionDraft, question: RippleChoiceResolution, answer: string) {
  return question.options.filter((option, index) => {
    const aliases = [option.value, option.label, String(index + 1), ['first', 'second', 'third', 'fourth'][index]];
    if (question.id === remembered(draft)?.resolution.id) aliases.push(draft.request.frames.at(-1)?.candidates?.[index]?.name ?? '',
      option.label.split(':')[0], `the ${option.label.split(':')[0].toLowerCase()} one`);
    return aliases.some(value => value.toLowerCase() === answer);
  });
}

export function visualQuestionEvidence(draft: VisualInstructionDraft) {
  const value = remembered(draft);
  return !draft.request.clarification && value?.key === key(draft) ? value.resolution : null;
}
