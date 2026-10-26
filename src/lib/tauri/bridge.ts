/**
 * Tauri Bridge — TypeScript wrapper for Rust commands.
 *
 * All Tauri-specific code lives here. Components import from this module
 * and get graceful fallbacks when running in browser mode.
 *
 * Usage:
 *   import { isTauri, getDesktopInfo, notify } from '@/lib/tauri/bridge';
 *   if (isTauri()) { ... }
 */

import { subscribeTauriEvent } from './events';

// ── Detection ──

/**
 * Check if we're running inside Tauri (desktop app) vs browser.
 * Uses the Tauri internals global that the Rust shell injects.
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * The current webview window's label, read SYNCHRONOUSLY from the Tauri
 * internals metadata (no async `getCurrentWindow()` import). null outside Tauri.
 */
export function currentWindowLabel(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
    }).__TAURI_INTERNALS__;
    return internals?.metadata?.currentWindow?.label ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether Tauri event emit/listen is SAFE to call in the current window.
 *
 * Tauri injects `__TAURI_INTERNALS__` into any webview whose URL matches a
 * capability's `remote.urls` — and o8's are `http(s)://localhost:*|127.0.0.1:*`.
 * The native `browser-view` window loads localhost pages, so `isTauri()` is TRUE
 * inside it even though it holds NO capability (deliberately — granting it would
 * hand every browsed site o8's event IPC). If a main-app page (e.g. the operator
 * browses to o8's own localhost origin) mounts there, its emit/listen effects
 * fire and the ACL rejects each with "Command plugin:event|emit not allowed by
 * ACL" → a burst of unhandled rejections that crash the renderer (reports on
 * v0.1.597). Every main-app event site must gate on THIS, not bare isTauri():
 * the main-app event contract only holds in the `main` window (the satellite
 * windows — dock/agent-partials/point-overlay/spatial-ink/voice-settings — run
 * their OWN pages and use events directly under their own grants).
 */
export function canUseTauriEvents(): boolean {
  return isTauri() && currentWindowLabel() === 'main';
}

/**
 * Whether the webview is running on a macOS host. The native browser-view
 * Tauri commands are `#[cfg(target_os = "macos")]`, so invoking them elsewhere
 * only logs "Command browser_view_* not found" (seen on Debian 13, v0.1.810).
 */
export function isMacHost(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent);
}

// #932 phase 2: tauri-plugin-mcp's old setupPluginListeners() init dance
// was deleted. The eval_and_await protocol invokes JS from Rust per call
// (via webview.eval()) instead of holding persistent JS-side listeners,
// so no client-side init is required. The plugin loads automatically
// when the dev-mcp-plugin Cargo feature is on.

// ── Types ──

export interface DesktopInfo {
  is_desktop: boolean;
  platform: string;
  version: string;
  arch: string;
}

export interface SidecarResult {
  ok: boolean;
  pid: number | null;
  error: string | null;
}

export type DesktopClosePreference = 'ask' | 'background' | 'quit';

// ── Commands (lazy-loaded to avoid import errors in browser) ──

/**
 * Invoke a Tauri command. Returns null if not running in Tauri.
 */
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null;
  // browser_view_* commands only exist in macOS builds — skip them elsewhere.
  if (cmd.startsWith('browser_view_') && !isMacHost()) return null;
  try {
    const { invoke: tauriInvoke } = await import('@tauri-apps/api/core');
    return await tauriInvoke<T>(cmd, args);
  } catch (err) {
    console.error(`[tauri-bridge] invoke ${cmd} failed:`, err);
    return null;
  }
}

/**
 * Get desktop environment info (platform, version, arch).
 */
export async function getDesktopInfo(): Promise<DesktopInfo | null> {
  return invoke<DesktopInfo>('get_desktop_info');
}

/**
 * Check if a port is listening.
 */
export async function checkPort(port: number): Promise<boolean> {
  const result = await invoke<boolean>('check_port', { port });
  return result ?? false;
}

/**
 * Start the WebSocket server as a background sidecar.
 */
