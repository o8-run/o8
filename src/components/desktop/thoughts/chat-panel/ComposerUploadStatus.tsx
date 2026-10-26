'use client';

import type { ComposerSendBuffer } from '@/lib/hooks/use-composer-send-buffer';
import { ComposerSendBufferStatus } from './ComposerSendBufferStatus';
import { RamsButton } from '@/components/desktop/settings/shared';

export function ComposerUploadStatus({ uploading, failed, onRetry, onDiscard }: {
  uploading: boolean; failed: boolean; onRetry: () => void; onDiscard: () => void;
}) {
  if (!uploading && !failed) return null;
  return <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8 }}>
    {uploading ? <span role="status" style={{ color: 'var(--t-text-muted)', fontSize: 11 }}>Reading image attachments…</span> : null}
    {failed ? <>
      <RamsButton variant="ghost" disabled={uploading} onClick={onRetry}>Retry image upload</RamsButton>
      <RamsButton variant="ghost" disabled={uploading} onClick={onDiscard}>Remove failed attachment</RamsButton>
    </> : null}
  </div>;
}

export function ComposerSendStatus({ attachmentError, sendBuffer, active, uploads }: {
  attachmentError: string | null; sendBuffer: ComposerSendBuffer; active: boolean;
  uploads: { uploading: boolean; failed: boolean; retry: () => void; discard: () => void };
}) {
  return <>
    <ComposerSendBufferStatus attachmentError={attachmentError} undoArmed={active && sendBuffer.undoArmed}
      undoSequence={sendBuffer.undoSequence} queued={[]} onUndo={sendBuffer.stopOrUndo} onCancelQueued={sendBuffer.cancelQueued} />
    <ComposerUploadStatus uploading={uploads.uploading} failed={uploads.failed} onRetry={uploads.retry} onDiscard={uploads.discard} />
  </>;
}
