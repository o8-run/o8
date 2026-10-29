'use client';

import { useEffect, useRef, useState } from 'react';
import { openOrchestratorWebSocket } from '@/components/desktop/thoughts/use-orchestrator-stream/shared';
import { useChatLiveController } from '@/components/desktop/thoughts/chat-panel/useChatLiveController';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';
import { sameVoiceBinding, type VoiceBinding, type VoiceHostPayload, type VoiceTerminal } from '@/lib/next/voice-host';
import { subscribeManagedSymonConfirmation } from '@/lib/voice/managed-live/symon-backend';
import { managedChatVoiceTargets } from '@/lib/voice/managed-live/chat-targets';
import { subscribeTauriEvent } from '@/lib/tauri/events';
import { canUseTauriEvents } from '@/lib/tauri/bridge';

async function request(body: VoiceHostPayload) {
  const response = await fetch('/api/next/voice-host', { method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${getMobileWsToken()}` }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('Voice host control unavailable.');
}
async function publish(kind: 'voice-host-state' | 'voice-delegate', payload: VoiceHostPayload) {
  const response = await fetch('/api/next/voice-host', { method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${getMobileWsToken()}` }, body: JSON.stringify({ action: 'publish', kind, payload }) });
  if (!response.ok) throw new Error('Voice host relay unavailable.');
}
type QueueTerminal = VoiceTerminal & { transcriptUserMessageId?: string };
type Pending = { resolve: (value: { queueItemId: string } | null) => void; timer: ReturnType<typeof setTimeout> };
interface BoundProps {
  command: VoiceHostPayload & VoiceBinding;
  hostId: string;
  stopping: boolean;
  terminals: Record<string, QueueTerminal>;
  pending: Map<string, Pending>;
  remember: (payload: VoiceHostPayload) => void;
}
function BoundChatLiveHost({ command, hostId, stopping, terminals, pending, remember }: BoundProps) {
  const emit = (payload: VoiceHostPayload, kind: 'voice-host-state' | 'voice-delegate' = 'voice-host-state') =>
    publish(kind, { ...command, ...payload, hostId });
  const controller = useChatLiveController({
    binding: command.binding, messages: command.messages ?? [], terminals, busy: command.busy ?? false,
    send: () => null,
    sendDelegation: (text, delegationId) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(delegationId); reject(new Error('Chat acceptance was not confirmed.')); }, 10_000);
      pending.set(delegationId, { resolve, timer });
      void emit({ action: 'delegate', text, delegationId }, 'voice-delegate').catch(error => {
        clearTimeout(timer); pending.delete(delegationId); reject(error);
      });
    }),
    transcript: messages => { void emit({ action: 'transcript', messages }).catch(() => {}); },
    interrupt: () => { void emit({ action: 'interrupt' }).catch(() => {}); },
  });
  const current = useRef(controller); current.current = controller;
  useEffect(() => {
    let alive = true;
    const target = { standalone: true as const, eligible: () => alive,
      state: () => current.current.stateRef.current, toggle: () => current.current.startLive('byok') };
    void managedChatVoiceTargets.request(target).then(accepted => {
      if (!accepted && alive) void emit({ action: 'state', state: 'error', detail: 'Another voice session owns audio.' }).catch(() => {});
    });
    return () => {
      alive = false;
      for (const item of pending.values()) { clearTimeout(item.timer); item.resolve(null); }
      pending.clear();
    };
    // One immutable provider lifetime per nonce. Context changes do not reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command.nonce]);
  useEffect(() => {
    if (stopping) void current.current.stopLive();
  }, [stopping]);
  useEffect(() => {
    if (controller.state !== 'idle') {
      const payload = { ...command, action: 'state', state: controller.state, detail: controller.detail };
      remember(payload); void emit(payload).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller.state, controller.detail]);
  return null;
}

/** Dedicated native binding adapter. No composer, focus probe or Caps Lock listener. */
export function ChatLiveHost() {
  const hostId = useRef(crypto.randomUUID());
  const [command, setCommand] = useState<(VoiceHostPayload & VoiceBinding) | null>(null);
  const binding = useRef<VoiceBinding | null>(null);
  const snapshot = useRef<VoiceHostPayload | null>(null);
  const [stopping, setStopping] = useState(false);
  const [terminals, setTerminals] = useState<Record<string, QueueTerminal>>({});
  const pending = useRef(new Map<string, Pending>());
  useEffect(() => {
    if (!canUseTauriEvents() || !(window as Window & { __O8_VOICE_HOST__?: boolean }).__O8_VOICE_HOST__) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const confirmations = new Map<string, { data: Record<string, unknown>; decide: (allow: boolean) => void | Promise<unknown> }>();
    const emit = (payload: VoiceHostPayload) => publish('voice-host-state', { ...payload, hostId: hostId.current });
    const confirmation = (data: Record<string, unknown>, decide: (allow: boolean) => void | Promise<unknown>) => {
      if (typeof data.confirmationId !== 'string') return;
      confirmations.set(data.confirmationId, { data, decide });
      void emit({ action: 'confirmation', confirmation: data }).catch(() => {});
    };
    const dismiss = (confirmationId: string) => {
      confirmations.delete(confirmationId);
      void emit({ action: 'confirmation-dismissed', confirmationId }).catch(() => {});
    };
    const offManaged = subscribeManagedSymonConfirmation(value => {
      for (const [id, item] of confirmations) if (item.data.source === 'managed' && id !== value?.confirmationId) dismiss(id);
      if (value) {
        const { decide, ...data } = value;
        confirmation({ ...data, source: 'managed' }, decide);
      }
    });
    const offConfirm = subscribeTauriEvent<Record<string, unknown>>('o8:agent-confirm', ({ payload }) => {
      confirmation({ ...payload, source: 'native' }, async allow => {
        const { invoke } = await import('@tauri-apps/api/core');
        return typeof payload.sessionId === 'string' && typeof payload.callId === 'string'
          ? invoke('agent_confirm_v2', { confirmationId: payload.confirmationId, sessionId: payload.sessionId, callId: payload.callId, allow })
          : invoke('agent_confirm_exact', { confirmationId: payload.confirmationId, taskId: payload.taskId, allow });
      });
    });
    const offDismiss = subscribeTauriEvent<{ confirmationId: string }>('o8:agent-confirm-dismissed', ({ payload }) => dismiss(payload.confirmationId));
    const symonState = () => {
      const state = (window as Window & { __o8RealtimeStatus?: string }).__o8RealtimeStatus ?? 'idle';
      void emit({ action: 'symon-state', state }).catch(() => {});
    };
    window.addEventListener('o8:symon-voice-status', symonState);
    const stopAll = () => { setStopping(true); window.dispatchEvent(new Event('o8:voice-host-stop-all')); };
    const ready = async () => {
      await request({ action: 'ready', hostId: hostId.current });
      if (snapshot.current) await emit(snapshot.current);
      symonState();
      for (const item of confirmations.values()) await emit({ action: 'confirmation', confirmation: item.data });
    };
    const connect = () => {
      if (disposed) return;
      socket = openOrchestratorWebSocket();
      if (!socket) { reconnect = setTimeout(connect, 1000); return; }
      socket.addEventListener('open', () => {
        void ready().catch(() => {});
        heartbeat = setInterval(() => { void ready().catch(stopAll); }, 5000);
      });
      socket.addEventListener('message', event => {
        let frame: { type?: string; kind?: string; payload?: VoiceHostPayload };
        try { frame = JSON.parse(event.data); } catch { return; }
        const payload = frame.payload;
        if (frame.type !== 'ui-command' || frame.kind !== 'voice-host-state' || !payload || payload.hostId !== hostId.current) return;
        if (payload.action === 'symon-toggle') { window.dispatchEvent(new Event('o8:symon-voice-toggle')); return; }
        if (payload.action === 'decision') {
          const item = confirmations.get(payload.confirmationId ?? '');
          if (!item || typeof payload.allow !== 'boolean' || Number(item.data.expiresAt) <= Date.now()) return;
          void Promise.resolve(item.decide(payload.allow)).then(() => dismiss(String(item.data.confirmationId))).catch(() => {});
          return;
        }
        if (payload.action === 'start') {
          if (payload.source !== 'byok' || !payload.binding || !payload.nonce || !payload.threadId || !payload.repoPath) return;
          binding.current = payload as VoiceBinding;
          setTerminals({}); setStopping(false); setCommand(payload as VoiceHostPayload & VoiceBinding);
          return;
        }
        if (!binding.current || !sameVoiceBinding(binding.current, payload)) return;
        if (payload.action === 'stop') setStopping(true);
        if (payload.action === 'context') setCommand(value => value ? { ...value, messages: payload.messages, busy: payload.busy } : value);
        if (payload.action === 'accepted' && payload.delegationId && payload.queueItemId) {
          const item = pending.current.get(payload.delegationId);
          if (item) { clearTimeout(item.timer); pending.current.delete(payload.delegationId); item.resolve({ queueItemId: payload.queueItemId }); }
        }
        if (payload.action === 'terminal' && payload.voiceTerminal) {
          setTerminals(value => ({ ...value, [payload.voiceTerminal!.queueItemId]: { ...payload.voiceTerminal!, transcriptUserMessageId: payload.transcriptUserMessageId } }));
        }
      });
      socket.addEventListener('close', () => {
        clearInterval(heartbeat); stopAll();
        if (!disposed) reconnect = setTimeout(connect, 1000);
      });
    };
    connect();
    return () => {
      disposed = true; clearInterval(heartbeat); clearTimeout(reconnect); socket?.close();
      offManaged(); offConfirm(); offDismiss(); window.removeEventListener('o8:symon-voice-status', symonState);
    };
  }, []);
  return command ? <BoundChatLiveHost key={command.nonce} command={command} hostId={hostId.current} stopping={stopping} terminals={terminals} pending={pending.current} remember={payload => { snapshot.current = payload; }} /> : null;
}
