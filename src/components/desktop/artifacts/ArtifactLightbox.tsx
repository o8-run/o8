'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import type { ArtifactRef } from './types';

interface ArtifactLightboxProps {
  /** When set, the lightbox is open showing this group. */
  open: boolean;
  before: ArtifactRef | null;
  after: ArtifactRef | null;
  single: ArtifactRef | null;
  onClose: () => void;
}

// Portal overlay — hardcoded dark chrome (NOT themed tokens). A portal escapes
// the panel's theme scope, and var(--t-text) is dark-on-dark in light mode →
// invisible. See [[feedback_overlay_popover_theming]].
const SCRIM = 'rgba(8, 10, 14, 0.82)';
const FRAME_BORDER = 'rgba(255, 255, 255, 0.14)';
const LABEL_BG = 'rgba(0, 0, 0, 0.55)';
const LABEL_INK = 'rgba(255, 255, 255, 0.92)';
const CLOSE_INK = 'rgba(255, 255, 255, 0.78)';

function Frame({ artifact, tag }: { artifact: ArtifactRef; tag?: string }) {
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', maxWidth: '100%', maxHeight: '100%' }}>
      {tag ? (
        <div style={{
          position: 'absolute', top: 10, left: 10, zIndex: 2,
          paddingTop: 3, paddingBottom: 3, paddingLeft: 9, paddingRight: 9,
          borderRadius: 7, background: LABEL_BG, color: LABEL_INK,
          fontSize: 11, fontWeight: 600, letterSpacing: '0.02em',
          fontFamily: 'var(--font-sans-system)',
        }}>{tag}</div>
      ) : null}
      {/* eslint-disable-next-line @next/next/no-img-element -- artifact URL of unknown size, shown at natural size */}
      <img
        src={artifact.url}
        alt={artifact.label ?? tag ?? 'artifact'}
        style={{ maxWidth: '100%', maxHeight: '78vh', objectFit: 'contain', borderRadius: 12, border: `1px solid ${FRAME_BORDER}`, display: 'block' }}
      />
      {artifact.label ? (
        <div style={{ marginTop: 10, color: LABEL_INK, fontSize: 12, fontFamily: 'var(--font-sans-system)', textAlign: 'center' }}>
          {artifact.label}
        </div>
      ) : null}
    </div>
  );
}

export function ArtifactLightbox({ open, before, after, single, onClose }: ArtifactLightboxProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (typeof document === 'undefined') return null;

  const pair = before || after;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: SCRIM,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 40,
            backdropFilter: 'blur(3px)',
            WebkitBackdropFilter: 'blur(3px)',
          } as React.CSSProperties}
        >
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              position: 'fixed', top: 18, right: 20, zIndex: 2,
              width: 34, height: 34, borderRadius: 999,
              border: `1px solid ${FRAME_BORDER}`, background: LABEL_BG, color: CLOSE_INK,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0,
            }}
          >
            <svg width="15" height="15" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
              <path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z" />
            </svg>
          </button>

          <motion.div
            initial={{ scale: 0.97 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, maxWidth: '100%', maxHeight: '100%' }}
          >
            {single ? (
              <Frame artifact={single} />
            ) : pair ? (
              <>
                {before ? <Frame artifact={before} tag="Bug" /> : null}
                {after ? <Frame artifact={after} tag="Fixed" /> : null}
              </>
            ) : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
