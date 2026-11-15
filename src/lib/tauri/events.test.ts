// @vitest-environment jsdom

import { emit } from '@tauri-apps/api/event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onFileOpenRequest } from './bridge';
import { listenTauriEvent, subscribeTauriEvent } from './events';

// Keep the real SDK. Only the native IPC boundary is simulated, including
// its response-before-webview-registration ordering observed on the desktop.
describe('native event registration and disposal through the SDK', () => {
  let nextId: number;
  let registrationDelay: number;
  let responseDelay: number;
  let existingEvent: boolean;
  let pendingFiles: string[];
  const callbacks = new Map<number, (value: unknown) => void>();
  const nativeListeners = new Map<number, { event: string; handler: number }>();
  const registry: Record<string, Record<number, { handlerId: number }>> = {};
  const invoke = vi.fn();
  const unregisterCallback = vi.fn((id: number) => { callbacks.delete(id); });
  const consoleError = vi.fn();

  function unlistenCalls() {
    return invoke.mock.calls.filter(([command]) => command === 'plugin:event|unlisten');
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(console, 'error').mockImplementation(consoleError);
    nextId = 0;
    registrationDelay = 25;
    responseDelay = 0;
    existingEvent = true;
    pendingFiles = [];
    callbacks.clear();
    nativeListeners.clear();
    for (const key of Object.keys(registry)) delete registry[key];
    unregisterCallback.mockClear();
    consoleError.mockClear();
    invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (command === 'plugin:event|listen') {
        const id = ++nextId;
        const event = String(args.event);
        const handler = Number(args.handler);
        nativeListeners.set(id, { event, handler });
        if (existingEvent) registry[event] ??= {};
        if (registrationDelay >= 0) setTimeout(() => {
          registry[event] ??= {};
          registry[event][id] = { handlerId: handler };
        }, registrationDelay);
        if (responseDelay) await new Promise((resolve) => setTimeout(resolve, responseDelay));
        return id;
      }
      if (command === 'plugin:event|unlisten') {
        nativeListeners.delete(Number(args.eventId));
        return;
      }
      if (command === 'plugin:event|emit') {
        for (const [id, listener] of nativeListeners) {
          if (listener.event === args.event && registry[listener.event]?.[id]) {
            callbacks.get(listener.handler)?.({ event: args.event, id, payload: args.payload });
          }
        }
        return;
      }
      if (command === 'take_pending_file_opens') {
        const paths = pendingFiles;
        pendingFiles = [];
        return paths;
      }
      throw new Error(`Unexpected native command: ${command}`);
    });
    vi.stubGlobal('__TAURI_INTERNALS__', {
      metadata: { currentWindow: { label: 'main' } },
      invoke,
      transformCallback(handler: (value: unknown) => void) {
        const id = ++nextId;
        callbacks.set(id, handler);
        return id;
      },
      unregisterCallback,
    });
    vi.stubGlobal('__TAURI_EVENT_PLUGIN_INTERNALS__', {
      unregisterListener: function unregisterListener(event: string, id: number) {
        if (registry[event]) unregisterCallback(registry[event][id].handlerId);
      },
    });
  });

  afterEach(async () => {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(1000);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([true, false])('removes callbacks before deferred registration without retries (existing event: %s)', async (existing) => {
    existingEvent = existing;
    const handler = vi.fn();
    const dispose = await listenTauriEvent('o8:cleanup-test', handler);
    const released = dispose();
    expect(dispose()).toBe(released);
    await released;
    expect(unlistenCalls()).toHaveLength(1);
    expect(callbacks.size).toBe(0);
    await vi.advanceTimersByTimeAsync(30);
    await emit('o8:cleanup-test', { stale: true });
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await released;
    expect(unlistenCalls()).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith('plugin:event|listen', {
      event: 'o8:cleanup-test', target: { kind: 'Any' }, handler: expect.any(Number),
    }, undefined);
    expect(nativeListeners.size).toBe(0);
    expect(callbacks.size).toBe(0);
    await dispose();
    expect(unlistenCalls()).toHaveLength(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('does not retry unrelated native unlisten errors', async () => {
    const dispose = await listenTauriEvent('o8:cleanup-test', vi.fn());
    await vi.advanceTimersByTimeAsync(30);
    invoke.mockRejectedValueOnce(new Error('native unlisten denied'));
    await expect(dispose()).rejects.toThrow('native unlisten denied');
    await vi.advanceTimersByTimeAsync(1000);
    expect(unlistenCalls()).toHaveLength(1);
    expect(callbacks.size).toBe(0);
  });

  it('fails before allocating a callback if native disposal is unavailable', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke, transformCallback: vi.fn() });
    await expect(listenTauriEvent('o8:cleanup-test', vi.fn())).rejects.toThrow('Native callback disposal is unavailable');
    expect(invoke).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(0);
  });

  it('cleans up even when the webview registration never arrives', async () => {
    registrationDelay = -1;
    const dispose = await listenTauriEvent('o8:cleanup-test', vi.fn());
    await dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(unregisterCallback).toHaveBeenCalledTimes(1);
    expect(unlistenCalls()).toHaveLength(1);
    expect(nativeListeners.size).toBe(0);
    expect(callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('observes late-registration cleanup after a subscription is disposed', async () => {
    responseDelay = 10;
    const handler = vi.fn();
    const stop = subscribeTauriEvent('o8:cleanup-test', handler);
    stop();
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    await emit('o8:cleanup-test', null);
    expect(handler).not.toHaveBeenCalled();
    expect(unlistenCalls()).toHaveLength(1);
    expect(nativeListeners.size).toBe(0);
    expect(callbacks.size).toBe(0);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('reports registration and native cleanup failures without leaking the callback', async () => {
    invoke.mockRejectedValueOnce(new Error('listen denied'));
    subscribeTauriEvent('o8:denied-test', vi.fn())();
    await vi.advanceTimersByTimeAsync(1000);
    expect(consoleError).toHaveBeenCalledWith('[tauri-events] listen o8:denied-test failed:', expect.any(Error));
    expect(callbacks.size).toBe(0);
    const stop = subscribeTauriEvent('o8:missing-test', vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    invoke.mockRejectedValueOnce(new Error('native cleanup denied'));
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(consoleError).toHaveBeenCalledWith('[tauri-events] release o8:missing-test failed:', expect.any(Error));
    expect(callbacks.size).toBe(0);
    expect(consoleError).toHaveBeenCalledTimes(2);
  });

  it('keeps file-open subscriptions out of ungranted browser windows', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', { metadata: { currentWindow: { label: 'browser-view' } }, invoke });
    expect(await onFileOpenRequest(vi.fn())).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
