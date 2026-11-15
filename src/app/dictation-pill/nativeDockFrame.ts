'use client';

import { useCallback, useMemo, useState } from 'react';
import type { DictationSnapshot, DictationState } from '@/components/desktop/dictation/types';
import { dockOwner, type DockPrecedenceInput } from '@/components/desktop/dictation/dockPrecedence';
import { useEditRevert, type EditChipState } from './EditRevertChip';
import type { TimedGlint } from './DockGlint';
import { askFrame, useAskCopy, useRevision, type NativeAskInput } from './nativeDockAsk';
import type { AgentConfirmation } from '@/components/desktop/dictation/useAgentConfirmations';
import type { StagedChip } from '@/components/desktop/dictation/useDockFileDrop';
import {
  IDLE_SNAPSHOT, useNativeDictationPill, useNativePillDockExtent, type DockWorkers, type NativeDockAction, type NativeDockSnapshot,
} from './useNativeDictationPill';

export interface NativeDockInput extends Omit<DockPrecedenceInput, 'dictationState' | 'panelPending'> {
  snapshot: DictationSnapshot;
  dictationSession: number;
  speechSpeed: number;
  agentTool: string;
  agentStartedAt: number;
  /** The web dock's top-pill preference (dictation_top_pill): without it the
   * web shows nothing at idle, so neither does the native panel. */
  topPill?: boolean;
  /** The siblings drawn below the dock surface, and the fleet detail. */
  edit?: EditChipState | null;
  glint?: TimedGlint | null;
  workers?: DockWorkers;
  /** The Ask panel's content while it is open, its thread revision and the
   * answer whose copy just succeeded. */
  ask?: NativeAskInput;
  askRev?: number;
  askCopied?: number | null;
  /** The pending confirmation card (`agentConfirm` is its presence). */
  confirmCard?: AgentConfirmation | null;
  /** The staged-file chips (`stagedFiles` is their presence). */
  stagedChips?: StagedChip[] | null;
}
type Sessions = { speaking: number; voice: number; workers?: number; extras?: number; ask?: number; confirm?: number; drop?: number; staged?: number };

/** DockNotchSurface's chip size label. */
export function stagedSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** A session number for each idle-to-active edge; it holds while active. The
 * frame state names the capsule, so numbers only need to differ within one kind. */
function useEdgeSession(active: boolean): number {
  const [edge, setEdge] = useState({ active: false, session: 0 });
  const session = active && !edge.active ? edge.session + 1 : edge.session;
  if (active !== edge.active) setEdge({ active, session });
  return session;
}

/** The one frame the native panel draws: dictation first, then the capsule the
 * web dock precedence picks. An idle frame marks a handoff to a still-web surface.
 *
 * The edit chip and glints are not in the precedence order: the web draws them
 * below whatever the dock shows. They go with the dock surface: native when the
 * native panel draws it (or the dock is otherwise empty), web when the web
 * draws a surface (a handoff, or Ask, a confirmation, a drop or staged files
 * beside native dictation). With nothing else on screen the fleet orbit (or
 * the chip/glint alone, state `extras`) is the frame. */
