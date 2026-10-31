'use client';

import { RealtimeVoiceHost } from '@/components/desktop/dictation/RealtimeVoiceHost';
import { SymonTextBridgeHost } from '@/components/desktop/dictation/SymonTextBridgeHost';
import { NarrationSpeakerHost } from '@/components/desktop/dictation/NarrationSpeakerHost';
import { HeadlessDictationHost } from '@/components/desktop/dictation/HeadlessDictationHost';
import { ChatLiveHost } from '@/components/desktop/dictation/ChatLiveHost';

export default function VoiceHostPage() {
  return <><HeadlessDictationHost /><RealtimeVoiceHost /><SymonTextBridgeHost /><NarrationSpeakerHost /><ChatLiveHost /></>;
}
