'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { useO8Auth } from '@/components/auth/O8AuthProvider';
import { ScreenshotAnnotator } from '@/components/desktop/thoughts/chat-panel/ScreenshotAnnotator';
import { ownsVisualDraft, subscribeVisualCapture } from '@/lib/composer/visual-capture-state';
import { visualCaptureTargets, type VisualCaptureTarget } from '@/lib/composer/visual-capture-targets';
import { readVisualDraft, removeVisualDraft, restoreVisualDraft, saveVisualDraft, subscribeVisualDrafts, type VisualInstructionDraft } from '@/lib/composer/visual-draft-store';
import { MAX_VISUAL_FRAMES, visualInstructionScope, type VisualInstructionTarget } from '@/lib/composer/visual-instruction';
import { VISUAL_REQUEST_MARKER } from '@/lib/composer/visual-instruction-send';
import { commitVisualInstruction } from '@/lib/composer/visual-instruction-commit';
import { inspectVisualDraft, invalidateVisualInspection } from '@/lib/composer/visual-inspection-client';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';
import type { ComposerSendImage } from '@/lib/hooks/use-composer-send-buffer';

export interface VisualComposerBinding {
  enabled: boolean; active: boolean; draft: VisualInstructionDraft | null;
  busy: boolean; locked: boolean; capturing: boolean; error: string | null; canSend: boolean;
  confirmClear: boolean; label: string;
  open: () => void; close: () => void; captureScreen: () => void; pickImages: () => void;
  upload: (files: FileList | File[]) => void; setWords: (words: string) => void;
  annotate: (id: string) => void; removeFrame: (id: string) => void;
  send: () => void; toggleClear: () => void; clear: () => void;
}
export interface VisualInstructionComposerProps {
  active: boolean; target: VisualInstructionTarget | null; label: string;
  anchor: RefObject<HTMLTextAreaElement | null>;
  capture: (text: string, images: ComposerSendImage[]) => ComposerQueuePayload;
  children: (binding: VisualComposerBinding) => ReactNode;
}
const noDraft = () => null;

