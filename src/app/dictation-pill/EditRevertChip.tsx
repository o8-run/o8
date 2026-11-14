'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@/lib/tauri/bridge';

export type EditStatus = 'ready' | 'pending' | 'reverted' | 'copied';

/** The chip on screen. `id` names each edit-applied; `until` is when its
 * dismissal timer fires (epoch ms), so the native panel can dismiss it too. */
export interface EditChipState {
  id: number;
  app: string;
  status: EditStatus;
  until: number;
}

/** The chip's state, events and dismissal timers, shared by the web chip and
 * the native dock frame. */
export function useEditRevert(onError: (message: string) => void) {
  const [editApplied, setEditApplied] = useState<EditChipState | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef(0);

  const dismissAfter = useCallback((delayMs: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const until = Date.now() + delayMs;
    setEditApplied((current) => (current ? { ...current, until } : current));
    timerRef.current = setTimeout(() => setEditApplied(null), delayMs);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        unlisteners.push(await listen<{ app?: string }>('o8:edit-applied', (event) => {
          idRef.current += 1;
          setEditApplied({ id: idRef.current, app: event.payload?.app ?? '', status: 'ready', until: 0 });
          dismissAfter(20_000);
        }));
        unlisteners.push(await listen<{ outcome?: 'restored' | 'copied_to_clipboard' }>(
          'o8:edit-revert-settled',
          (event) => {
            const status = event.payload?.outcome === 'restored' ? 'reverted' : 'copied';
            setEditApplied((current) => (current ? { ...current, status } : current));
            dismissAfter(1_800);
          },
        ));
        if (disposed) unlisteners.splice(0).forEach((unlisten) => unlisten());
      })
      .catch((error) => onError(`edit-revert subscribe failed: ${error instanceof Error ? error.message : String(error)}`));

    return () => {
      disposed = true;
      unlisteners.splice(0).forEach((unlisten) => unlisten());
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [dismissAfter, onError]);

  const handleRevert = useCallback(async () => {
    setEditApplied((current) => (current ? { ...current, status: 'pending' } : current));
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<{ outcome: 'restored' | 'copied_to_clipboard' }>('agent_edit_revert');
      const status = result.outcome === 'restored' ? 'reverted' : 'copied';
      setEditApplied((current) => (current ? { ...current, status } : current));
      dismissAfter(1_800);
    } catch (error) {
      setEditApplied((current) => (current ? { ...current, status: 'ready' } : current));
      onError(`invoke agent_edit_revert failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [dismissAfter, onError]);

  return { edit: editApplied, revert: handleRevert };
}

interface EditRevertChipProps {
  edit: EditChipState | null;
  onRevert: () => void;
}

export function EditRevertChip({ edit: editApplied, onRevert: handleRevert }: EditRevertChipProps) {
  if (!editApplied) return null;

  return (
    <button
      type="button"
      onClick={handleRevert}
      disabled={editApplied.status !== 'ready'}
      style={{
        marginTop: 6,
        height: 24,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 11,
        paddingRight: 11,
        borderRadius: 12,
        background: 'var(--t-panel)',
        border: '1px solid var(--t-panel-border)',
        fontSize: 10.5,
        fontWeight: 300,
        letterSpacing: '-0.1px',
        color: editApplied.status === 'ready' ? 'var(--t-text)' : 'var(--t-text-muted)',
        textShadow: '0 1px 4px rgba(0, 0, 0, 0.35)',
        whiteSpace: 'nowrap',
        cursor: editApplied.status === 'ready' ? 'pointer' : 'default',
        animation: 'o8GlintIn 0.3s cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      {editApplied.status === 'reverted'
        ? 'Reverted'
        : editApplied.status === 'copied'
          ? 'Original copied'
          : editApplied.status === 'pending'
            ? 'Reverting…'
            : `Rewrote${editApplied.app ? ` in ${editApplied.app}` : ''} — Revert`}
      <style>{'@keyframes o8GlintIn { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: translateY(0); } }'}</style>
    </button>
  );
}
