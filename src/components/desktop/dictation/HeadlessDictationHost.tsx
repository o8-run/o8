'use client';

import { useEffect } from 'react';
import { isVoiceBinding, voiceHostId, type VoiceHostPayload } from '@/lib/next/voice-host';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';
import { canUseTauriEvents } from '@/lib/tauri/bridge';
import { listenTauriEvent } from '@/lib/tauri/events';
import { sttInvoke, type SttEventPayload } from './useNativeDictation';
import { NativeDictationController, type DictationCommand } from './native-dictation-controller';

export function HeadlessDictationHost() {
  useEffect(() => {
    if (!canUseTauriEvents() || !(window as Window & { __O8_VOICE_HOST__?: boolean }).__O8_VOICE_HOST__) return;
    let disposed = false;
    let publishing = Promise.resolve();
    const ready = listenTauriEvent<SttEventPayload>('o8:stt-event', event => controller.event(event.payload));
    void ready.catch(() => {});
    const controller = new NativeDictationController({ ready, invoke: sttInvoke, emit: frame => {
      publishing = publishing.then(async () => {
        if (disposed) return;
        const response = await fetch('/api/next/voice-host', { method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${getMobileWsToken()}` }, body: JSON.stringify({ action: 'publish', ...frame }) });
        if (!response.ok) throw new Error('Dictation relay unavailable.');
      }).catch(() => { controller.abort('Dictation relay unavailable. Recording stopped.', frame.payload as Partial<DictationCommand>); });
    } });
    const command = (event: Event) => {
      const value = (event as CustomEvent<VoiceHostPayload>).detail;
      if (!value || !isVoiceBinding(value) || !voiceHostId(value.hostId) || !voiceHostId(value.requestId)
        || !['dictation-start', 'dictation-stop'].includes(value.action)
        || value.action === 'dictation-stop' && typeof value.submit !== 'boolean') return;
      controller.command(value as DictationCommand);
    };
    const stop = () => controller.abort();
    const replay = (event: Event) => controller.replayState((event as CustomEvent<string>).detail);
    window.addEventListener('o8:voice-host-dictation-command', command);
    window.addEventListener('o8:voice-host-stop-all', stop);
    window.addEventListener('o8:voice-host-ready', replay);
    return () => {
      disposed = true; controller.dispose();
      window.removeEventListener('o8:voice-host-dictation-command', command);
      window.removeEventListener('o8:voice-host-stop-all', stop);
      window.removeEventListener('o8:voice-host-ready', replay);
      void ready.then(unlisten => unlisten()).catch(() => {});
    };
  }, []);
  return null;
}
