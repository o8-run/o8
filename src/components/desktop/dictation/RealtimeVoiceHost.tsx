'use client';

/**
 * RealtimeVoiceHost — global voice-to-voice (realtime) toggle + live indicator.
 *
 * Double-tap Right ⌘ (detected in src-tauri/src/fn_hotkey.rs) emits the Tauri
 * event `o8:realtime-toggle`; this host — mounted once in the dashboard — flips
 * the gpt-realtime session on/off, shows a small "voice live" pill up top, and
 * auto-stops after ~90s of no speech so an idle session never burns tokens.
 *
 * The session itself lives in `@/lib/voice/realtime-client` (WebRTC in the
 * webview). Inline styles only; themed via var(--t-*). Self-contained — no props.
 */

import { ManagedSymonVoiceHost } from './ManagedSymonVoiceHost';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { isTauri, canUseTauriEvents } from '@/lib/tauri/bridge';
import {
  startRealtimeSession,
  type RealtimeSessionHandle,
  type RealtimeStatus,
} from '@/lib/voice/realtime-client';
import { symonReviewGuardId } from '@/lib/mobile/symon-tool-relay';
import { REALTIME_MODEL, DEFAULT_VOICE } from '@/lib/voice/realtime-session-config';
import { createSymonVoiceTranscriptRecorder } from '@/lib/symon/voice-transcript-recorder';

const LOG = '[realtime-host]';

interface SymonToolCorrelation {
  sessionId: string;
  callId: string;
}

interface SymonConfirmTarget {
  approvalId?: string;
  packetId?: string;
  laneId?: string;
  sessionKey?: string;
}

/** A gate-owned confirmation surfaced to the phone relay while its invoke waits. */
interface SymonConfirmPlan {
  planId: string;
  steps: Array<{ index: number; summary: string }>;
}

interface SymonConfirmEntry {
  confirmationId: string;
  tool: string;
  taskId: string;
  summary: string;
  kind?: 'action' | 'plan';
  plan?: SymonConfirmPlan;
  expiresAt: number;
  target: SymonConfirmTarget;
  sessionId?: string;
  callId?: string;
  at: number;
  consumed?: boolean;
  settled?: boolean;
}

type SymonConfirmResolution =
  | { status: 'resolved'; allow: boolean }
  | { status: 'already_resolved'; allow: boolean }
  | { status: 'expired' | 'preempted' | 'not_found' };

type SymonInvokeTool = (
  name: string,
  args: Record<string, unknown>,
  correlation?: SymonToolCorrelation,
  utterance?: string,
) => Promise<unknown>;

type SymonResolveConfirm = (
  confirmationId: string,
  allow: boolean,
  correlation: SymonToolCorrelation,
  terminal?: 'expired' | 'preempted',
) => Promise<SymonConfirmResolution>;

type SymonInterruptTool = (correlation: SymonToolCorrelation) => Promise<boolean>;

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function confirmationPlan(value: unknown): SymonConfirmPlan | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const planId = stringField(record.planId);
  if (!planId || !Array.isArray(record.steps) || record.steps.length < 2 || record.steps.length > 5) {
    return undefined;
  }
  const steps: SymonConfirmPlan['steps'] = [];
  for (const [offset, step] of record.steps.entries()) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return undefined;
    const item = step as Record<string, unknown>;
    const summary = stringField(item.summary);
    if (item.index !== offset + 1 || !summary) return undefined;
    steps.push({ index: offset + 1, summary });
  }
  return { planId, steps };
}

/** window.__o8SymonAgent — the phone-hosted Agent Mode surface (see the bridge effect). */
interface SymonAgentBridge {
  invokeTool: SymonInvokeTool | null;
  invokeTransportedTool: SymonInvokeTool | null;
  interruptTool: SymonInterruptTool | null;
  endMachineSession: ((sessionId: string) => Promise<boolean>) | null;
  resolveConfirm: SymonResolveConfirm | null;
  config: { model: string; voice: string; tools: Array<Record<string, unknown>> } | null;
  /** Legacy relay alias; entries are now fully correlated when callers pass metadata. */
  confirms: SymonConfirmEntry[];
  /** Live, unexpired gates for v2 relays. */
  readonly pendingConfirmations: SymonConfirmEntry[];
}