export function nativeDockFrame(input: NativeDockInput, sessions: Sessions): { frame: NativeDockSnapshot; session: number } {
  const workers = input.workers ?? { count: input.workerCount, working: input.workerCount, waiting: 0, label: 'waiting', repos: [] };
  const below = (frame: NativeDockSnapshot): NativeDockSnapshot => (input.edit || input.glint ? {
    ...frame, ...(input.edit ? { edit: input.edit } : {}), ...(input.glint ? { glint: input.glint } : {}),
  } : frame);
  // An agent dictation that is a pending turn inside the open panel is drawn
  // there, as on the web; otherwise dictation wins and Ask is drawn nowhere.
  const panelPending = !!input.ask?.pending;
  const owner = dockOwner({ ...input, dictationState: input.snapshot.state, panelPending });
  if (owner === 'ask') {
    const ask = askFrame(input.ask ?? { mode: 'answer', thread: [], pending: null }, input.askRev ?? 0, input, input.askCopied ?? null);
    const level = input.snapshot.state === 'recording' ? input.snapshot.audioLevel : 0;
    return { frame: below({ ...IDLE_SNAPSHOT, state: 'ask', audioLevel: level, ask }), session: sessions.ask ?? 0 };
  }
  if (owner === 'confirm' && input.confirmCard) {
    const card = input.confirmCard;
    const plan = card.kind === 'plan' && card.plan?.steps.length ? card.plan.steps : null;
    const confirm = { id: card.confirmationId, task: card.taskId, kind: plan ? 'plan' as const : 'action' as const, summary: card.summary, ...(plan ? { steps: plan } : {}) };
    return { frame: below({ ...IDLE_SNAPSHOT, state: 'confirm', confirm }), session: sessions.confirm ?? 0 };
  }
  // A confirmation, a drop or staged files wait behind a real dictation on
  // both surfaces, as on the web.
  if (input.snapshot.state !== 'idle') return { frame: below(input.snapshot), session: input.dictationSession };
  if (owner === 'speaking') {
    return { frame: below({ ...IDLE_SNAPSHOT, state: 'speaking', paused: input.ttsState === 'paused', speed: input.speechSpeed }), session: sessions.speaking };
  }
  if (owner === 'working') {
    return { frame: below({ ...IDLE_SNAPSHOT, state: 'working', tool: input.agentTool, startedAt: input.agentStartedAt }), session: input.agentStartedAt };
  }
  if (owner === 'voice') {
    // Live voice carries the in-flight worker count, as the web capsule does.
    const carried = input.realtimeVoice === 'live' && workers.working > 0 ? { workers } : {};
    return { frame: below({ ...IDLE_SNAPSHOT, state: 'voice', connecting: input.realtimeVoice === 'connecting', ...carried }), session: sessions.voice };
  }
  // The web dock shows the fleet or a lone chip/glint only while it is visible
  // for another reason (page.tsx dockVisible): the top-pill preference or, under
  // the expanded fleet capsule, live voice. Otherwise neither dock draws them.
  const webShown = input.topPill === true || input.ttsState !== 'idle' || input.askOpen || input.agentWorking
    || input.agentConfirm || input.realtimeVoice !== 'off';
  // The drop target and staged chips follow the same rule (main hides the web dock without it).
  if (!webShown && (owner === 'drop' || owner === 'staged')) return { frame: IDLE_SNAPSHOT, session: input.dictationSession };
  if (owner === 'drop') return { frame: below({ ...IDLE_SNAPSHOT, state: 'drop' }), session: sessions.drop ?? 0 };
  if (owner === 'staged' && input.stagedChips?.length) {
    const chips = input.stagedChips;
    const staged = { files: chips.slice(0, 3).map(chip => ({ name: chip.name, size: stagedSize(chip.size) })), extra: Math.max(0, chips.length - 3) };
    return { frame: below({ ...IDLE_SNAPSHOT, state: 'staged', staged }), session: sessions.staged ?? 0 };
  }
  if (!webShown && (owner === 'workers' || owner === 'idle')) return { frame: IDLE_SNAPSHOT, session: input.dictationSession };
  if (owner === 'workers' || owner === 'idle' && input.workerCount > 0) {
    return { frame: below({ ...IDLE_SNAPSHOT, state: 'workers', expanded: owner === 'workers', workers }), session: sessions.workers ?? 0 };
  }
  if (owner === 'idle' && (input.edit || input.glint)) return { frame: below({ ...IDLE_SNAPSHOT, state: 'extras' }), session: sessions.extras ?? 0 };
  return { frame: owner === 'idle' ? IDLE_SNAPSHOT : { ...IDLE_SNAPSHOT, handoff: true }, session: input.dictationSession };
}

