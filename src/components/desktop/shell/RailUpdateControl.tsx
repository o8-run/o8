'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { ChevronDown, Download, RefreshCw } from '../lucide-shims';
import { FloatingSurface } from '../FloatingSurface';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { checkAppUpdates, loadCachedReleaseNotes, refreshCliUpdateView, synchronizeConnectedClis, useUpdateHub } from '@/lib/app-update/update-hub-client';
import { toast } from '@/components/shared/ConfirmToastHost';
import type { ReleaseNotes } from '@/lib/app-update/release-notes';
import type { UpdateProgress } from '@/lib/app-update/client-restart';
import { updateRestartLabel } from '@/lib/app-update/update-card-view';
import { RailActionButton } from './RailActionButton';
import { ConnectedCliUpdateRows } from './ConnectedCliUpdateRows';

const button: CSSProperties = { border: 0, borderRadius: 7, minHeight: 32, paddingTop: 6, paddingBottom: 6, paddingLeft: 12, paddingRight: 12,
  font: 'inherit', fontSize: 12, color: 'var(--t-text)', background: 'var(--t-hover)', cursor: 'pointer' };

/** Anchors the panel beside the trigger and caps its height to the space above the anchor. */
export function panelPosition(rect: { right: number; bottom: number }, viewport = { width: window.innerWidth, height: window.innerHeight }) {
  const bottom = Math.max(12, viewport.height - rect.bottom);
  return {
    left: Math.max(12, Math.min(rect.right + 12, viewport.width - 356)),
    bottom,
    maxHeight: Math.max(160, Math.min(540, viewport.height - bottom - 12)),
  };
}

const stripPrefix = (text: string) => text.replace(/^(?:feat|fix|refactor|perf|chore|docs|style)(?:\([^)]*\))?:\s*/i, '').trim().toLowerCase();
export function sameNote(overview: string, entry: string | undefined) {
  return Boolean(entry) && stripPrefix(overview) === stripPrefix(entry!);
}

const megabytes = (bytes: number) => (bytes / 1_048_576).toFixed(bytes < 10 * 1_048_576 ? 1 : 0);
export function describeUpdateProgress(progress: UpdateProgress): { label: string; fraction: number | null } {
  if (progress.stage === 'installing') return { label: 'Installing o8…', fraction: 1 };
  if (progress.stage === 'restarting') return { label: 'Restarting o8…', fraction: 1 };
  if (progress.totalBytes && progress.totalBytes > 0) {
    const fraction = Math.min(1, progress.receivedBytes / progress.totalBytes);
    return { label: `Downloading ${megabytes(progress.receivedBytes)} of ${megabytes(progress.totalBytes)} MB (${Math.round(fraction * 100)}%)`, fraction };
  }
  return { label: progress.receivedBytes > 0 ? `Downloading ${megabytes(progress.receivedBytes)} MB…` : 'Starting download…', fraction: null };
}

function UpdateProgressBar({ progress, reducedMotion }: { progress: UpdateProgress; reducedMotion: boolean }) {
  const { label, fraction } = describeUpdateProgress(progress);
  return <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}
    aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)} style={{ display: 'grid', gap: 6 }}>
    <div style={{ fontSize: 11.5, color: 'var(--t-text-secondary)' }}>{label}</div>
    <div style={{ height: 4, borderRadius: 2, background: 'var(--t-hover)', overflow: 'hidden' }}>
      <div style={{ height: '100%', width: `${Math.round((fraction ?? 0.15) * 100)}%`, background: 'var(--t-accent)',
        transition: reducedMotion ? 'none' : 'width 160ms linear' }} />
    </div>
  </div>;
}

