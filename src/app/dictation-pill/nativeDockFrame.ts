'use client';

import { useCallback, useMemo, useState } from 'react';
import type { DictationSnapshot, DictationState } from '@/components/desktop/dictation/types';
import { dockOwner, type DockPrecedenceInput } from '@/components/desktop/dictation/dockPrecedence';
import { useEditRevert, type EditChipState } from './EditRevertChip';
import type { TimedGlint } from './DockGlint';
import {
  IDLE_SNAPSHOT, useNativeDictationPill, useNativePillDockExtent, type DockWorkers, type NativeDockAction, type NativeDockSnapshot,
} from './useNativeDictationPill';

export interface NativeDockInput extends Omit<DockPrecedenceInput, 'dictationState' | 'panelPending'> {
  snapshot: DictationSnapshot;
  dictationSession: number;
  speechSpeed: number;
  agentTool: string;
  agentStartedAt: number;
  /** The siblings drawn below the dock surface, and the fleet detail. */
  edit?: EditChipState | null;
  glint?: TimedGlint | null;
  workers?: DockWorkers;
}
type Sessions = { speaking: number; voice: number; workers?: number; extras?: number };

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
  if (input.snapshot.state !== 'idle') {
    const webBeside = input.askOpen || input.agentConfirm || input.dropActive || input.stagedFiles;
    return { frame: webBeside ? input.snapshot : below(input.snapshot), session: input.dictationSession };
  }
  const owner = dockOwner({ ...input, dictationState: 'idle', panelPending: false });
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
  const { snapshot, dictationSession, ttsState, askOpen, agentConfirm, agentWorking, dropActive, stagedFiles, showWorkers, workerCount, realtimeVoice, speechSpeed, agentTool, agentStartedAt, edit, glint } = input;
  // The page builds the fleet detail per render; its values, not its identity, change the frame.
  const { count, working, waiting, label } = input.workers ?? {};
  const repos = input.workers?.repos.join('\n');
  const workers = useMemo(() => (count === undefined ? undefined : {
    count, working: working ?? 0, waiting: waiting ?? 0, label: label ?? 'waiting', repos: repos ? repos.split('\n') : [],
  }), [count, working, waiting, label, repos]);
  return useMemo(() => nativeDockFrame({
    snapshot, dictationSession, ttsState, askOpen, agentConfirm, agentWorking, dropActive, stagedFiles, showWorkers, workerCount, realtimeVoice, speechSpeed, agentTool, agentStartedAt, edit, glint, workers,
  }, { speaking, voice, workers: workerSession, extras }), [snapshot, dictationSession, ttsState, askOpen, agentConfirm, agentWorking, dropActive, stagedFiles, showWorkers, workerCount, realtimeVoice, speechSpeed, agentTool, agentStartedAt, edit, glint, workers, speaking, voice, workerSession, extras]);
}

/** What the web dock draws beside the native panel. With native off this is the
 * identity, so the default path draws exactly as before. While native draws the
 * winning state the web never draws a capsule under it; with a native capsule the
 * web notch surface is not drawn at all. Native draws the fleet orbit and detail
 * capsule (or dictation hides them, as on the web), and the chip or glint a
 * drawn frame carries. */
export function webDockView(native: boolean, frame: NativeDockSnapshot, dictation: DictationState, live: {
  ttsState: DockPrecedenceInput['ttsState']; realtimeVoice: DockPrecedenceInput['realtimeVoice']; agentWorking: boolean; askOpen: boolean;
  showWorkers?: boolean; workerCount?: number;
}) {
  const nativeDrawn = native && frame.state !== 'idle';
  return {
    nativeDrawn,
    nativeCapsule: nativeDrawn && dictation === 'idle',
    ttsState: nativeDrawn ? 'idle' as const : live.ttsState,
    realtimeVoice: nativeDrawn ? 'off' as const : live.realtimeVoice,
    // The open Ask panel keeps its pending working row under native dictation.
    agentWorking: nativeDrawn && !live.askOpen ? false : live.agentWorking,
    showWorkers: native ? false : live.showWorkers ?? false,
    workerCount: native ? 0 : live.workerCount ?? 0,
    nativeEdit: nativeDrawn && frame.edit !== undefined,
    nativeGlint: nativeDrawn && frame.glint !== undefined,
  };
}

/** The dock page's native wiring: the frame, the hook, and the clicks it reports
 * routed to the same handlers the web controls call. */
export function useNativeDock(input: Omit<NativeDockInput, 'edit'>, handlers: {
  finishSystemDictation: () => void; handleTogglePause: () => void; handleStop: () => void; handleInterrupt: () => void;
  stopRealtimeVoice: () => void; handleSpeechSpeed: (rate: number) => void; expandWorkers: () => void;
  invokeCmd: (command: string, args: Record<string, unknown>) => void; onError: (message: string) => void;
}, retained: { topPillEnabled: boolean; staged: boolean }) {
  const { edit, revert } = useEditRevert(handlers.onError);
  const nativeFrame = useNativeDockFrame({ ...input, edit });
  const { finishSystemDictation, handleTogglePause, handleStop, handleInterrupt, stopRealtimeVoice, handleSpeechSpeed, expandWorkers } = handlers;
  const onNativeAction = useCallback((clicked: NativeDockAction) => {
    if (clicked.action === 'revert') void revert();
    else if (clicked.action === 'workers-expand') expandWorkers();
    else if (clicked.action === 'pause') handleTogglePause();
    else if (clicked.action === 'stop') handleStop();
    else if (clicked.action === 'interrupt') handleInterrupt();
    else if (clicked.action === 'voice-stop') stopRealtimeVoice();
    else if (typeof clicked.value === 'number' && clicked.value >= 0.7 && clicked.value <= 1.2) handleSpeechSpeed(clicked.value);
  }, [revert, expandWorkers, handleTogglePause, handleStop, handleInterrupt, stopRealtimeVoice, handleSpeechSpeed]);
  const { native, suppressed } = useNativeDictationPill(nativeFrame.frame, nativeFrame.session, finishSystemDictation, onNativeAction);
  const view = webDockView(native, nativeFrame.frame, input.snapshot.state, {
    ttsState: input.ttsState, realtimeVoice: input.realtimeVoice, agentWorking: input.agentWorking, askOpen: input.askOpen,
    showWorkers: input.showWorkers, workerCount: input.workerCount,
  });
  const nativeActive = view.nativeDrawn && !suppressed;
  // Retained web surfaces keep the dock visible under native ownership.
  const dockVisible = (!native || !suppressed) && ((!native && (retained.topPillEnabled || input.snapshot.state !== 'idle'))
    || view.ttsState !== 'idle' || input.askOpen || view.agentWorking || input.agentConfirm || view.realtimeVoice !== 'off'
    || (native && ((!!edit && !view.nativeEdit) || (!view.nativeCapsule && (input.dropActive || retained.staged)) || (!!input.glint && !view.nativeGlint))));
  useNativePillDockExtent(native, nativeActive, dockVisible, input.askOpen, suppressed, handlers.invokeCmd);
  return {
    native, suppressed, dockVisible, nativeCapsule: view.nativeCapsule, nativeActive,
    webSnapshot: native ? IDLE_SNAPSHOT : input.snapshot,
    webTts: view.ttsState, webRealtime: view.realtimeVoice, webAgentWorking: view.agentWorking,
    webShowWorkers: view.showWorkers, webWorkerCount: view.workerCount,
    edit, revertEdit: revert, webEdit: view.nativeEdit ? null : edit, webGlint: view.nativeGlint ? null : input.glint ?? null,
  };
}