export function useNativeDockFrame(input: NativeDockInput) {
  const speaking = useEdgeSession(input.ttsState !== 'idle');
  const voice = useEdgeSession(input.realtimeVoice !== 'off');
  const workerSession = useEdgeSession(input.workerCount > 0);
  const extras = useEdgeSession(!!input.edit || !!input.glint);
  const askSession = useEdgeSession(input.askOpen);
  // Each card is its own session, so a click queued for one is never run for the next.
  const dropSession = useEdgeSession(input.dropActive);
  const stagedSession = useRevision(input.stagedChips ?? null);
  const confirmSession = useRevision(input.confirmCard ? `${input.confirmCard.confirmationId}\n${input.confirmCard.taskId}` : '');
  const { snapshot, dictationSession, ttsState, askOpen, agentConfirm, agentWorking, dropActive, stagedFiles, showWorkers, workerCount, realtimeVoice, speechSpeed, agentTool, agentStartedAt, edit, glint, topPill, ask, askRev, askCopied, confirmCard, stagedChips } = input;
  // The page builds the fleet detail per render; its values, not its identity, change the frame.
  const { count, working, waiting, label } = input.workers ?? {};
  const repos = input.workers?.repos.join('\n');
  const workers = useMemo(() => (count === undefined ? undefined : {
    count, working: working ?? 0, waiting: waiting ?? 0, label: label ?? 'waiting', repos: repos ? repos.split('\n') : [],
  }), [count, working, waiting, label, repos]);
  return useMemo(() => nativeDockFrame({
    snapshot, dictationSession, ttsState, askOpen, agentConfirm, agentWorking, dropActive, stagedFiles, showWorkers, workerCount, realtimeVoice, speechSpeed, agentTool, agentStartedAt, edit, glint, workers, topPill, ask, askRev, askCopied, confirmCard, stagedChips,
  }, { speaking, voice, workers: workerSession, extras, ask: askSession, confirm: confirmSession, drop: dropSession, staged: stagedSession }), [snapshot, dictationSession, ttsState, askOpen, agentConfirm, agentWorking, dropActive, stagedFiles, showWorkers, workerCount, realtimeVoice, speechSpeed, agentTool, agentStartedAt, edit, glint, workers, topPill, ask, askRev, askCopied, confirmCard, stagedChips, speaking, voice, workerSession, extras, askSession, confirmSession, dropSession, stagedSession]);
}

/** What the web dock draws beside the native panel. With native off this is the
 * identity, so the default path draws exactly as before. While native draws the
 * winning state the web never draws a capsule or the Ask panel under it; with a
 * native capsule or Ask panel the web notch surface is not drawn at all. Native draws the fleet orbit and detail
 * capsule (or dictation hides them, as on the web), and the chip or glint a
 * drawn frame carries. */
export function webDockView(native: boolean, frame: NativeDockSnapshot, dictation: DictationState, live: {
  ttsState: DockPrecedenceInput['ttsState']; realtimeVoice: DockPrecedenceInput['realtimeVoice']; agentWorking: boolean; askOpen: boolean;
  showWorkers?: boolean; workerCount?: number; agentConfirm?: boolean; dropActive?: boolean; stagedFiles?: boolean;
}) {
  const nativeDrawn = native && frame.state !== 'idle';
  return {
    nativeDrawn,
    nativeCapsule: nativeDrawn && (dictation === 'idle' || frame.state === 'ask' || frame.state === 'confirm'),
    // Native draws the drop target and chips, or a drawn state outranks them, as on the web.
    dropActive: nativeDrawn ? false : live.dropActive ?? false,
    stagedFiles: nativeDrawn ? false : live.stagedFiles ?? false,
    ttsState: nativeDrawn ? 'idle' as const : live.ttsState,
    realtimeVoice: nativeDrawn ? 'off' as const : live.realtimeVoice,
    // Native draws the Ask panel, or dictation hides it, as on the web.
    askOpen: nativeDrawn ? false : live.askOpen,
    // Native draws the card, or dictation holds it back, as on the web.
    agentConfirm: nativeDrawn ? false : live.agentConfirm ?? false,
    agentWorking: nativeDrawn ? false : live.agentWorking,
    showWorkers: native ? false : live.showWorkers ?? false,
    workerCount: native ? 0 : live.workerCount ?? 0,
    nativeEdit: nativeDrawn && frame.edit !== undefined,
    nativeGlint: nativeDrawn && frame.glint !== undefined,
  };
}

/** Whether the web dock window shows. Under native ownership only what the
 * web still draws keeps it visible; the chip and glint never do on their own. */
export function webDockVisible(native: boolean, suppressed: boolean, view: ReturnType<typeof webDockView>,
  input: Pick<NativeDockInput, 'snapshot'>, retained: { topPillEnabled: boolean }) {
  return (!native || !suppressed) && ((!native && (retained.topPillEnabled || input.snapshot.state !== 'idle'))
    || view.ttsState !== 'idle' || view.askOpen || view.agentWorking || view.agentConfirm || view.realtimeVoice !== 'off');
}

/** The dock page's native wiring: the frame, the hook, and the clicks it reports
 * routed to the same handlers the web controls call. */
