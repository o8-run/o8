import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import {
  appendOrchestratorDeliveryFailureEntry,
  armOrchestratorSendWatchdog,
  deliverOrchestratorPayload,
  isOrchestratorSendSettlementEvent,
  settleOrchestratorSendWatchdog,
  type PendingOrchestratorSend,
} from './delivery';
import {
  listPersistedOrchestratorPendingSends,
  ORCHESTRATOR_PENDING_SEND_STALE_MS,
  ORCHESTRATOR_PENDING_SEND_MAX_AGE_MS,
  persistOrchestratorPendingSend,
  readPersistedOrchestratorPendingSend,
  settlePersistedOrchestratorPendingSend,
  type PersistedOrchestratorPendingSend,
} from './pending-send-store';
import { formatTimestampLabel } from './shared';
import { optimisticUserEntry } from './optimistic-user-entry';
import { pendingSendImages } from './pending-image';

interface DurablePendingSendOptions {
  repoPath: string | null;
  threadId: string | null;
  pendingRef: MutableRefObject<PendingOrchestratorSend | null>;
  messagesRef: MutableRefObject<MobileTranscriptEntry[]>;
  setMessages: Dispatch<SetStateAction<MobileTranscriptEntry[]>>;
  getWebSocket: () => WebSocket | null;
  connect: () => void;
  setStatusBusy: () => void;
  setStatusReady: () => void;
}

interface OrchestratorActivity {
  event: string;
  data?: Record<string, unknown>;
  observedAt: number;
}

function pendingUserEntry(record: PersistedOrchestratorPendingSend): MobileTranscriptEntry {
  return optimisticUserEntry({
    id: `orch-user-${record.clientMessageId}`,
    text: record.displayMessage,
    timestamp: record.sentAtMs,
    timestampLabel: formatTimestampLabel(record.sentAtMs),
    attachments: pendingSendImages(record) ?? [],
  });
}

export function pendingSendWirePayload(record: PersistedOrchestratorPendingSend, repoPath: string): string | null {
  if (record.wirePayload) return pendingSendImages(record) === null ? null : record.wirePayload;
  if (record.attachmentsRequired) return null;
  return JSON.stringify({
    type: 'orchestrator-send',
    repoPath,
    threadId: record.threadId,
    clientMessageId: record.clientMessageId,
    message: record.text,
    displayMessage: record.displayMessage,
  });
}

