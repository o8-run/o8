import { describe, expect, it, vi } from 'vitest';

import type { TTSEngineState } from './engine';
import { stopPlaybackForDictation } from './dictation-barge-in';

function state(playbackState: TTSEngineState['state']): TTSEngineState {
  return {
    state: playbackState,
    currentTime: 0,
    duration: 0,
    playbackRate: 1,
    activeMessageId: playbackState === 'idle' ? null : 'reply-1',
    usingFallback: false,
    voiceError: null,
    activeChunk: null,
  };
}

describe('dictation barge-in', () => {
  it('stops active reply playback before dictation begins', () => {
    const stop = vi.fn();
    expect(stopPlaybackForDictation({ state: state('playing'), stop })).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('leaves an idle playback engine alone', () => {
    const stop = vi.fn();
    expect(stopPlaybackForDictation({ state: state('idle'), stop })).toBe(false);
    expect(stop).not.toHaveBeenCalled();
  });
});
