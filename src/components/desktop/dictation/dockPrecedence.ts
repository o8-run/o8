import type { DictationState } from './types';

/** The inputs the notch dock uses to pick its one visible surface. */
export interface DockPrecedenceInput {
  dictationState: DictationState;
  ttsState: 'idle' | 'playing' | 'paused';
  askOpen: boolean;
  panelPending: boolean;
  agentConfirm: boolean;
  agentWorking: boolean;
  dropActive: boolean;
  stagedFiles: boolean;
  showWorkers: boolean;
  workerCount: number;
  realtimeVoice: 'off' | 'connecting' | 'live';
}

/** Which surface each dock flag claims. DockNotchSurface renders from these flags,
 * so the native dock and the web dock share one precedence. */
export function dockSurfaces(input: DockPrecedenceInput) {
  const dictationIdle = input.dictationState === 'idle';
  // Real dictation wins over speaking: holding Fn over speech shows the recording.
  const isSpeaking = dictationIdle && (input.ttsState === 'playing' || input.ttsState === 'paused');
  // The Ask panel yields to dictation (unless the dictation is a pending turn
  // inside it) and wins over speaking, because its answer is read aloud.
  const isAsking = input.askOpen && (dictationIdle || input.panelPending);
  // A pending confirm wins over everything except a real dictation.
  const isConfirming = input.agentConfirm && dictationIdle;
  const isAgentWorking = input.agentWorking && !isConfirming && dictationIdle && !isAsking && !isSpeaking;
  // A live drag wins, but never over dictation, the confirm gate or the Ask panel.
  const isDropTarget = input.dropActive && dictationIdle && !isConfirming && !isAsking;
  const isStagedChips = !isDropTarget && input.stagedFiles && dictationIdle
    && !isConfirming && !isAsking && !isSpeaking && !isAgentWorking;
  const isWorkersInfo = input.showWorkers && input.workerCount > 0 && dictationIdle && !isConfirming
    && !isAsking && !isSpeaking && !isAgentWorking && !isDropTarget && !isStagedChips;
  // Live voice is ambient: it yields to every other surface, then resumes.
  const isRealtimeVoice = input.realtimeVoice !== 'off' && dictationIdle && !isConfirming
    && !isAsking && !isSpeaking && !isAgentWorking && !isDropTarget && !isStagedChips && !isWorkersInfo;
  return { isSpeaking, isAsking, isConfirming, isAgentWorking, isDropTarget, isStagedChips, isWorkersInfo, isRealtimeVoice };
}

export type DockOwner = 'dictation' | 'confirm' | 'drop' | 'staged' | 'working' | 'workers' | 'voice' | 'ask' | 'speaking' | 'idle';

/** The surface DockNotchSurface draws, in its body order. */
export function dockOwner(input: DockPrecedenceInput): DockOwner {
  const s = dockSurfaces(input);
  if (s.isConfirming) return 'confirm';
  if (s.isDropTarget) return 'drop';
  if (s.isStagedChips) return 'staged';
  if (s.isAgentWorking) return 'working';
  if (s.isWorkersInfo) return 'workers';
  if (s.isRealtimeVoice) return 'voice';
  if (s.isAsking) return 'ask';
  if (s.isSpeaking) return 'speaking';
  return input.dictationState === 'idle' ? 'idle' : 'dictation';
}