export async function startWsServer(projectDir: string): Promise<SidecarResult | null> {
  return invoke<SidecarResult>('start_ws_server', { projectDir });
}

/**
 * Check if Cortex binary is available on this machine.
 */
export async function cortexAvailable(): Promise<boolean> {
  const result = await invoke<boolean>('cortex_available');
  return result ?? false;
}

/**
 * Get the app's persistent data directory.
 */
export async function getAppDataDir(): Promise<string | null> {
  return invoke<string>('get_app_data_dir');
}

/**
 * Swap the main window's vibrancy material for Canvas mode (#1232) — this
 * is the canvas BACKGROUND (the desktop reads through it). Ids mirror
 * CANVAS_GLASS_MATERIALS in lib/canvas-mode/glass-settings; `'default'`
 * restores the HudWindow chrome. No-op outside Tauri/macOS.
 */
export async function setCanvasMaterial(material: string): Promise<void> {
  await invoke<void>('set_canvas_material', { material });
}

/**
 * Continuous desktop blur behind the window's transparent regions (#1232) —
 * the Liquid-mode frost dial. 0 restores raw clarity. No-op outside
 * Tauri/macOS.
 */
export async function setCanvasBackdropBlur(radius: number): Promise<void> {
  await invoke<void>('set_canvas_backdrop_blur', { radius: Math.max(0, Math.round(radius)) });
}

// ── Native browser-view (the embedded Browser pane's native child window) ──
//
// The native path (operator-flagged) replaces the iframe/proxy with a
// host-owned child WebviewWindow positioned over the panel's content rect, so
// origin-sensitive auth apps (Clerk) render natively AND stay agent-grabbable.
// All no-ops outside Tauri/macOS — the iframe path stays the default there.

export interface BrowserViewRect {
  /** CSS logical px, relative to the main webview viewport (getBoundingClientRect). */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Open/retarget the native browser-view window over `rect` + navigate to `url`.
 *  `initScript` (NATIVE_BROWSER_AGENT_SOURCE) installs the in-page agent on first
 *  open. Idempotent — Rust navigates + repositions an existing window. */
export async function browserViewOpen(
  url: string,
  rect: BrowserViewRect,
  initScript?: string,
): Promise<void> {
  await invoke<void>('browser_view_open', {
    url,
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    ...(initScript ? { initScript } : {}),
  });
}

/** Reposition/resize the native browser-view window (ResizeObserver / move). */
export async function browserViewSetRect(rect: BrowserViewRect): Promise<void> {
  await invoke<void>('browser_view_set_rect', { x: rect.x, y: rect.y, w: rect.w, h: rect.h });
}

/** Navigate the native browser-view window to a new URL (URL bar / reload). */
export async function browserViewNavigate(url: string): Promise<void> {
  await invoke<void>('browser_view_navigate', { url });
}

/** Fire-and-forget JS eval into the native browser-view's page — powers the
 *  toolbar back/forward (history.back()/forward()) on the native path. */
export async function browserViewEval(js: string): Promise<void> {
  await invoke<void>('browser_view_eval', { js });
}

/** Hide the native browser-view window without destroying it (tab hidden,
 *  pane collapsed, occlusion snapshot-swap). */
export async function browserViewHide(): Promise<void> {
  await invoke<void>('browser_view_hide');
}

/** Show the native browser-view window again + re-apply its last rect. */
export async function browserViewShow(): Promise<void> {
  await invoke<void>('browser_view_show');
}

/** Close + destroy the native browser-view window (Browser tab closed). */
export async function browserViewClose(): Promise<void> {
  await invoke<void>('browser_view_close');
}

/** Capture the native browser-view's on-screen content as a base64 PNG (data
 *  is bare base64, no data: prefix) for the occlusion snapshot-swap. null
 *  outside Tauri or if Screen Recording isn't granted. */
export async function browserViewCapture(): Promise<string | null> {
  return invoke<string>('browser_view_capture');
}

// ── OS file opens (Finder "Open With → o8", dock drop) ──

/** Drain the paths the OS handed us — the canvas turns them into file cards. */
export async function takePendingFileOpens(): Promise<string[]> {
  return (await invoke<string[]>('take_pending_file_opens')) ?? [];
}

/** Read without consuming — the dashboard peeks to decide whether to route
 *  to the canvas; the canvas itself does the take. */
export async function peekPendingFileOpens(): Promise<string[]> {
  return (await invoke<string[]>('peek_pending_file_opens')) ?? [];
}

/** Subscribe to warm file-open requests. Resolves to an unlisten fn (null
 *  outside Tauri). */
export async function onFileOpenRequest(handler: (paths: string[]) => void): Promise<(() => void) | null> {
  // Main-window only — this listener in the native browser-view ACL-denies.
  if (!canUseTauriEvents()) return null;
  return subscribeTauriEvent<string[]>('file-open-request', (event) => handler(event.payload ?? []));
}

// ── Notifications ──

/**
 * Send a native desktop notification.
 * Falls back to nothing in browser mode.
 */
export async function notify(title: string, body: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { sendNotification } = await import('@tauri-apps/plugin-notification');
    sendNotification({ title, body });
  } catch {
    // Notification plugin not available
  }
}