/**
 * Auto-stop after this long with no activity — token guardrail. Counts only
 * during USER silence between turns (the model's whole turn is suspended in
 * onEvent), so this is "how long a quiet operator keeps the line open." 90s is
 * comfortable for thinking/observing without dropping; raise if it ever feels
 * abrupt, lower to trim idle spend.
 */
const IDLE_MS = 90_000;

/**
 * USER-side activity that resets the idle clock. The MODEL's turn is handled
 * separately in onEvent via the response.* lifecycle — crucially NOT via
 * `*.audio.delta`: in WebRTC the model's audio rides the RTP media track, so
 * those byte-delta events never arrive on the data channel. Keying the idle
 * reset off them (as we used to) let the 20s timer fire mid-answer and cut a
 * long spoken response off. See the onEvent handler below.
 */
const SPEECH_EVENTS = new Set([
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'input_audio_buffer.committed',
]);

/**
 * "Open canvas" does a FULL-PAGE navigation (window.location.assign to
 * /preview/canvas-glass — the SPA bridge can't reliably cross that segment, so
 * the hard reload stays). A WebRTC session can't survive a document reload, and
 * — the part that bit 0.1.426 — React effect CLEANUPS DON'T RUN on
 * window.location.assign (the browser unloads the document before React commits),
 * so the resume marker can't be stamped on unmount. Instead a HEARTBEAT writes a
 * fresh marker to localStorage every few seconds while live; the destination
 * route (which also mounts this host) reads it on mount and auto-resumes if it's
 * recent. localStorage, not sessionStorage, so it's bulletproof across the hard
 * reload; the TTL gates a stale marker (e.g. after a crash). One ~2s reconnect
 * entering the canvas, then every canvas tool runs without dropping the line. A
 * NEW session (no prior conversation memory) — acceptable for the hop; seamless
 * same-session survival would need the reliable SPA nav this route lacks.
 */
const HANDOFF_KEY = 'o8:realtime-handoff';
const HANDOFF_TTL_MS = 12_000;
const HANDOFF_HEARTBEAT_MS = 2_500;

function writeHandoff() {
  try { localStorage.setItem(HANDOFF_KEY, String(Date.now())); } catch { /* no localStorage */ }
}
function clearHandoff() {
  try { localStorage.removeItem(HANDOFF_KEY); } catch { /* no localStorage */ }
}

