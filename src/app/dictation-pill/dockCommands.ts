'use client';

import { isTauri } from '@/lib/tauri/bridge';

/**
 * Dock-route morph instrumentation. This route runs in a SECOND webview whose
 * `console.log` does NOT reach `~/Library/Logs/ai.o8.desktop/o8.log`, so when
 * the dock fails to morph there is no server trace to inspect. `o8_dock_log`
 * (a thin Tauri command → `tracing::info!("[dock-route] …")`) lets us SEE which
 * `o8:stt-event` payloads actually arrive at the dock webview. Fire-and-forget;
 * never throws. Skip the high-frequency partial/level events at the call site.
 */
export function dockLog(msg: string) {
  if (!isTauri()) return;
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('o8_dock_log', { msg }))
    .catch(() => { /* noop — never let logging break the morph */ });
}

/** Fire a Tauri command from the dock webview (TTS controls, dock resize).
 * Fire-and-forget; never throws (the dock must never crash on a control tap). */
export function invokeCmd(cmd: string, args?: Record<string, unknown>) {
  if (!isTauri()) return;
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke(cmd, args))
    .catch((err) => dockLog(`invoke ${cmd} failed: ${err instanceof Error ? err.message : String(err)}`));
}
