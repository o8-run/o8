'use client';

import { useMemo, useState } from 'react';
import type { DictationSnapshot, DictationState } from '@/components/desktop/dictation/types';
import { dockOwner, type DockPrecedenceInput } from '@/components/desktop/dictation/dockPrecedence';
import { IDLE_SNAPSHOT, type NativeDockSnapshot } from './useNativeDictationPill';

export interface NativeDockInput extends Omit<DockPrecedenceInput, 'dictationState' | 'panelPending'> {
  snapshot: DictationSnapshot;
  dictationSession: number;
  speechSpeed: number;
  agentTool: string;
  agentStartedAt: number;
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
 * web dock precedence picks. An idle frame marks a handoff to a still-web surface. */
export function nativeDockFrame(input: NativeDockInput, sessions: { speaking: number; voice: number }): { frame: NativeDockSnapshot; session: number } {
  if (input.snapshot.state !== 'idle') return { frame: input.snapshot, session: input.dictationSession };
  const owner = dockOwner({ ...input, dictationState: 'idle', panelPending: false });
  if (owner === 'speaking') {
    return { frame: { ...IDLE_SNAPSHOT, state: 'speaking', paused: input.ttsState === 'paused', speed: input.speechSpeed }, session: sessions.speaking };
  }
  if (owner === 'working') {
    return { frame: { ...IDLE_SNAPSHOT, state: 'working', tool: input.agentTool, startedAt: input.agentStartedAt }, session: input.agentStartedAt };
  }
  if (owner === 'voice') {
    return { frame: { ...IDLE_SNAPSHOT, state: 'voice', connecting: input.realtimeVoice === 'connecting' }, session: sessions.voice };
  }
  return { frame: owner === 'idle' ? IDLE_SNAPSHOT : { ...IDLE_SNAPSHOT, handoff: true }, session: input.dictationSession };
}

export function useNativeDockFrame(input: NativeDockInput) {
  const speaking = useEdgeSession(input.ttsState !== 'idle');
  const voice = useEdgeSession(input.realtimeVoice !== 'off');
  const { snapshot, dictationSession, ttsState, askOpen, agentConfirm, agentWorking, dropActive, stagedFiles, showWorkers, workerCount, realtimeVoice, speechSpeed, agentTool, agentStartedAt } = input;
  return useMemo(() => nativeDockFrame({
    snapshot, dictationSession, ttsState, askOpen, agentConfirm, agentWorking, dropActive, stagedFiles, showWorkers, workerCount, realtimeVoice, speechSpeed, agentTool, agentStartedAt,
  }, { speaking, voice }), [snapshot, dictationSession, ttsState, askOpen, agentConfirm, agentWorking, dropActive, stagedFiles, showWorkers, workerCount, realtimeVoice, speechSpeed, agentTool, agentStartedAt, speaking, voice]);
}

/** What the web dock draws beside the native panel. With native off this is the
 * identity, so the default path draws exactly as before. While native draws the
 * winning state the web never draws a capsule under it; with a native capsule the
 * web notch surface is not drawn at all. */
export function webDockView(native: boolean, frame: NativeDockSnapshot, dictation: DictationState, live: {
  ttsState: DockPrecedenceInput['ttsState']; realtimeVoice: DockPrecedenceInput['realtimeVoice']; agentWorking: boolean; askOpen: boolean;
}) {
  const nativeDrawn = native && frame.state !== 'idle';
  return {
    nativeDrawn,
    nativeCapsule: nativeDrawn && dictation === 'idle',
    ttsState: nativeDrawn ? 'idle' as const : live.ttsState,
    realtimeVoice: nativeDrawn ? 'off' as const : live.realtimeVoice,
    // The open Ask panel keeps its pending working row under native dictation.
    agentWorking: nativeDrawn && !live.askOpen ? false : live.agentWorking,
  };
}