export function RailUpdateControl({ buttonStyle }: { buttonStyle: CSSProperties }) {
  const hub = useUpdateHub();
  const reducedMotion = useReducedMotion();
  const id = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressFocusOpen = useRef(false);
  const checkingRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [animateOpen, setAnimateOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState({ left: 0, bottom: 0, maxHeight: 540 });
  const [notes, setNotes] = useState<ReleaseNotes | null>(null);
  const [notesError, setNotesError] = useState(false);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [currentExpanded, setCurrentExpanded] = useState(false);
  const [allNotes, setAllNotes] = useState(false);
  const pending = hub.app.installing || hub.syncing;
  const status = hub.checkMessage || hub.app.message;
  const visibleTools = hub.tools.filter(tool => tool.status !== 'not-installed' && tool.runtimeId !== 'qoder');
  const available = Boolean(hub.app.version);
  // The filled icon means an o8 update. Connected-CLI updates alone show a small dot.
  const appReady = Boolean(hub.app.version);
  const actionTools = visibleTools.filter(tool => tool.status !== 'current' || hub.cliProgress[tool.runtimeId]);
  const currentTools = visibleTools.filter(tool => tool.status === 'current' && !hub.cliProgress[tool.runtimeId]);
  const rawError = hub.app.error;
  const error = rawError && /abort|timed?\s*out|failed to fetch|fetch is/i.test(rawError) ? 'Update checks couldn’t finish. Try again.' : rawError;
  const cancel = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const show = (animate = false) => {
    if (checkingRef.current) return;
    cancel();
    if (!open) setAnimateOpen(animate);
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setPosition(panelPosition(rect));
    setOpen(true);
  };
  const close = () => { cancel(); setOpen(false); setPinned(false); };
  const leave = () => { cancel(); if (!pinned && !pending) timer.current = setTimeout(() => setOpen(false), 180); };
  useEffect(() => {
    let active = true;
    setNotes(null);
    setNotesError(false);
    setAllNotes(false);
    void loadCachedReleaseNotes(hub.app.version ?? 'latest').then(value => { if (active) setNotes(value); })
      .catch(() => { if (active) setNotesError(true); });
    return () => { active = false; };
  }, [hub.app.version]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node) && !pending) close(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') {
      event.preventDefault(); close(); suppressFocusOpen.current = true; trigger.current?.focus(); suppressFocusOpen.current = false;
    } };
    const reposition = () => { const rect = trigger.current?.getBoundingClientRect(); if (rect) setPosition(panelPosition(rect)); };
    document.addEventListener('mousedown', outside); document.addEventListener('keydown', key); window.addEventListener('resize', reposition);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', key); window.removeEventListener('resize', reposition); };
  // Closing timers are transient; the current pinned/pending state governs dismissal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pending]);
  useEffect(() => {
    if (open && pinned) panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open, pinned]);
  const check = async (dismiss = false) => {
    if (checkingRef.current || pending) return;
    checkingRef.current = true;
    if (dismiss) close();
    toast('Checking o8…', 'info');
    try {
      const result = await checkAppUpdates();
      toast(result.incomplete ? 'The o8 update check could not finish. Try again.' : result.hasUpdates ? 'o8 update is ready.' : 'o8 is up to date.', result.incomplete ? 'error' : result.hasUpdates ? 'info' : 'success');
    } catch { toast('Update checks could not finish. Try again.', 'error'); }
    finally { checkingRef.current = false; }
  };
  return <>
    <RailActionButton ref={trigger} type="button" aria-label="Updates" tooltipLabel={null} aria-haspopup="dialog"
      aria-busy={hub.checkingAll || pending}
      aria-expanded={open} aria-controls={open ? id : undefined} onMouseEnter={() => show(true)} onMouseLeave={leave} onFocus={() => { if (!suppressFocusOpen.current) show(); }}
      onBlur={leave} disabled={pending || hub.checkingAll} onClick={() => { show(); setPinned(true); void check(); }}
      onKeyDown={event => { if (event.key === 'ArrowUp') { event.preventDefault(); show(); setPinned(true); } }}
      aria-description="Click to check for updates and open the update panel."
      style={{ ...buttonStyle, flexShrink: 0, cursor: pending || hub.checkingAll ? 'wait' : 'pointer' }}>
      <span data-update-ready={appReady || undefined} data-cli-update-ready={(!appReady && available) || undefined} aria-hidden="true" style={{ position: 'relative', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: '50%', color: appReady ? '#fff' : 'var(--t-text-muted)', background: appReady ? '#3b82f6' : 'transparent',
        transition: reducedMotion ? 'none' : 'background-color 160ms ease-out, color 160ms ease-out' }}><Download size={19} strokeWidth={1.8} />
        {!appReady && available ? <span style={{ position: 'absolute', top: 5, right: 5, width: 6, height: 6, borderRadius: '50%', background: '#3b82f6' }} /> : null}</span>
    </RailActionButton>
    {open ? createPortal(<motion.div initial={reducedMotion || !animateOpen ? false : { x: -5, y: 3 }} animate={{ x: 0, y: 0 }}
      transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }} style={{ position: 'fixed', ...position, width: 'min(340px, calc(100vw - 24px))', zIndex: 220 }}>
      <FloatingSurface ref={panel} id={id} role="dialog" aria-label="Updates and release notes" aria-modal="false"
      onMouseEnter={cancel} onMouseLeave={leave} onFocus={cancel}
      // Reserve the bounded frame before discovery; rows must not lift the clicked header.
      contentStyle={{ height: position.maxHeight, overflowY: 'auto' }}>
      <div style={{ padding: 16, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div><div style={{ fontSize: 14, fontWeight: 500 }}>{available ? 'Updates ready' : 'Updates'}</div>
            {hub.app.version || hub.app.currentVersion ? <div style={{ marginTop: 3, fontSize: 11, color: 'var(--t-text-muted)' }}>
              {hub.app.version && hub.app.currentVersion ? `o8 ${hub.app.currentVersion} → ${hub.app.version}`
                : hub.app.version ? `o8 ${hub.app.version} available` : `o8 ${hub.app.currentVersion} installed`}</div> : null}</div>
          <button type="button" aria-label="Refresh updates" disabled={hub.checking || hub.checkingAll || pending} onClick={() => { void check(); }} style={{ ...button, width: 32, padding: 0 }}><RefreshCw size={14} strokeWidth={1.7} /></button>
        </div>
        {(error || status) ? <div role={error ? 'alert' : 'status'} style={{ fontSize: 11.5, lineHeight: 1.5, color: error ? 'var(--t-danger)' : 'var(--t-text-secondary)' }}>{error || status}</div> : null}
        {hub.app.progress ? <UpdateProgressBar progress={hub.app.progress} reducedMotion={Boolean(reducedMotion)} /> : null}
        {hub.app.blockers ? <div style={{ display: 'grid', gap: 6, fontSize: 11.5, lineHeight: 1.5, color: 'var(--t-text-secondary)' }}>
          {hub.app.blockers.live.length ? <div>
            <div>Work to check before restarting:</div>
            <ul style={{ margin: 0, paddingLeft: 16 }}>{hub.app.blockers.live.slice(0, 6).map(item => <li key={item}>{item}</li>)}</ul>
            {hub.app.blockers.live.length > 6 ? <div style={{ color: 'var(--t-text-muted)' }}>and {hub.app.blockers.live.length - 6} more</div> : null}
          </div> : null}
          {hub.app.blockers.parked.length ? <div>
            <div>{hub.app.blockers.live.length ? 'Also waiting, and kept across a restart:' : 'These tasks are waiting and keep their state across a restart:'}</div>
            <ul style={{ margin: 0, paddingLeft: 16 }}>{hub.app.blockers.parked.slice(0, 6).map(item => <li key={item}>{item}</li>)}</ul>
            {hub.app.blockers.parked.length > 6 ? <div style={{ color: 'var(--t-text-muted)' }}>and {hub.app.blockers.parked.length - 6} more</div> : null}
          </div> : null}
          <button type="button" disabled={pending}
            onClick={() => { setPinned(true); window.dispatchEvent(new Event('o8:restart-app-update')); }}
            style={{ ...button, justifySelf: 'start', minHeight: 30, color: 'var(--t-accent-contrast, #fff)', background: 'var(--t-accent)' }}>
            {updateRestartLabel(hub.app.blockers)}
          </button>
        </div> : null}
        {hub.app.version && !hub.app.blockers ? <div style={{ display: 'grid', justifyItems: 'start', gap: 6 }}>
          {hub.app.version && !hub.app.blockers ? <button type="button" disabled={pending || hub.checkingAll}
            onClick={() => { setPinned(true); window.dispatchEvent(new Event('o8:install-app-update')); }}
            style={{ ...button, minHeight: 30, color: 'var(--t-accent-contrast, #fff)', background: 'var(--t-accent)', opacity: pending ? 0.65 : 1 }}>
            {hub.app.installing ? 'Updating o8…' : hub.app.packageManager ? 'Release page' : hub.app.downloadOnly ? 'Download o8' : 'Update o8'}
          </button> : null}
          <span style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>Updates o8 only. Other tools stay under Tools.</span>
        </div> : null}
        {/* Reserve discovery space even while collapsed so visible notes never move. */}
        <section style={{ borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 10, height: 280, display: 'flex', flexDirection: 'column' }}>
          <button type="button" aria-label="Tools updates" aria-expanded={toolsExpanded} aria-controls={`${id}-tools`}
            onClick={() => { setToolsExpanded(value => !value); if (!toolsExpanded) {
              if (!hub.checkedAt) setCurrentExpanded(true);
              if (!hub.checking) void refreshCliUpdateView(true);
            } }}
            style={{ ...button, flexShrink: 0, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 0, paddingRight: 0, background: 'transparent' }}>
            <span>Tools{visibleTools.some(tool => tool.status === 'update-available') ? ' · updates available' : ''}</span><ChevronDown size={13} style={{ transform: toolsExpanded ? 'rotate(180deg)' : undefined }} />
          </button>
          {toolsExpanded ? <div id={`${id}-tools`} style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'grid', alignContent: 'start', gap: 12, paddingTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ flex: 1, fontSize: 10.5, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>Update each tool explicitly. Running sessions stay protected.</span>
              <button type="button" aria-label={hub.cliError ? 'Retry tool discovery' : 'Check tool versions'} disabled={hub.checking || pending} onClick={() => { void refreshCliUpdateView(true); }} style={{ ...button, paddingLeft: 6, paddingRight: 6 }}>{hub.cliError ? 'Retry' : <RefreshCw size={12} />}</button></div>
            <div style={{ minHeight: 15, fontSize: 11, fontWeight: 300, lineHeight: 1.35, color: 'var(--t-text-muted)' }}>
              {hub.checking ? <div role="progressbar" aria-label="Tool discovery" aria-valuemin={0}
                aria-valuemax={hub.cliDiscovery?.total} aria-valuenow={hub.cliDiscovery?.completed}>
                {hub.cliDiscovery ? `Checking tools… ${hub.cliDiscovery.completed} of ${hub.cliDiscovery.total} checked` : 'Checking installed tools…'}
              </div> : hub.checkedAt ? <span role="status">Tool discovery complete.</span> : null}
            </div>
            {actionTools.length ? <ConnectedCliUpdateRows tools={actionTools} busy={hub.cliBusy} progress={hub.cliProgress} checking={hub.checking} checked={hub.cliDiscoveryChecked} disabled={pending || hub.checkingAll || hub.checking} onUpdate={runtime => { setPinned(true); void synchronizeConnectedClis(runtime).catch(() => {}); }} /> : null}
            {currentTools.length ? <div>
              <button type="button" aria-expanded={currentExpanded} aria-controls={`${id}-current`} onClick={() => setCurrentExpanded(value => !value)} style={{ ...button, minHeight: 26, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, background: 'transparent', color: 'var(--t-text-muted)', fontSize: 11 }}><span>Current CLIs · {currentTools.length}</span><ChevronDown size={13} style={{ transform: currentExpanded ? 'rotate(180deg)' : undefined }} /></button>
              {currentExpanded ? <div id={`${id}-current`} style={{ paddingTop: 9 }}><ConnectedCliUpdateRows tools={currentTools} busy={hub.cliBusy} progress={hub.cliProgress} checking={hub.checking} checked={hub.cliDiscoveryChecked} /></div> : null}
            </div> : null}
            {hub.cliError || hub.cliMessage ? <div role={hub.cliError ? 'alert' : 'status'} style={{ fontSize: 11, lineHeight: 1.5, color: hub.cliError ? 'var(--t-danger)' : 'var(--t-text-secondary)' }}>{hub.cliError || hub.cliMessage}</div> : null}
            {!visibleTools.length && !hub.checking && !hub.cliError ? <span role="status" style={{ fontSize: 11, color: 'var(--t-text-muted)' }}>No supported CLI installation was found.</span> : null}
          </div> : null}
        </section>
        <section style={{ borderTop: '1px solid var(--t-divider-subtle)', paddingTop: 14 }}>
          <div style={{ fontSize: 12.5, fontWeight: 500 }}>{notes?.source === 'changelog' ? 'Latest published changes' : 'What’s changed'}</div>
          {notes?.source === 'changelog' && notes.publishedAt ? <div style={{ fontSize: 10.5, marginTop: 4, color: 'var(--t-text-muted)' }}>Published {notes.publishedAt.slice(0, 10)}</div> : null}
          {notes?.overview && notes.entries.length && !sameNote(notes.overview, notes.entries[0]?.text) ? <p style={{ marginTop: 10, marginBottom: 10, fontSize: 12, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>{notes.overview}</p> : null}
          {notes?.entries.length ? <ul style={{ marginTop: 10, marginBottom: 10, paddingLeft: 17, display: 'grid', gap: 9, fontSize: 12, lineHeight: 1.6, color: 'var(--t-text-secondary)' }}>
            {notes.entries.slice(0, allNotes ? undefined : 5).map((entry, index) => <li key={index}>
              {entry.text.replace(/^(?:feat|fix|refactor|perf|chore|docs|style)(?:\([^)]*\))?:\s*/i, '')}
            </li>)}
          </ul> : <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--t-text-muted)' }}>{notesError ? 'Published notes are unavailable right now. Open the release history for details.' : notes ? notes.summary : 'Loading published notes…'}</p>}
          {notes && notes.entries.length > 5 ? <button type="button" aria-expanded={allNotes} onClick={() => setAllNotes(value => !value)}
            style={{ ...button, minHeight: 24, padding: 0, background: 'transparent', color: 'var(--t-text-secondary)', fontSize: 11 }}>
            {allNotes ? 'Show fewer changes' : `${notes.entries.length - 5} more changes`}
          </button> : null}
          <div><button type="button" onClick={() => openExternalUrl(notes?.releaseUrl ?? 'https://github.com/hurttlocker/o8-releases/releases')} style={{ ...button, minHeight: 24, paddingLeft: 0, paddingRight: 0, background: 'transparent', color: 'var(--t-text-muted)', fontSize: 10.5, textDecoration: 'underline', textUnderlineOffset: 3 }}>View release on GitHub</button></div>
        </section>
      </div>
    </FloatingSurface></motion.div>, document.body) : null}
  </>;
}
