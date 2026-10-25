import { visualQuestionContext, answerVisualQuestion } from '@/lib/composer/visual-clarification';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { readVisualDraft, saveVisualDraft } from '@/lib/composer/visual-draft-store';
import { commitVisualInstruction } from '@/lib/composer/visual-instruction-commit';
import { prepareLiveVisual, sameVisualRouting } from '@/lib/composer/visual-live-context';
import type { VisualInstructionTarget } from '@/lib/composer/visual-instruction';
import { useLayoutEffect, useRef, type ComponentProps } from 'react';
import { ManagedLiveButton } from './ManagedLiveButton';
import { managedVoiceFollowup } from './managed-voice-followup';
import type { useDurableComposerQueue } from './useDurableComposerQueue';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';

type Props = Omit<ComponentProps<typeof ManagedLiveButton>, 'binding' | 'followup' | 'visualScope' | 'sendVisual' | 'visualContext' | 'answerVisual'> & {
  identity: unknown[];
  visualTarget: VisualInstructionTarget;
  queue: ReturnType<typeof useDurableComposerQueue>;
  capture: (text: string) => ComposerQueuePayload;
};

/** A changed chat or routing identity closes the previous pinned voice session. */
export function ManagedChatVoiceEntry({ identity, queue, capture, visualTarget, ...props }: Props) {
  const auth = useO8Auth();
  const principal = auth.user?.id ?? 'local';
  const binding = JSON.stringify([principal, ...identity]);
  const alive = useRef(true);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = useRef({ binding, loaded: auth.isLoaded });
  useLayoutEffect(() => { current.current = { binding, loaded: auth.isLoaded }; }, [binding, auth.isLoaded]);
  const visualScope = { principal, target: visualTarget, routing: capture('').routing };
  return <ManagedLiveButton {...props} key={binding} binding={binding} visualScope={visualScope}
    visualContext={() => visualQuestionContext(visualScope)} answerVisual={text => answerVisualQuestion(visualScope, text)}
    sendVisual={async (text, afterTaskId, sessionCurrent) => {
      const valid = () => alive.current && current.current.loaded && current.current.binding === binding && sessionCurrent();
      if (!valid()) throw new Error('Voice is no longer connected to this chat. The marked draft is retained.');
      const preparing = prepareLiveVisual(visualScope, text, afterTaskId);
      let draft = preparing ? await preparing : readVisualDraft(principal, visualTarget);
      if (!draft || draft.status === 'saved' || !preparing && !draft.request.frames.length) return null;
      if (!sameVisualRouting(visualScope, draft)) throw new Error('The marked draft belongs to its captured runtime and settings. Review it in the composer.');
      if (!preparing && draft.status === 'draft') {
        const utterance = draft.request.utterance.trim() === text.trim() ? draft.request.utterance : [draft.request.utterance, text].filter(Boolean).join('\n');
        draft = { ...draft, request: { ...draft.request, utterance }, template: { ...draft.template, ...(afterTaskId ? { afterTaskId } : {}) } };
        await saveVisualDraft(draft);
      }
      const item = await commitVisualInstruction(draft, valid, fetch, 'voice');
      if (!item) throw new Error('The marked draft has not been sent. Review it and use Send in the composer when ready.');
      return item;
    }} followup={managedVoiceFollowup(queue, capture)} />;
}
