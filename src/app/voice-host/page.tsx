'use client';

import { RealtimeVoiceHost } from '@/components/desktop/dictation/RealtimeVoiceHost';
import { SymonTextBridgeHost } from '@/components/desktop/dictation/SymonTextBridgeHost';
import { NarrationSpeakerHost } from '@/components/desktop/dictation/NarrationSpeakerHost';
import { ChatLiveHost } from '@/components/desktop/dictation/ChatLiveHost';

export default function VoiceHostPage() {
  return <><RealtimeVoiceHost /><SymonTextBridgeHost /><NarrationSpeakerHost /><ChatLiveHost /></>;
}