// ── Window Management ──

/**
 * Show the main window (useful after tray-hide).
 */
export async function showWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.show();
    await win.setFocus();
  } catch {
    // Window API not available
  }
}

/**
 * Minimize the main window to tray.
 */
export async function hideWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().hide();
  } catch {
    // Window API not available
  }
}

// ── Store (Persistent Settings) ──

/**
 * Get a value from Tauri's persistent store.
 */
export async function storeGet<T>(key: string): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load('settings.json', { defaults: {} });
    const value = await store.get<T>(key);
    return value ?? null;
  } catch {
    return null;
  }
}

/**
 * Set a value in Tauri's persistent store.
 */
export async function storeSet<T>(key: string, value: T): Promise<void> {
  if (!isTauri()) return;
  try {
    const { load } = await import('@tauri-apps/plugin-store');
    const store = await load('settings.json', { defaults: {} });
    await store.set(key, value);
    await store.save();
  } catch {
    // Store not available
  }
}

// ── Keychain ──

/**
 * Retrieve the AES-256-GCM master encryption key from the macOS Keychain.
 * Returns null if the entry does not exist or this is not a Tauri build.
 */
export async function masterKeyGet(): Promise<string | null> {
  return invoke<string>('master_key_get');
}

/**
 * Retrieve the master key from Keychain, creating one if absent.
 * Returns null on non-Tauri / non-macOS environments.
 */
export async function masterKeyEnsure(): Promise<string | null> {
  return invoke<string>('master_key_ensure');
}

// ── Voice / system-dictation permissions (P0 helpers) ──

/** Whether o8 has macOS Accessibility permission. Non-prompting. */
export async function accessibilityPermissionGranted(): Promise<boolean> {
  const result = await invoke<boolean>('accessibility_permission_granted_cmd');
  return result ?? false;
}

/** Whether o8 has macOS Input Monitoring permission. Non-prompting. */
export async function inputMonitoringGranted(): Promise<boolean> {
  const result = await invoke<boolean>('input_monitoring_granted_cmd');
  return result ?? false;
}

/** Fire the real macOS Input Monitoring prompt (IOHIDRequestAccess, #1537).
 * Silent no-op returning false when the user already denied. */
export async function requestInputMonitoring(): Promise<boolean> {
  const result = await invoke<boolean>('request_input_monitoring_cmd');
  return result ?? false;
}

/**
 * The current `AppleFnUsageType` (0 = "Do Nothing" — what o8 needs). null /
 * unset should be treated as 3 = "Start Dictation", which hijacks the Fn key.
 */
export async function fnKeyUsageType(): Promise<number | null> {
  return invoke<number>('fn_key_usage_type_cmd');
}

/**
 * Whether o8 has macOS Screen Recording permission — powers Symon's screen
 * sight (Points / Guide). Per CGPreflight, which can report stale truth after
 * an app rebind; the hint copy covers the re-grant recipe. Non-prompting.
 */