/** Owns the durable request; its single visible input is the normal chat composer. */
export function VisualInstructionComposer(props: VisualInstructionComposerProps) {
  const auth = useO8Auth();
  const principal = auth.user?.id ?? 'local';
  const current = useRef({ props, principal, loaded: auth.isLoaded }); current.current = { props, principal, loaded: auth.isLoaded };
  const registration = useRef<VisualCaptureTarget | null>(null);
  const alive = useRef(true);
  const input = useRef<HTMLInputElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clearing = useRef(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const scope = props.target ? visualInstructionScope(props.target) : '';
  const capturing = useSyncExternalStore(subscribeVisualCapture, () => props.target ? ownsVisualDraft(principal, props.target) : false, () => false);
  const draft = useSyncExternalStore(subscribeVisualDrafts,
    () => props.target ? readVisualDraft(principal, props.target) : null, noDraft);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (current.current.props.target && auth.isLoaded) void restoreVisualDraft(principal, current.current.props.target).catch(cause => setError(String(cause)));
  }, [auth.isLoaded, principal, scope]);
  useEffect(() => {
    const { props: selectedProps } = current.current;
    if (!selectedProps.active || !selectedProps.target || !auth.isLoaded) return;
    const target = { ...selectedProps.target };
    const selected: VisualCaptureTarget = { principal, target, label: selectedProps.label,
      eligible: () => current.current.principal === principal && current.current.props.active
        && current.current.props.target !== null && visualInstructionScope(current.current.props.target) === scope
        && Boolean(props.anchor.current?.isConnected && props.anchor.current.getClientRects().length),
      template: () => current.current.props.capture(VISUAL_REQUEST_MARKER, []),
    };
    registration.current = selected;
    const unregister = visualCaptureTargets.register(selected);
    const focus = () => visualCaptureTargets.focus(selected);
    const textarea = props.anchor.current;
    textarea?.addEventListener('focus', focus); textarea?.addEventListener('pointerdown', focus);
    return () => { unregister(); textarea?.removeEventListener('focus', focus); textarea?.removeEventListener('pointerdown', focus); registration.current = null; };
  }, [auth.isLoaded, principal, props.active, props.anchor, props.label, scope]);

  useEffect(() => {
    const frame = draft?.request.frames.at(-1);
    if (!draft || draft.status !== 'draft' || !frame?.observation || !draft.request.utterance.trim()) return;
    inspectVisualDraft({ principal, requestId: draft.request.id, observation: frame.observation,
      utterance: draft.request.utterance, candidates: frame.candidates ?? [] }, draft.request.target, fetch, draft.inspectionReadyAt);
    return () => invalidateVisualInspection(principal, draft.request.id);
  }, [draft, principal]);

  const createDraft = (): VisualInstructionDraft | null => props.target && auth.isLoaded ? {
    principal, status: 'draft', template: props.capture(VISUAL_REQUEST_MARKER, []),
    request: { version: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString(), target: { ...props.target }, utterance: '', frames: [] },
  } : null;
  const save = (value: VisualInstructionDraft) => { void saveVisualDraft(value).catch(cause => setError(String(cause))); };
  const open = () => {
    setExpanded(true); setDismissed(''); setError(null);
    if (!draft || draft.status === 'saved') { const fresh = createDraft(); if (fresh) save(fresh); }
    if (registration.current) visualCaptureTargets.focus(registration.current);
    props.anchor.current?.focus();
  };
  const captureScreen = () => { if (registration.current) visualCaptureTargets.request(registration.current); setExpanded(true); setDismissed(''); };
  const addFiles = async (files: File[]) => {
    if (!props.target || busy || capturing || draft?.status === 'saving' || draft?.status === 'unknown') return;
    const snapshot = draft?.status === 'draft' ? draft : createDraft();
    if (!snapshot) return;
    if (files.length + snapshot.request.frames.length > MAX_VISUAL_FRAMES) { setError('Use up to four images in one instruction.'); return; }
    setBusy(true); setError(null); setExpanded(true); setDismissed('');
    try {
      const frames = [];
      for (const file of files) {
        if (!/^image\/(?:png|jpeg|gif|webp)$/.test(file.type) || file.size > 3_700_000) throw new Error('Use PNG, JPEG, GIF or WebP images under 3.7 MB.');
        const dataUri = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
        const image = new window.Image(); image.src = dataUri; await image.decode();
        frames.push({ id: `frame-${crypto.randomUUID()}`, atMs: Math.min(3_600_000, Math.max(0, Date.now() - Date.parse(snapshot.request.createdAt))),
          width: image.naturalWidth, height: image.naturalHeight, transcript: '', image: { name: file.name, dataUri }, strokes: [], pins: [] });
      }
      await saveVisualDraft({ ...snapshot, request: { ...snapshot.request, clarification: undefined, frames: [...snapshot.request.frames, ...frames] } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const send = async () => {
    if (!draft || busy || clearing.current || capturing || draft.status === 'saved' || !draft.request.utterance.trim() || !draft.request.frames.length) return;
    setBusy(true); setError(null);
    try {
      const item = await commitVisualInstruction(draft, () => alive.current && current.current.loaded && current.current.principal === draft.principal);
      if (item) setExpanded(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
    } finally { setBusy(false); }
  };
  const clear = async () => {
    if (!draft || busy || clearing.current || capturing) return;
    clearing.current = true; setBusy(true); setError(null);
    try {
      await removeVisualDraft(principal, draft.request.target, draft.request.id);
      setConfirmClear(false); setExpanded(false); props.anchor.current?.focus();
    } catch (cause) { setError(String(cause)); }
    finally { clearing.current = false; setBusy(false); }
  };
  const locked = busy || capturing || (draft !== null && draft.status !== 'draft');
  const draftKey = draft ? `${draft.request.id}:${draft.request.frames.length}` : '';
  const active = props.active && (capturing || expanded || Boolean(draft && draft.status !== 'saved' && dismissed !== draftKey));
  const editFrame = draft?.request.frames.find(frame => frame.id === editing);
  return <>
    {props.children({ enabled: props.active && Boolean(props.target) && auth.isLoaded, active, draft, busy, locked, capturing, error, confirmClear, label: props.label,
      canSend: Boolean(draft && draft.status !== 'saved' && draft.status !== 'saving' && !busy && !capturing && draft.request.utterance.trim() && draft.request.frames.length),
      open, close: () => { setExpanded(false); setDismissed(draftKey); setConfirmClear(false); props.anchor.current?.focus(); },
      captureScreen, pickImages: () => input.current?.click(), upload: files => { void addFiles(Array.from(files)); },
      setWords: words => { if (draft && !locked) save({ ...draft, inspectionReadyAt: Date.now(), request: { ...draft.request, utterance: words.slice(0, 16_000), clarification: undefined } }); },
      annotate: id => { if (!locked) setEditing(id); },
      removeFrame: id => { if (draft && !locked) save({ ...draft, request: { ...draft.request, clarification: undefined, frames: draft.request.frames.filter(frame => frame.id !== id) } }); },
      send: () => { void send(); }, toggleClear: () => setConfirmClear(value => !value),
      clear: () => { void clear(); },
    })}
    <input ref={input} aria-label="Add visual instruction frames" type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" style={{ display: 'none' }} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void addFiles(files); }} />
    {props.active && draft && editFrame ? <ScreenshotAnnotator image={{ ...editFrame.image, mimeType: 'image/png' }}
      instruction={{ value: draft.request.utterance, onChange: words => { if (!locked) save({ ...draft, request: { ...draft.request, utterance: words, clarification: undefined } }); } }}
      onCancel={() => setEditing(null)} onDone={dataUri => {
      save({ ...draft, request: { ...draft.request, clarification: undefined, frames: draft.request.frames.map(frame => frame.id === editFrame.id ? { ...frame, id: `frame-${crypto.randomUUID()}`, image: { name: frame.image.name, dataUri }, observation: undefined, candidates: undefined, strokes: [], pins: [] } : frame) } });
      setEditing(null); props.anchor.current?.focus();
    }} /> : null}
  </>;
}
