export type EdgeVoiceError = 'edge_voice_update_required' | 'edge_voice_unavailable';

export function isEdgeVoiceError(code: unknown): code is EdgeVoiceError {
  return code === 'edge_voice_update_required' || code === 'edge_voice_unavailable';
}

export function edgeVoiceNotice(code: EdgeVoiceError | null): string | null {
  if (!code) return null;
  return code === 'edge_voice_update_required'
    ? 'Steffan needs a voice update. Using the system voice.'
    : 'Steffan is unavailable. Using the system voice.';
}