export async function screenCaptureGranted(): Promise<boolean> {
  const result = await invoke<boolean>('screen_capture_granted_cmd');
  return result ?? false;
}

/**
 * Microphone TCC status: true authorized, false denied/restricted, null when
 * macOS has never asked (the first dictation will prompt). Non-prompting.
 */
export async function micPermissionGranted(): Promise<boolean | null> {
  return invoke<boolean | null>('mic_permission_granted_cmd');
}

/**
 * On-demand macOS Microphone prompt (AVFoundation) for the Permissions
 * concierge fix flow. Fires the real prompt only when the status is
 * notDetermined; an already-denied grant is left untouched (macOS won't
 * re-prompt — the UI deep-links System Settings in that case). Returns the
 * CURRENT status (true authorized / false denied / null never-asked); poll the
 * non-prompting `micPermissionGranted()` to observe the resulting grant.
 */
export async function requestMicAccess(): Promise<boolean | null> {
  return invoke<boolean | null>('request_mic_access_cmd');
}

/**
 * Relaunch o8. Kills tracked child processes first, then `app.restart()` (see
 * `restart_app` in src-tauri/src/lib.rs — the same command the updater flow
 * uses). Accessibility / Input Monitoring / Screen Recording grants only take
 * effect for a fresh process, so the Permissions tab offers this after such a
 * grant lands mid-session. No-op outside Tauri.
 */
export async function restartApp(): Promise<void> {
  if (!isTauri()) return;
  const { relaunchInstalledUpdate } = await import('@/lib/app-update/client-restart');
  if (!(await relaunchInstalledUpdate())) throw new Error('Restart is waiting for CLI update ownership to be resolved. No sessions were stopped.');
}

/**
 * Open a macOS System Settings pane by its URL / bundle target. Used to jump
 * the user to Accessibility / Input-Monitoring / Keyboard for granting.
 */
export async function openSystemSettings(target: string): Promise<void> {
  await invoke('open_system_settings', { target });
}

/**
 * Open (or focus) Symon's standalone Voice settings window — the same
 * `/voice-settings` glass window the dock's double-tap gesture opens. History,
 * Polish, and voice-persona controls live there; this is the one entry point
 * o8 Settings links out to instead of duplicating them.
 */
export async function openVoiceSettings(): Promise<void> {
  await invoke('open_voice_settings');
}

// ── Background presence + autostart (P4) ──

/** Whether "Launch at login" is currently registered. */
export async function autostartIsEnabled(): Promise<boolean> {
  const result = await invoke<boolean>('autostart_is_enabled');
  return result ?? false;
}

/** Enable / disable "Launch at login". Returns the resulting state. */
export async function autostartSet(enabled: boolean): Promise<boolean> {
  const result = await invoke<boolean>('autostart_set', { enabled });
  return result ?? enabled;
}

/** Whether background mode (Accessory / Dock icon hidden) is on. */
export async function backgroundModeIsEnabled(): Promise<boolean> {
  const result = await invoke<boolean>('background_mode_is_enabled');
  return result ?? false;
}

/** Toggle background mode — hides/shows the Dock icon and persists the choice. */
export async function backgroundModeSet(enabled: boolean): Promise<boolean> {
  const result = await invoke<boolean>('background_mode_set', { enabled });
  return result ?? enabled;
}

/** Windows/Linux behavior when the main window closes while work is active. */
export async function desktopClosePreferenceGet(): Promise<DesktopClosePreference> {
  const result = await invoke<DesktopClosePreference>('desktop_close_preference_get');
  return result === 'background' || result === 'quit' ? result : 'ask';
}

export async function desktopClosePreferenceSet(
  preference: DesktopClosePreference,
): Promise<DesktopClosePreference> {
  const result = await invoke<DesktopClosePreference>('desktop_close_preference_set', { preference });
  return result === 'background' || result === 'quit' ? result : 'ask';
}

export async function resolveDesktopClose(
  action: Exclude<DesktopClosePreference, 'ask'>,
  remember: boolean,
): Promise<boolean> {
  return (await invoke<boolean>('resolve_desktop_close', { action, remember })) ?? false;
}

