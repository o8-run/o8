'use client';

import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  APP_FONT_STACK,
  RAMS_ACCENT,
  RAMS_INK_QUIET,
  RamsButton,
  SettingsSegmented,
} from './shared';
import { SettingsGroup } from './grouped';
import { collectClientDiagnostics } from '@/lib/feedback/report-client';
import { REPORT_DATA_SHARING_OFF_ERROR, REPORT_DATA_SHARING_OFF_MESSAGE } from '@/lib/feedback/data-sharing';
import { useReportDataSharing } from '@/lib/feedback/report-data-sharing-client';

type ReportCategory = 'bug' | 'request';
type ReportState = 'idle' | 'sending' | 'sent' | 'error';

interface ReportResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  /** Short id the fix reaches back through — a commit trailer records it in the fix manifest. */
  reportId?: string;
}

const MAX_MESSAGE_LENGTH = 4000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface AttachedImage {
  dataUrl: string;
  name: string;
  size: number;
}

export function ReportIssueSection() {
  const [category, setCategory] = useState<ReportCategory>('bug');
  const [message, setMessage] = useState('');
  const [image, setImage] = useState<AttachedImage | null>(null);
  const [state, setState] = useState<ReportState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    status: dataSharingStatus,
    error: dataSharingError,
    enabling: dataSharingEnabling,
    enabled: dataSharingEnabled,
    check: checkDataSharing,
    enable: enableDataSharing,
    markDisabled: markDataSharingDisabled,
  } = useReportDataSharing();

  const trimmedMessage = message.trim();
  const canSend = dataSharingEnabled && trimmedMessage.length > 0 && state !== 'sending';
  const countLabel = useMemo(() => `${message.length}/${MAX_MESSAGE_LENGTH}`, [message.length]);

  const attachImage = useCallback((file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setState('error');
      setError('Attachment must be an image (PNG, JPEG, GIF, or WebP).');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setState('error');
      setError('Screenshot is too large (max 8 MB). Try a smaller capture.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) return;
      setImage({ dataUrl, name: file.name || 'screenshot.png', size: file.size });
      setState((prev) => (prev === 'sent' || prev === 'error' ? 'idle' : prev));
      setError(null);
    };
    reader.onerror = () => {
      setState('error');
      setError('Could not read that image.');
    };
    reader.readAsDataURL(file);
  }, []);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          attachImage(file);
          return;
        }
      }
    }
  }, [attachImage]);

  // Intercept file drops so the webview doesn't insert the file's local PATH
  // as text (the original "it just posts the path" bug) — read the bytes instead.
  const handleDrop = useCallback((event: React.DragEvent) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) {
      event.preventDefault();
      attachImage(file);
    }
  }, [attachImage]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
  }, []);

  const sendReport = useCallback(async () => {
    if (!trimmedMessage) {
      setState('error');
      setError('Add a short report before sending.');
      return;
    }
    if (!await checkDataSharing(false)) return;

    setState('sending');
    setError(null);

    const route = typeof window !== 'undefined'
      ? `${window.location.pathname}${window.location.hash}`
      : 'unknown';
    const userAgent = typeof navigator !== 'undefined' && navigator.userAgent
      ? navigator.userAgent
      : 'unknown';

    try {
      // Diagnostics ride along by default (Q ruling 2026-07-15) — geometry,
      // zoom, the console-error ring buffer, plus the server-side crash
      // digest. Best-effort: a diagnostics failure never blocks the report.
      const client = await collectClientDiagnostics().catch(() => null);
      const response = await fetch('/api/feedback/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category,
          message: trimmedMessage,
          route,
          userAgent,
          image: image ? { dataUrl: image.dataUrl, name: image.name } : undefined,
          includeDiagnostics: true,
          client: client ?? undefined,
        }),
      });
      const body = await response.json().catch(() => null) as ReportResponse | null;
      if (!response.ok || !body?.ok) {
        if (body?.error === REPORT_DATA_SHARING_OFF_ERROR) markDataSharingDisabled();
        setState('error');
        setError(body?.message || body?.error || `Report failed with HTTP ${response.status}.`);
        return;
      }
      setState('sent');
      setReportId(typeof body.reportId === 'string' ? body.reportId : null);
      setMessage('');
      setImage(null);
    } catch (sendError) {
      setState('error');
      setError(sendError instanceof Error ? sendError.message : 'Report failed.');
    }
  }, [category, checkDataSharing, image, markDataSharingDisabled, trimmedMessage]);

  return (
    <section style={{ marginTop: 28, marginBottom: 4 }}>
      <SettingsGroup
        header="Report an issue"
        footnote="One-way — we read every report but won't reply here."
      >
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          maxWidth: 680,
          paddingTop: 14,
          paddingBottom: 14,
          paddingLeft: 14,
          paddingRight: 14,
        }}>
          {dataSharingStatus === 'checking' ? (
            <div style={{ color: RAMS_INK_QUIET, fontFamily: APP_FONT_STACK, fontSize: 13, fontWeight: 300, lineHeight: 1.55 }}>
              Checking data-sharing settings…
            </div>
          ) : !dataSharingEnabled ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
              <div style={{ color: 'var(--t-text)', fontFamily: APP_FONT_STACK, fontSize: 13, fontWeight: 300, lineHeight: 1.55 }}>
                {REPORT_DATA_SHARING_OFF_MESSAGE}
              </div>
              {dataSharingError ? <StatusLine tone="error">{dataSharingError}</StatusLine> : null}
              <RamsButton
                type="button"
                onClick={() => { void enableDataSharing(); }}
                disabled={dataSharingEnabling}
                busy={dataSharingEnabling}
              >
                {dataSharingEnabling ? 'Enabling' : 'Enable sharing'}
              </RamsButton>
            </div>
          ) : (
            <>
          <SettingsSegmented
            value={category}
            onChange={(v) => {
              setCategory(v as ReportCategory);
              if (state === 'sent') setState('idle');
            }}
            options={[
              { value: 'bug', label: 'Bug' },
              { value: 'request', label: 'Request' },
            ]}
          />

          <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{
              fontFamily: APP_FONT_STACK,
              fontSize: 10,
              fontWeight: 400,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: RAMS_INK_QUIET,
            }}>
              Message
            </span>
            <textarea
              value={message}
              maxLength={MAX_MESSAGE_LENGTH}
              placeholder="What broke, or what should o8 support?"
              onChange={(event) => {
                setMessage(event.target.value);
                if (state === 'sent' || state === 'error') {
                  setState('idle');
                  setError(null);
                }
              }}
              rows={6}
              style={textareaStyle}
              onPaste={handlePaste}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onFocus={(event) => {
                event.currentTarget.style.borderColor = RAMS_ACCENT;
              }}
              onBlur={(event) => {
                event.currentTarget.style.borderColor = 'var(--t-panel-border)';
              }}
            />
          </label>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            style={{ display: 'none' }}
            onChange={(event) => {
              attachImage(event.target.files?.[0]);
              event.target.value = '';
            }}
          />

          {image ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              paddingTop: 8,
              paddingRight: 10,
              paddingBottom: 8,
              paddingLeft: 10,
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: 'var(--t-divider-subtle)',
              borderRadius: 8,
              background: 'var(--t-input-bg)',
            }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={image.dataUrl}
                alt="attachment preview"
                style={{
                  height: 48,
                  width: 64,
                  objectFit: 'cover',
                  borderRadius: 6,
                  borderWidth: 1,
                  borderStyle: 'solid',
                  borderColor: 'var(--t-divider-subtle)',
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontFamily: APP_FONT_STACK,
                  fontSize: 13,
                  fontWeight: 300,
                  color: 'var(--t-text)',
                  letterSpacing: '-0.005em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {image.name}
                </div>
                <div style={{
                  fontFamily: APP_FONT_STACK,
                  fontSize: 10,
                  fontWeight: 300,
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  color: RAMS_INK_QUIET,
                }}>
                  {formatBytes(image.size)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setImage(null)}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--t-text-muted)',
                  cursor: 'pointer',
                  fontFamily: APP_FONT_STACK,
                  fontSize: 12,
                  fontWeight: 400,
                  letterSpacing: '-0.01em',
                  padding: 6,
                  flexShrink: 0,
                }}
              >
                Remove
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 32,
                paddingTop: 10,
                paddingBottom: 10,
                paddingLeft: 14,
                paddingRight: 14,
                borderWidth: 1,
                borderStyle: 'dashed',
                borderColor: 'var(--t-panel-border)',
                borderRadius: 8,
                background: 'transparent',
                color: 'var(--t-text-muted)',
                cursor: 'pointer',
                fontFamily: APP_FONT_STACK,
                fontSize: 12,
                fontWeight: 400,
                letterSpacing: '-0.01em',
              }}
            >
              Attach a screenshot — click, paste, or drop an image
            </button>
          )}

          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}>
            <div style={{
              fontFamily: APP_FONT_STACK,
              fontSize: 10,
              fontWeight: 300,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: RAMS_INK_QUIET,
            }}>
              {countLabel}
            </div>
            <RamsButton
              type="button"
              onClick={() => { void sendReport(); }}
              disabled={!canSend}
              busy={state === 'sending'}
            >
              {state === 'sending' ? 'Sending' : 'Send'}
            </RamsButton>
          </div>

          {state === 'sent' ? (
            <StatusLine tone="success">
              {reportId
                ? `Sent — report ${reportId}. When a fix ships, o8 tells you here.`
                : 'Sent — thanks. We’ll pick it up from the report channel.'}
            </StatusLine>
          ) : null}

          {state === 'error' && error ? (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 14,
              flexWrap: 'wrap',
            }}>
              <StatusLine tone="error">{error}</StatusLine>
              <RamsButton
                type="button"
                variant="ghost"
                onClick={() => { void sendReport(); }}
                disabled={!trimmedMessage}
              >
                Retry
              </RamsButton>
            </div>
          ) : null}
            </>
          )}
        </div>
      </SettingsGroup>
    </section>
  );
}

function StatusLine({ children, tone }: { children: React.ReactNode; tone: 'success' | 'error' }) {
  return (
    <div style={{
      fontFamily: APP_FONT_STACK,
      fontSize: 13,
      fontWeight: 300,
      letterSpacing: '-0.005em',
      lineHeight: 1.45,
      color: tone === 'success' ? 'var(--t-success, #16a34a)' : 'var(--t-danger, #ef4444)',
    }}>
      {children}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const textareaStyle: CSSProperties = {
  width: '100%',
  minHeight: 132,
  boxSizing: 'border-box',
  resize: 'vertical',
  paddingTop: 12,
  paddingRight: 12,
  paddingBottom: 12,
  paddingLeft: 12,
  borderRadius: 8,
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'var(--t-panel-border)',
  background: 'var(--t-input-bg)',
  color: 'var(--t-text)',
  outline: 'none',
  fontFamily: APP_FONT_STACK,
  fontSize: 13.5,
  fontWeight: 300,
  letterSpacing: '-0.005em',
  lineHeight: 1.5,
};
