'use client';

import { useEffect, useRef, useState } from 'react';
import type { DictationSnapshot } from '@/components/desktop/dictation/types';
import { isTauri } from '@/lib/tauri/bridge';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';

/** The native window acknowledges preparation before React relinquishes drawing.
 * Frames are sent only from the effect after that hidden render has committed.
 * On failure wait beyond the native 750ms lease and 160ms exit before restoring web drawing. */
export function useNativeDictationPill(snapshot: DictationSnapshot): boolean {
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const [native, setNative] = useState(false);
  const owned = useRef(false);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const request = async (action: string, frame?: DictationSnapshot) => {
      const response = await fetch('/api/next/dictation-pill', {
        method: 'POST', headers: { 'Content-Type': 'application/json', authorization: 'Bearer ' + getMobileWsToken() },
        body: JSON.stringify({ action, snapshot: frame ? { ...frame, partialTranscript: frame.partialTranscript.slice(0, 1000), pastedText: frame.pastedText?.slice(0, 1000), error: frame.error?.slice(0, 240) ?? null } : undefined }), signal: AbortSignal.timeout(10000),
      });
      return response.ok && (await response.json()).native === true;
    };
    const poll = async () => {
      let available = false;
      try { available = await request(owned.current ? 'frame' : 'prepare', owned.current ? latest.current : undefined); } catch { /* lease restores the web fallback */ }
      if (disposed) return;
      if (available && !owned.current) {
        setNative(true);
        // A separate effect publishes only after the hidden web render commits.
        return;
      }
      if (!available && owned.current) {
        timer = setTimeout(() => {
          if (disposed) return;
          owned.current = false;
          setNative(false);
        }, 1000);
        return;
      }
      timer = setTimeout(() => { void poll(); }, available ? 100 : 1000);
    };
    if (native) owned.current = true;
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [native]);
  return native;
}