/** Voice preferences (`~/.o8/dictation.json`, secrets stripped). Provider keys
 * live in macOS Keychain; non-secret prefs remain mtime-cached in the JSON file. */
export async function voicePrefsGet(): Promise<Record<string, unknown> | null> {
  return invoke<Record<string, unknown>>('voice_prefs_get');
}

export async function voicePrefsSet(key: string, value: unknown): Promise<void> {
  await invoke('voice_prefs_set', { key, value });
}

/** Live state of the external-keyboard Fn substitute (#2158). `enabled` is the
 * stored preference; `active` is whether bottom-left Control is actually
 * mirroring Fn right now, which additionally requires a non-Apple external
 * keyboard to be attached. `keyboard` names the board arming it. */
export interface ExternalKeyboardFnState {
  enabled: boolean;
  active: boolean;
  keyboard: string | null;
}

export async function externalKeyboardFnState(): Promise<ExternalKeyboardFnState | null> {
  return invoke<ExternalKeyboardFnState>('external_keyboard_fn_state');
}

/** One entry of the native planner registry (#2156). `runtimeConfiguredModel`
 * marks an adapter that runs whatever model the operator configured for it, so
 * the panel says that instead of showing an empty model. */
export interface SymonBrainAdapterState {
  id: string;
  label: string;
  installed: boolean;
  runtimeConfiguredModel: boolean;
}

/** The Symon brain seat (#2156): the stored setting, which planner adapters are
 * installed, and the seat the registry resolves right now. `fellBackFrom` names
 * the chosen provider when its CLI is missing and another entry took the seat. */
/** One selectable front-brain seat (#2164) — the built-in Gemini loop plus
 *  every planner adapter, rendered from the native registry. */
export interface SymonFrontBrainOption {
  id: string;
  label: string;
  installed: boolean;
}

/** The seat the Right-Option gesture takes: the stored choice, what this
 *  machine can run, and what the NEXT gesture will actually use. */
export interface SymonFrontBrainState {
  choice: string;
  options: SymonFrontBrainOption[];
  resolvedId: string | null;
  resolvedLabel: string | null;
  resolvedModel: string | null;
  fellBackFrom: string | null;
  escalateAvailable: boolean;
}

export interface SymonBrainState {
  provider: string;
  tier: string;
  model: string | null;
  adapters: SymonBrainAdapterState[];
  resolvedProvider: string | null;
  resolvedLabel: string | null;
  resolvedModel: string | null;
  resolvedEffort: string | null;
  fellBackFrom: string | null;
  detail: string | null;
  front: SymonFrontBrainState;
}

export async function symonBrainState(): Promise<SymonBrainState | null> {
  return invoke<SymonBrainState>('symon_brain_state');
}

export interface SymonMemoryEntry {
  id: number;
  fact: string;
  state: 'active' | 'pending';
  source: string;
  createdAt: number;
  updatedAt: number;
}

export interface SymonMemorySnapshot {
  facts: SymonMemoryEntry[];
  suggestions: SymonMemoryEntry[];
}

export async function symonMemoryGet(): Promise<SymonMemorySnapshot> {
  return (await invoke<SymonMemorySnapshot>('symon_memory_get')) ?? { facts: [], suggestions: [] };
}

export async function symonMemoryAdd(fact: string): Promise<SymonMemoryEntry> {
  const entry = await invoke<SymonMemoryEntry>('symon_memory_add', { fact });
  if (!entry) throw new Error('Symon memory did not return the saved fact.');
  return entry;
}

export async function symonMemoryUpdate(id: number, fact: string): Promise<SymonMemoryEntry> {
  const entry = await invoke<SymonMemoryEntry>('symon_memory_update', { id, fact });
  if (!entry) throw new Error('Symon memory did not return the edited fact.');
  return entry;
}

export async function symonMemoryForget(id: number): Promise<void> {
  await invoke('symon_memory_forget', { id });
}