export function useDurablePendingSend(options: DurablePendingSendOptions) {
  const {
    repoPath, threadId, pendingRef, messagesRef, setMessages,
    getWebSocket, connect, setStatusBusy, setStatusReady,
  } = options;
  const activeRecordRef = useRef<PersistedOrchestratorPendingSend | null>(null);
  const unsettledRecordsRef = useRef(new Map<string, { repoPath: string | null; record: PersistedOrchestratorPendingSend }>());
  const rememberIdentity = useCallback((record: PersistedOrchestratorPendingSend) => {
    const records = unsettledRecordsRef.current;
    for (const [id, item] of records) {
      if (Date.now() - item.record.sentAtMs > ORCHESTRATOR_PENDING_SEND_MAX_AGE_MS) records.delete(id);
    }
    // Keep only confirmation metadata for older live attempts, never their
    // potentially large wire/attachment payloads. Retry still needs its full record.
    records.set(record.clientMessageId, { repoPath, record: {
      clientMessageId: record.clientMessageId, threadId: record.threadId,
      displayMessage: record.displayMessage, text: record.displayMessage, sentAtMs: record.sentAtMs,
    } });
  }, [repoPath]);
  useEffect(() => {
    for (const [id, item] of unsettledRecordsRef.current) {
      if (item.repoPath !== repoPath || item.record.threadId !== threadId) unsettledRecordsRef.current.delete(id);
    }
  }, [repoPath, threadId]);
  useEffect(() => () => { unsettledRecordsRef.current.clear(); }, []);

  const ensureUserBubble = useCallback((record: PersistedOrchestratorPendingSend) => {
    setMessages((prev) => {
      const recovered = pendingUserEntry(record);
      const existing = prev.find((entry) => entry.id === recovered.id);
      if (existing && (existing.media?.length || !recovered.media?.length)) return prev;
      const next = existing
        ? prev.map((entry) => entry.id === recovered.id ? { ...entry, media: recovered.media } : entry)
        : [...prev, recovered];
      messagesRef.current = next;
      return next;
    });
  }, [messagesRef, setMessages]);

  const removeFailureEntry = useCallback((clientMessageId: string) => {
    setMessages((prev) => {
      const next = prev.filter((entry) => entry.id !== `orch-delivery-error-${clientMessageId}`);
      if (next.length === prev.length) return prev;
      messagesRef.current = next;
      return next;
    });
  }, [messagesRef, setMessages]);

  const settleRecord = useCallback((record: PersistedOrchestratorPendingSend) => {
    settlePersistedOrchestratorPendingSend(record.threadId, record.clientMessageId);
    unsettledRecordsRef.current.delete(record.clientMessageId);
    setMessages((prev) => {
      const userId = `orch-user-${record.clientMessageId}`;
      const warningId = `orch-delivery-error-${record.clientMessageId}`;
      const next = prev
        .filter((entry) => entry.id !== warningId)
        .map((entry) => entry.role === 'user' && entry.id === userId
          ? { ...entry, deliveryConfirmed: true }
          : entry);
      // Retained history can evict the optimistic row before its acknowledgement.
      // Carry the real send's confirmation through the existing history merge so
      // an older saved warning cannot reappear after reload or a stale write.
      if (!next.some((entry) => entry.role === 'user' && entry.id === userId)) {
        const entry = { ...pendingUserEntry(record), deliveryConfirmed: true };
        const index = next.findIndex((message) => typeof message.timestamp === 'number' && message.timestamp > record.sentAtMs);
        next.splice(index < 0 ? next.length : index, 0, entry);
      }
      messagesRef.current = next;
      return next;
    });
    if (activeRecordRef.current?.clientMessageId === record.clientMessageId) activeRecordRef.current = null;
  }, [messagesRef, setMessages]);

  const armRecord = useCallback((record: PersistedOrchestratorPendingSend, deliveredAt: number) => {
    activeRecordRef.current = record;
    armOrchestratorSendWatchdog({
      clientMessageId: record.clientMessageId,
      deliveredAt,
      originalText: record.displayMessage,
      pendingRef,
      setStatusReady,
      setMessages,
      messagesRef,
      onSettled: () => settleRecord(record),
    });
  }, [messagesRef, pendingRef, setMessages, setStatusReady, settleRecord]);

  const deliverRecord = useCallback(async (record: PersistedOrchestratorPendingSend) => {
    if (!repoPath) return false;
    const payload = pendingSendWirePayload(record, repoPath);
    if (!payload) return false;
    return deliverOrchestratorPayload({
      payload,
      getWebSocket,
      connect,
    });
  }, [connect, getWebSocket, repoPath]);

  const recordPending = useCallback((record: PersistedOrchestratorPendingSend) => {
    activeRecordRef.current = record;
    rememberIdentity(record);
    persistOrchestratorPendingSend(record);
  }, [rememberIdentity]);

  const cancelPending = useCallback((clientMessageId: string) => {
    const activeRecord = activeRecordRef.current;
    const record = activeRecord?.clientMessageId === clientMessageId
      ? activeRecord
      : threadId ? readPersistedOrchestratorPendingSend(threadId, clientMessageId) : null;
    if (record) settlePersistedOrchestratorPendingSend(record.threadId, record.clientMessageId);
    unsettledRecordsRef.current.delete(clientMessageId);
    if (pendingRef.current?.clientMessageId === clientMessageId) {
      clearTimeout(pendingRef.current.timeoutId);
      pendingRef.current = null;
    }
    if (activeRecord?.clientMessageId === clientMessageId) activeRecordRef.current = null;
    removeFailureEntry(clientMessageId);
  }, [pendingRef, removeFailureEntry, threadId]);

  const failPending = useCallback((record: PersistedOrchestratorPendingSend) => {
    setStatusReady();
    appendOrchestratorDeliveryFailureEntry(setMessages, messagesRef, {
      id: `orch-delivery-error-${record.clientMessageId}`,
      originalText: record.displayMessage,
      reason: record.attachmentsRequired && pendingSendImages(record) === null
        ? 'The image could not be saved for Retry. Reattach it and send again.'
        : undefined,
    });
  }, [messagesRef, setMessages, setStatusReady]);

  const observeActivity = useCallback((event: OrchestratorActivity) => {
    const record = activeRecordRef.current;
    if (record?.attachmentsRequired && event.event === 'error' && event.data?.clientMessageId === record.clientMessageId) {
      cancelPending(record.clientMessageId);
      setMessages(previous => {
        const next = previous.filter(entry => entry.id !== `orch-user-${record.clientMessageId}`);
        messagesRef.current = next; return next;
      });
      return;
    }
    if (settleOrchestratorSendWatchdog(pendingRef, event)) return;
    const ackClientMessageId = event.event === 'send-ack' && typeof event.data?.clientMessageId === 'string'
      ? event.data.clientMessageId
      : null;
    if (ackClientMessageId && threadId) {
      const remembered = unsettledRecordsRef.current.get(ackClientMessageId);
      const liveIdentity = remembered?.repoPath === repoPath
        && remembered.record.threadId === threadId
        && Date.now() - remembered.record.sentAtMs <= ORCHESTRATOR_PENDING_SEND_MAX_AGE_MS
        ? remembered.record : null;
      const ackRecord = record?.threadId === threadId && record.clientMessageId === ackClientMessageId
        ? record
        : readPersistedOrchestratorPendingSend(threadId, ackClientMessageId) ?? liveIdentity;
      if (ackRecord) {
        settleRecord(ackRecord);
      } else {
        // Quota failure can leave an earlier live send without a stored record.
        // A matching user identity still lets its acknowledgement retire only
        // that send's warning, while preserving every other pending attempt.
        const user = messagesRef.current.find((entry) => entry.role === 'user'
          && entry.id === `orch-user-${ackClientMessageId}`);
        if (user && typeof user.timestamp === 'number') settleRecord({
          threadId, clientMessageId: ackClientMessageId,
          text: user.text, displayMessage: user.text, sentAtMs: user.timestamp,
        });
      }
      return;
    }
    if (record && isOrchestratorSendSettlementEvent({
      clientMessageId: record.clientMessageId,
      deliveredAt: record.sentAtMs,
    }, event)) {
      settleRecord(record);
      return;
    }
    if (
      record
      && event.event === 'status'
      && event.data?.snapshot === true
    ) {
      void deliverRecord(record);
    }
  }, [cancelPending, deliverRecord, messagesRef, pendingRef, repoPath, setMessages, settleRecord, threadId]);

  const retryPending = useCallback(async (clientMessageId: string) => {
    if (!threadId) return;
    const activeRecord = activeRecordRef.current;
    const record = activeRecord?.clientMessageId === clientMessageId
      ? activeRecord
      : readPersistedOrchestratorPendingSend(threadId, clientMessageId);
    if (!record) return;
    ensureUserBubble(record);
    removeFailureEntry(clientMessageId);
    if (record.attachmentsRequired && pendingSendImages(record) === null) {
      failPending(record);
      return;
    }
    recordPending(record);
    setStatusBusy();
    const delivered = await deliverRecord(record);
    if (delivered) armRecord(record, Date.now());
    else failPending(record);
  }, [armRecord, deliverRecord, ensureUserBubble, failPending, recordPending, removeFailureEntry, setStatusBusy, threadId]);

  useEffect(() => {
    const activeRecord = activeRecordRef.current;
    if (!threadId || (activeRecord && activeRecord.threadId !== threadId)) {
      if (pendingRef.current) clearTimeout(pendingRef.current.timeoutId);
      pendingRef.current = null;
      activeRecordRef.current = null;
    }
    if (!threadId) return;
    const records = listPersistedOrchestratorPendingSends(threadId);
    if (records.length === 0) {
      activeRecordRef.current = null;
      return;
    }
    const newest = records[records.length - 1];
    if (activeRecordRef.current?.clientMessageId === newest.clientMessageId) return;
    for (const record of records) { ensureUserBubble(record); rememberIdentity(record); }

    activeRecordRef.current = newest;
    if (newest.attachmentsRequired && pendingSendImages(newest) === null) {
      failPending(newest);
      return;
    }
    if (Date.now() - newest.sentAtMs >= ORCHESTRATOR_PENDING_SEND_STALE_MS) {
      failPending(newest);
      return;
    }
    setStatusBusy();
    armRecord(newest, newest.sentAtMs);
  }, [armRecord, ensureUserBubble, failPending, pendingRef, rememberIdentity, setStatusBusy, threadId]);

  return { armRecord, cancelPending, failPending, observeActivity, recordPending, retryPending };
}
