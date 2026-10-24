'use client';

import { useEffect, useState } from 'react';
import type { ControllerSnapshot } from '@/lib/devices/controller-events';

/** Ownership pushes are independent of helper polling; a disconnected stream fails closed. */
export function useDeviceControllerStream(active: boolean, receive: (snapshot: ControllerSnapshot) => void): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const response = await fetch('/api/panel/devices?stream=controllers', { signal: abort.signal, cache: 'no-store' });
        if (!response.ok || response.headers.get('content-type') !== 'text/event-stream' || !response.body) throw new Error('Ownership stream unavailable');
        reader = response.body.getReader();
        const decoder = new TextDecoder(); let buffer = '';
        while (!abort.signal.aborted) {
          const result = await reader.read(); if (result.done) break;
          buffer += decoder.decode(result.value, { stream: true });
          if (buffer.length > 1_000_000) throw new Error('Ownership stream exceeded its limit');
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            if (!frame.startsWith('data: ')) continue;
            const value = JSON.parse(frame.slice(6));
            if (!Number.isSafeInteger(value.revision) || !Array.isArray(value.controllers)) throw new Error('Invalid ownership state');
            if (!abort.signal.aborted) { receive(value); setConnected(true); }
          }
        }
      } catch { /* Input stays disabled until a fresh authenticated snapshot arrives. */ }
      finally { await reader?.cancel().catch(() => {}); reader = undefined; }
      if (!abort.signal.aborted) { setConnected(false); retry = setTimeout(() => { void connect(); }, 1_000); }
    };
    setConnected(false); void connect();
    return () => { abort.abort(); void reader?.cancel().catch(() => {}); clearTimeout(retry); setConnected(false); };
  }, [active, receive]);
  return active && connected;
}