export async function symonMemoryAcceptSuggestion(id: number): Promise<SymonMemoryEntry> {
  const entry = await invoke<SymonMemoryEntry>('symon_memory_accept_suggestion', { id });
  if (!entry) throw new Error('Symon memory did not return the approved suggestion.');
  return entry;
}

export async function symonMemoryDismissSuggestion(id: number): Promise<void> {
  await invoke('symon_memory_dismiss_suggestion', { id });
}

/** Two-tier brain escalation policy ("off" | "auto" | "deep"), persisted in
 * ~/.o8/agent_models.json via the agent router. Controls whether/when the front
 * voice brain hands heavy tasks to the background Claude brain. macOS + Tauri. */
export async function agentGetEscalation(): Promise<string> {
  return (await invoke<string>('agent_get_escalation')) ?? 'auto';
}

export async function agentSetEscalation(policy: string): Promise<void> {
  await invoke('agent_set_escalation', { policy });
}

/** Apply the native recognizer locale live (e.g. "en-US"). Pairs with persisting
 * `dictation_locale` via voicePrefsSet so the choice survives relaunch. */
export async function sttSetLocale(locale: string): Promise<void> {
  await invoke('o8_stt_locale', { locale });
}

/** Speak `text` through the TTS engine using the currently-saved voice + speed —
 * powers the Voice Output "Preview" buttons. Fire-and-forget. */
export async function ttsSpeak(text: string): Promise<void> {
  await invoke('tts_speak', { text });
}

/** Speak a short Symon lifecycle callout without interrupting active speech.
 * Rust gates this against the live voice_callouts preference at speak time. */
export async function symonSpeakStatus(text: string): Promise<void> {
  await invoke('symon_speak_status', { text });
}

/** Stop any active TTS playback (preview / read-aloud). Safe no-op when idle. */
export async function ttsStop(): Promise<void> {
  await invoke('tts_stop');
}

/** An audio input device for the Settings mic picker. */
export interface InputDevice { id: string; name: string; is_default: boolean }

/** List connected audio input devices. Returns null until the Rust enumeration
 * command ships — the mic picker degrades to "System Default" in that case. */
export async function sttListInputDevices(): Promise<InputDevice[] | null> {
  return invoke<InputDevice[]>('stt_list_input_devices');
}

/** Route dictation to a specific input device (uid). No-op until shipped. */
export async function sttSetInputDevice(deviceUid: string): Promise<void> {
  await invoke('stt_set_input_device', { deviceUid });
}

// ── Symon voice agent ──

/** A persisted agent task's status (for polling the dock). */
export interface AgentTaskStatus {
  id: string;
  status: string;
  intent: string;
  result: string | null;
  model: string | null;
  createdAt: number;
  finishedAt: number | null;
}

/** Run the Symon voice agent on a text prompt (the tool-calling lane, separate
 * from Ask). Fire-and-forget — progress + result reach the dock via events + TTS,
 * and risky actions surface a confirm card. */
export async function agentRun(prompt: string): Promise<void> {
  await invoke('agent_run', { prompt });
}

/** Resolve a pending agent confirm card (Allow / Cancel). */
export async function agentConfirm(taskId: string, allow: boolean): Promise<void> {
  await invoke('agent_confirm', { taskId, allow });
}

/** The most recent agent task (status/result). Null until one has run. */
export async function agentTaskStatus(): Promise<AgentTaskStatus | null> {
  return invoke<AgentTaskStatus>('agent_task_status');
}

/** A persisted dictation/ask, newest-first — the settings History panel. */
export interface DictationHistoryEntry {
  id: string;
  ts: number; // unix seconds
  mode: string; // "dictation" | "ask" | "speak-selection"
  text: string;
  app: string; // target app bundle id, may be empty
}

export async function dictationHistoryGet(): Promise<DictationHistoryEntry[]> {
  return (await invoke<DictationHistoryEntry[]>('dictation_history_get')) ?? [];
}

export async function dictationHistoryClear(): Promise<void> {
  await invoke('dictation_history_clear');
}

export async function dictationHistoryDelete(id: string): Promise<void> {
  await invoke('dictation_history_delete', { id });
}