export function useNativeDock(input: Omit<NativeDockInput, 'edit' | 'askRev' | 'askCopied'>, handlers: {
  finishSystemDictation: () => void; handleTogglePause: () => void; handleStop: () => void; handleInterrupt: () => void;
  stopRealtimeVoice: () => void; handleSpeechSpeed: (rate: number) => void; expandWorkers: () => void;
  closeAsk?: () => void; armAskIdle?: () => void;
  decideConfirm?: (confirmationId: string, taskId: string, allow: boolean) => void;
  invokeCmd: (command: string, args: Record<string, unknown>) => void; onError: (message: string) => void;
}, retained: { topPillEnabled: boolean; staged: boolean }) {
  const { edit, revert } = useEditRevert(handlers.onError);
  const thread = input.ask?.thread;
  const askRev = useRevision(thread);
  const { copied: askCopied, copy } = useAskCopy(thread ?? []);
  const nativeFrame = useNativeDockFrame({ ...input, edit, topPill: retained.topPillEnabled, askRev, askCopied });
  const { finishSystemDictation, handleTogglePause, handleStop, handleInterrupt, stopRealtimeVoice, handleSpeechSpeed, expandWorkers, closeAsk, armAskIdle, decideConfirm } = handlers;
  const onNativeAction = useCallback((clicked: NativeDockAction) => {
    if (clicked.action === 'revert') void revert();
    else if (clicked.action === 'confirm-allow' || clicked.action === 'confirm-deny') {
      if (clicked.ref && clicked.task) decideConfirm?.(clicked.ref, clicked.task, clicked.action === 'confirm-allow');
    } else if (clicked.action === 'ask-close') closeAsk?.();
    else if (clicked.action === 'ask-active') armAskIdle?.();
    else if (clicked.action === 'ask-copy') { if (typeof clicked.value === 'number') void copy(clicked.value); }
    else if (clicked.action === 'workers-expand') expandWorkers();
    else if (clicked.action === 'pause') handleTogglePause();
    else if (clicked.action === 'stop') handleStop();
    else if (clicked.action === 'interrupt') handleInterrupt();
    else if (clicked.action === 'voice-stop') stopRealtimeVoice();
    else if (typeof clicked.value === 'number' && clicked.value >= 0.7 && clicked.value <= 1.2) handleSpeechSpeed(clicked.value);
  }, [revert, decideConfirm, closeAsk, armAskIdle, copy, expandWorkers, handleTogglePause, handleStop, handleInterrupt, stopRealtimeVoice, handleSpeechSpeed]);
  const { native, suppressed } = useNativeDictationPill(nativeFrame.frame, nativeFrame.session, finishSystemDictation, onNativeAction);
  const view = webDockView(native, nativeFrame.frame, input.snapshot.state, {
    ttsState: input.ttsState, realtimeVoice: input.realtimeVoice, agentWorking: input.agentWorking, askOpen: input.askOpen,
    showWorkers: input.showWorkers, workerCount: input.workerCount, agentConfirm: input.agentConfirm,
    dropActive: input.dropActive, stagedFiles: input.stagedFiles,
  });
  // The glint the native panel last drew; if the web takes that same glint
  // over, it is a hand-back and must not replay its fade-in.
  const [nativeGlint, setNativeGlint] = useState<TimedGlint | null>(null);
  if (view.nativeGlint && input.glint && nativeGlint !== input.glint) setNativeGlint(input.glint);
  const nativeActive = view.nativeDrawn && !suppressed;
  const dockVisible = webDockVisible(native, suppressed, view, input, retained);
  useNativePillDockExtent(native, nativeActive, dockVisible, view.askOpen, suppressed, handlers.invokeCmd);
  return {
    native, suppressed, dockVisible, nativeCapsule: view.nativeCapsule, nativeActive,
    webSnapshot: native ? IDLE_SNAPSHOT : input.snapshot, webAskOpen: view.askOpen, webAgentConfirm: view.agentConfirm, webDropActive: view.dropActive, webStaged: view.stagedFiles,
    webTts: view.ttsState, webRealtime: view.realtimeVoice, webAgentWorking: view.agentWorking,
    webShowWorkers: view.showWorkers, webWorkerCount: view.workerCount,
    edit, revertEdit: revert, webEdit: view.nativeEdit ? null : edit, webGlint: view.nativeGlint ? null : input.glint ?? null,
    webGlintHandedBack: !view.nativeGlint && !!input.glint && input.glint === nativeGlint,
  };
}
