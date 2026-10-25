/** The real desktop watcher with only its browser/Tauri boundary replaced. */
import { watchQuietMode } from '../../src/lib/presentation/quiet-mode-client';

export function presentationFixture() {
  const flags = { quiet: false, notifications: true };
  const ticks = new Map<number, () => void | Promise<void>>();
  let nextTimer = 0;
  const browser = Object.assign(new EventTarget(), {
    setInterval(callback: () => void | Promise<void>) { const id = ++nextTimer; ticks.set(id, callback); return id; },
    clearInterval(id: number) { ticks.delete(id); },
    __TAURI_INTERNALS__: {
      transformCallback() { return 1; },
      async invoke(command: string, args?: Record<string, unknown>) {
        if (command === 'presentation_quiet_mode_set') flags.quiet = args?.active === true;
        if (command === 'set_review_notifications_enabled') flags.notifications = args?.enabled === true;
        return { active: flags.quiet };
      },
    },
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  watchQuietMode();
  return async (transientQuiet?: boolean) => {
    if (typeof transientQuiet === 'boolean') {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('presentation_quiet_mode_set', { active: transientQuiet });
    }
    for (const tick of ticks.values()) await tick();
    return { ...flags };
  };
}
