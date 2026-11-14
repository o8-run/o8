'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@/lib/tauri/bridge';

type EditStatus = 'ready' | 'pending' | 'reverted' | 'copied';

interface EditApplied {
  app: string;
  status: EditStatus;
}

interface EditRevertChipProps {
  onError: (message: string) => void;
  onVisible?: (visible: boolean) => void;
}

export function EditRevertChip({ onError, onVisible }: EditRevertChipProps) {
  const [editApplied, setEditApplied] = useState<EditApplied | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismissAfter = useCallback((delayMs: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setEditApplied(null), delayMs);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        unlisteners.push(await listen<{ app?: string }>('o8:edit-applied', (event) => {
          setEditApplied({ app: event.payload?.app ?? '', status: 'ready' });
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

  useEffect(() => { onVisible?.(editApplied !== null); }, [editApplied, onVisible]);

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