export function RealtimeVoiceHost() {
  const sessionRef = useRef<RealtimeSessionHandle | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True between response.created and response.done — i.e. while Symon is
  // mid-answer. The idle clock is HARD-OFF for the whole window so no
  // intermediate event can re-arm it and cut a long reply short.
  const respondingRef = useRef(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const managedOwner = useRef(false);
  const selectingVoice = useRef(false);
  const selectionGeneration = useRef(0);
  useEffect(() => {
    const changed = (event: Event) => {
      const state = (event as CustomEvent<string>).detail;
      managedOwner.current = !['idle', 'closed', 'error'].includes(state);
      const mapped: RealtimeStatus = state === 'closing' ? 'stopping' : state === 'closed' ? 'idle' : state === 'unknown' ? 'error' : state as RealtimeStatus;
      (window as unknown as { __o8RealtimeStatus?: RealtimeStatus }).__o8RealtimeStatus = mapped;
      window.dispatchEvent(new Event('o8:symon-voice-status'));
    };
    window.addEventListener('o8:managed-symon-status', changed);
    return () => window.removeEventListener('o8:managed-symon-status', changed);
  }, []);
  // Why the session failed (e.g. a model the realtime endpoint refuses). The
  // pill shows this instead of the generic "Voice unavailable" when we have it.
  const [statusDetail, setStatusDetail] = useState<string | null>(null);

  const clearIdle = useCallback(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  // INTENTIONAL end (toggle-off / idle-auto-off): stop the session + heartbeat
  // AND clear the resume marker so the next route does NOT auto-resume. A
  // full-page canvas nav never reaches here (the browser unloads the page), so
  // the heartbeat's fresh marker survives and the destination resumes.
  const stop = useCallback(() => {
    selectionGeneration.current++;
    clearIdle();
    clearHeartbeat();
    clearHandoff();
    respondingRef.current = false;
    void sessionRef.current?.stop();
    sessionRef.current = null;
  }, [clearIdle, clearHeartbeat]);

  const armIdle = useCallback(() => {
    clearIdle();
    idleTimerRef.current = setTimeout(() => {
      console.log(`${LOG} idle ${IDLE_MS / 1000}s with no speech — auto-stopping`);
      stop();
    }, IDLE_MS);
  }, [clearIdle, stop]);

  const start = useCallback(() => {
    if (sessionRef.current) return;
    respondingRef.current = false;
    let voice = DEFAULT_VOICE;
    try {
      voice = localStorage.getItem('o8:realtime-voice') || DEFAULT_VOICE;
    } catch {
      /* no localStorage in this context */
    }
    console.log(`${LOG} starting realtime voice (voice=${voice})`);
    // Each voice session is one thread in the Symon store (#3455).
    const recorder = createSymonVoiceTranscriptRecorder();
    sessionRef.current = startRealtimeSession({
      voice,
      onStatus: (s, detail) => {
        setStatus(s);
        setStatusDetail(s === 'error' && detail ? detail : null);
      },
      onEvent: (e) => {
        recorder.observe(e);
        const t = typeof e.type === 'string' ? e.type : '';
        // HARD-GATE the idle clock on a responding flag. We must NOT lean on
        // intermediate response.*/transcript-delta events to keep re-arming it:
        // in WebRTC the audio rides the media track and the data channel can go
        // silent for the whole spoken answer, so the timer would fire mid-reply
        // (the 0.1.423 bug). Instead: OFF for the entire model turn
        // (response.created → response.done), then re-armed once when the turn
        // ends. A tool call mints a fresh response.created after response.done,
        // so tool→speak chains stay suspended too.
        if (t === 'response.created') {
          respondingRef.current = true;
          clearIdle();
        } else if (t === 'response.done') {
          respondingRef.current = false;
          armIdle();
        } else if (!respondingRef.current && SPEECH_EVENTS.has(t)) {
          // User activity between turns → keep the line open.
          armIdle();
        }
      },
      onError: (msg) => console.warn(`${LOG} error: ${msg}`),
    });
    // Resume marker: write it now + keep it fresh on a heartbeat, so a full-page
    // canvas nav (which skips React cleanup) always leaves a recent marker for
    // the destination route to auto-resume from.
    writeHandoff();
    clearHeartbeat();
    heartbeatRef.current = setInterval(writeHandoff, HANDOFF_HEARTBEAT_MS);
    // Start the idle clock immediately — a session opened but never spoken to
    // still auto-closes after IDLE_MS.
    armIdle();
  }, [armIdle, clearIdle, clearHeartbeat]);

  const toggle = useCallback(() => {
    if (managedOwner.current) { window.dispatchEvent(new Event('o8:managed-symon-toggle')); return; }
    if (sessionRef.current) { stop(); return; }
    if (selectingVoice.current) return;
    selectingVoice.current = true;
    const selection = ++selectionGeneration.current;
    void fetch('/api/voice/live', { headers: { authorization: `Bearer ${getMobileWsToken()}` } })
      .then(response => response.json()).then(capability => {
        if (selection !== selectionGeneration.current) return;
        if (capability.enabled === true) {
          clearHandoff(); managedOwner.current = true;
          window.dispatchEvent(new Event('o8:managed-symon-toggle'));
          return;
        }
        toggleLegacy();
      }).catch(() => { if (selection === selectionGeneration.current) { setStatus('error'); setStatusDetail('Could not determine voice availability.'); } }).finally(() => { if (selection === selectionGeneration.current) selectingVoice.current = false; });
    function toggleLegacy() {
    if (sessionRef.current) {
      console.log(`${LOG} toggle → off`);
      stop();
    } else {
      console.log(`${LOG} toggle → on`);
      start();
    }
    }
  }, [start, stop]);

  useEffect(() => {
    const stopHost = () => {
      selectionGeneration.current++; selectingVoice.current = false;
      if (sessionRef.current) stop();
      window.dispatchEvent(new Event('o8:managed-symon-stop'));
    };
    window.addEventListener('o8:voice-host-stop-all', stopHost);
    return () => window.removeEventListener('o8:voice-host-stop-all', stopHost);
  }, [stop]);

  // Right-⌘ double-tap → `o8:realtime-toggle` (emitted from fn_hotkey.rs).
  useEffect(() => {
    // Main-window only — a main-app page in the native browser-view would
    // ACL-crash on this listen (see canUseTauriEvents).
    if (!canUseTauriEvents()) return;
    let unlisten: (() => void) | null = null;
    let alive = true;
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen('o8:realtime-toggle', () => toggle()))
      .then((un) => {
        if (alive) unlisten = un;
        else un();
      })
      .catch((e) => console.warn(`${LOG} listen failed`, e));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [toggle]);

  // Phone remote (o8-mobile → POST /api/mobile/symon) drives the SAME toggle()
  // the double-tap does: the route evals an `o8:symon-remote-toggle` CustomEvent
  // into this webview. The mic + WebRTC session stay on the Mac — the phone is
  // only the trigger. __o8SymonRemoteReady lets the route gate (is the host
  // mounted?) and __o8RealtimeStatus lets it report on/connecting/live back.
  useEffect(() => {
    const w = window as unknown as { __o8SymonRemoteReady?: boolean };
    const onRemote = () => toggle();
    const onSidebar = () => toggle();
    window.addEventListener('o8:symon-remote-toggle', onRemote);
    window.addEventListener('o8:symon-voice-toggle', onSidebar);
    w.__o8SymonRemoteReady = true;
    return () => {
      window.removeEventListener('o8:symon-remote-toggle', onRemote);
      window.removeEventListener('o8:symon-voice-toggle', onSidebar);
      w.__o8SymonRemoteReady = false;
    };
  }, [toggle]);

  useEffect(() => {
    if (managedOwner.current) return;
    (window as unknown as { __o8RealtimeStatus?: RealtimeStatus }).__o8RealtimeStatus = status;
    window.dispatchEvent(new Event('o8:symon-voice-status'));
  }, [status]);

  // Symon Agent Mode (phone-hosted) bridge. The phone hosts the WebRTC session,
  // but every tool STILL executes here on the Mac. This publishes the surface the
  // gated routes reach through the webview eval bridge:
  //   • __o8SymonAgent.invokeTool(name, args, correlation?) — the SAME
  //     realtime_invoke_tool the desk session calls, with additive phone IDs;
  //   • __o8SymonAgent.interruptTool(correlation) — cancels that exact native
  //     task on phone barge-in, stop, preemption, or timeout;
  //   • __o8SymonAgent.resolveConfirm(id, allow) — resolves the Rust oneshot by
  //     its gate-owned identity; the original invoke remains pending meanwhile;
  //   • __o8SymonAgent.config.tools — realtime_tools() schemas so /session bakes
  //     Symon's whole brain into the phone's ephemeral token (config parity);
  //   • __o8SymonAgent.confirms/pendingConfirmations — structured dock gates.
  // We publish here (not from a raw eval) because bare-specifier dynamic imports
  // don't resolve inside an eval string. See docs/internals/symon-agent-mode.md.
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const w = window as unknown as { __o8SymonAgent?: SymonAgentBridge };
    const confirms: SymonConfirmEntry[] = [];
    const bridge: SymonAgentBridge = {
      invokeTool: null,
      invokeTransportedTool: null,
      interruptTool: null,
      endMachineSession: null,
      resolveConfirm: null,
      config: null,
      confirms,
      get pendingConfirmations() {
        const now = Date.now();
        return confirms.filter((entry) => !entry.settled && entry.expiresAt > now);
      },
    };
    w.__o8SymonAgent = bridge;
    let unlistenConfirm: (() => void) | null = null;
    let unlistenConfirmDismissed: (() => void) | null = null;

    void import('@tauri-apps/api/core')
      .then(({ invoke }) => {
        if (!alive) return;
        bridge.invokeTool = (name, args, correlation, utterance) => {
          const startedAt = Date.now();
          const pending = invoke('realtime_invoke_tool', {
            name,
            args,
            sessionId: correlation?.sessionId,
            callId: correlation?.callId,
            utterance,
            reviewGuardId: correlation
              ? symonReviewGuardId(correlation.sessionId, correlation.callId)
              : undefined,
          });
          const markSettled = () => {
            for (const entry of confirms) {
              const sameCall = correlation
                ? entry.sessionId === correlation.sessionId && entry.callId === correlation.callId
                : entry.tool === name && entry.at >= startedAt;
              if (sameCall) entry.settled = true;
            }
          };
          void pending.then(markSettled, markSettled);
          return pending;
        };
        bridge.invokeTransportedTool = (name, args, correlation) => invoke('symon_transport_invoke_tool', {
          name,
          args,
          sessionId: correlation?.sessionId,
          callId: correlation?.callId,
        });
        bridge.interruptTool = (correlation) => invoke<boolean>('realtime_interrupt_review', {
          reviewGuardId: symonReviewGuardId(correlation.sessionId, correlation.callId),
        });
        bridge.endMachineSession = (sessionId) => invoke<boolean>('symon_machine_session_end', {
          sessionId,
        });
        bridge.resolveConfirm = async (confirmationId, allow, correlation, terminal) => {
          const result = await invoke<SymonConfirmResolution>('agent_confirm_v2', {
            confirmationId,
            allow,
            sessionId: correlation.sessionId,
            callId: correlation.callId,
            terminal,
          });
          if (result.status !== 'not_found') {
            const entry = confirms.find((candidate) => candidate.confirmationId === confirmationId);
            if (entry) entry.settled = true;
          }
          return result;
        };
        return invoke('realtime_tools').then((raw) => {
          if (!alive) return;
          const tools = Array.isArray(raw)
            ? (raw as Array<Record<string, unknown>>).map((t) => ({ type: 'function', ...t }))
            : [];
          let voice = DEFAULT_VOICE;
          try { voice = localStorage.getItem('o8:realtime-voice') || DEFAULT_VOICE; } catch { /* no localStorage */ }
          bridge.config = { model: REALTIME_MODEL, voice, tools };
          console.log(`${LOG} agent bridge ready (${tools.length} tools)`);
        });
      })
      .catch((e) => console.warn(`${LOG} agent bridge unavailable:`, e));

    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<Record<string, unknown>>('o8:agent-confirm', (e) => {
          const p = e.payload || {};
          const rawTarget = p.target && typeof p.target === 'object'
            ? p.target as Record<string, unknown>
            : {};
          confirms.push({
            confirmationId: stringField(p.confirmationId) || '',
            taskId: stringField(p.taskId) || '',
            tool: stringField(p.tool) || '',
            summary: stringField(p.summary) || '',
            kind: p.kind === 'plan' ? 'plan' : 'action',
            plan: confirmationPlan(p.plan),
            expiresAt: typeof p.expiresAt === 'number' ? p.expiresAt : Date.now() + 120_000,
            target: {
              approvalId: stringField(rawTarget.approvalId),
              packetId: stringField(rawTarget.packetId),
              laneId: stringField(rawTarget.laneId),
              sessionKey: stringField(rawTarget.sessionKey),
            },
            sessionId: stringField(p.sessionId),
            callId: stringField(p.callId),
            at: Date.now(),
          });
          while (confirms.length > 20) confirms.shift();
        }),
      )
      .then((un) => { if (alive) unlistenConfirm = un; else un(); })
      .catch(() => { /* not in a Tauri webview */ });
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<Record<string, unknown>>('o8:agent-confirm-dismissed', (e) => {
          const p = e.payload || {};
          const confirmationId = stringField(p.confirmationId);
          const taskId = stringField(p.taskId);
          for (const entry of confirms) {
            if (entry.confirmationId === confirmationId && entry.taskId === taskId) {
              entry.settled = true;
            }
          }
        }),
      )
      .then((un) => { if (alive) unlistenConfirmDismissed = un; else un(); })
      .catch(() => { /* not in a Tauri webview */ });

    return () => {
      alive = false;
      unlistenConfirm?.();
      unlistenConfirmDismissed?.();
      if (w.__o8SymonAgent === bridge) w.__o8SymonAgent = undefined;
    };
  }, []);

  // On a React-driven unmount, LIGHT teardown only — stop the session + timers
  // but do NOT clear the resume marker (this unmount may be a navigation; the
  // destination route should resume). Intentional ends go through stop(), which
  // clears the marker. (A full-page canvas nav doesn't reach here at all — the
  // browser unloads the document before React runs cleanups, which is exactly
  // why the marker is a localStorage heartbeat, not stamped here.)
  useEffect(() => () => {
    void sessionRef.current?.stop();
    sessionRef.current = null;
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
  }, []);

  // Pick the session back up if we just arrived from a live one (the canvas-nav
  // heartbeat marker is recent). Runs once per mount. start() re-arms its own
  // heartbeat, so the marker stays fresh for the next hop.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current || !isTauri()) return;
    resumedRef.current = true;
    if ((window as Window & { __O8_VOICE_HOST__?: boolean }).__O8_VOICE_HOST__) { clearHandoff(); return; }
    let raw: string | null = null;
    try { raw = localStorage.getItem(HANDOFF_KEY); } catch { /* no localStorage */ }
    if (!raw) return;
    const ts = Number(raw);
    if (Number.isFinite(ts) && Date.now() - ts < HANDOFF_TTL_MS) {
      clearHandoff();
      // Use the same owner selection as explicit controls, never start legacy in parallel.
      toggle();
    } else {
      clearHandoff(); // stale marker (old session / crash) — drop it
    }
  }, [toggle]);

  // Auto-clear the transient error pill after a few seconds.
  useEffect(() => {
    if (status !== 'error') return;
    const t = setTimeout(() => {
      setStatus('idle');
      setStatusDetail(null);
    }, 3500);
    return () => clearTimeout(t);
  }, [status]);

  const connecting = status === 'requesting-mic' || status === 'connecting';
  const visible = connecting || status === 'live' || status === 'error';
  const dotColor = status === 'error' ? '#ef4444' : status === 'live' ? '#34d399' : '#f59e0b';
  // Lead with the failure's own first sentence when we have one — a refused
  // model names itself there; the full reason stays on the hover title.
  const errorHeadline = statusDetail
    ? (statusDetail.split('. ')[0] || statusDetail).slice(0, 80)
    : null;
  const label = status === 'error'
    ? (errorHeadline ?? 'Voice unavailable')
    : connecting ? 'Connecting…' : 'Voice live';

  // A fixed, full-width, click-through container handles centering so the pill's
  // own framer transform (y/scale) never fights a translateX centering hack.
  return (
    <>
      <ManagedSymonVoiceHost />
      <div
      style={{
        position: 'fixed',
        top: 12,
        left: 0,
        right: 0,
        display: 'flex',
        justifyContent: 'center',
        zIndex: 2147483646,
        pointerEvents: 'none',
      }}
    >
      <AnimatePresence>
        {visible && (
          <motion.button
            type="button"
            onClick={() => stop()}
            title={status === 'error' && statusDetail
              ? statusDetail
              : 'Voice-to-voice is on — double-tap right ⌘ or click to stop'}
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            style={{
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              paddingTop: 6,
              paddingBottom: 6,
              paddingLeft: 12,
              paddingRight: 14,
              borderRadius: 999,
              border: '1px solid var(--t-border)',
              background: 'var(--t-bg-card)',
              backdropFilter: 'blur(18px) saturate(1.05)',
              WebkitBackdropFilter: 'blur(18px) saturate(1.05)',
              boxShadow: '0 6px 20px rgba(0, 0, 0, 0.18)',
              color: 'var(--t-text)',
              fontSize: 12.5,
              fontWeight: 500,
              letterSpacing: '-0.01em',
              cursor: 'pointer',
            }}
          >
            <motion.span
              animate={status === 'live' ? { opacity: [1, 0.35, 1] } : { opacity: 1 }}
              transition={
                status === 'live'
                  ? { repeat: Infinity, duration: 1.6, ease: 'easeInOut' }
                  : { duration: 0.2 }
              }
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: dotColor,
                boxShadow: `0 0 8px ${dotColor}`,
                flexShrink: 0,
              }}
            />
            <span>{label}</span>
          </motion.button>
        )}
      </AnimatePresence>
      </div>
    </>
  );
}
