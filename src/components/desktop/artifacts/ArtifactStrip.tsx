'use client';

import { useMemo, useState } from 'react';
import { groupArtifacts, type ArtifactGroup, type ArtifactRef } from './types';
import { ArtifactLightbox } from './ArtifactLightbox';

interface ArtifactStripProps {
  artifacts: ArtifactRef[];
  /** Show the "no visual proof" line when empty (review/packet surfaces). */
  showEmpty?: boolean;
  /** Compact variant for the inline chat card. */
  dense?: boolean;
  /** Header label. Default emphasizes it's the AGENT's proof — the human verifies. */
  title?: string;
}

function Thumb({ artifact, tag, height, onOpen }: { artifact: ArtifactRef; tag?: string; height: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={artifact.label ?? tag ?? 'View'}
      style={{
        position: 'relative',
        flex: '1 1 0',
        minWidth: 0,
        height,
        borderRadius: 10,
        overflow: 'hidden',
        border: '1px solid var(--t-input-border)',
        background: 'var(--t-bg-card)',
        cursor: 'pointer',
        padding: 0,
        display: 'block',
      }}
    >
      {tag ? (
        <span style={{
          position: 'absolute', top: 6, left: 6, zIndex: 2,
          paddingTop: 2, paddingBottom: 2, paddingLeft: 7, paddingRight: 7,
          borderRadius: 6,
          background: tag === 'Bug' ? 'rgba(220, 38, 38, 0.92)' : tag === 'Fixed' ? 'rgba(22, 163, 74, 0.92)' : 'rgba(0,0,0,0.6)',
          color: '#fff', fontSize: 10, fontWeight: 600, letterSpacing: '0.02em',
          fontFamily: 'var(--font-sans-system)',
        }}>{tag}</span>
      ) : null}
      {/* eslint-disable-next-line @next/next/no-img-element -- artifact URL of unknown size, lazy-loaded thumbnail */}
      <img
        src={artifact.url}
        alt={artifact.label ?? tag ?? 'artifact'}
        loading="lazy"
        style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top', display: 'block' }}
      />
    </button>
  );
}

function GroupCard({ group, height, onOpen }: { group: ArtifactGroup; height: number; onOpen: (g: ArtifactGroup) => void }) {
  const open = () => onOpen(group);
  const label = group.single?.label ?? group.after?.label ?? group.before?.label ?? null;

  return (
    <div style={{ flex: '1 1 320px', minWidth: 220, maxWidth: 520 }}>
      <div style={{ display: 'flex', gap: 6 }}>
        {group.single ? (
          <Thumb artifact={group.single} height={height} onOpen={open} />
        ) : (
          <>
            {group.before ? <Thumb artifact={group.before} tag="Bug" height={height} onOpen={open} /> : null}
            {group.after ? <Thumb artifact={group.after} tag="Fixed" height={height} onOpen={open} /> : null}
          </>
        )}
      </div>
      {label ? (
        <div style={{
          marginTop: 5, color: 'var(--t-text-muted)', fontSize: 11,
          fontFamily: 'var(--font-sans-system)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{label}</div>
      ) : null}
    </div>
  );
}

export function ArtifactStrip({ artifacts, showEmpty = false, dense = false, title = "Agent's proof" }: ArtifactStripProps) {
  const groups = useMemo(() => groupArtifacts(artifacts), [artifacts]);
  const [active, setActive] = useState<ArtifactGroup | null>(null);
  const height = dense ? 76 : 112;

  if (groups.length === 0) {
    if (!showEmpty) return null;
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        paddingTop: 8, paddingBottom: 8, paddingLeft: 10, paddingRight: 10,
        borderRadius: 10, border: '1px dashed var(--t-divider)', background: 'var(--t-bg-subtle)',
        color: 'var(--t-text-faint)', fontSize: 11.5, fontFamily: 'var(--font-sans-system)',
      }}>
        <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0, opacity: 0.7 }}>
          <path d="M251.77,73a8,8,0,0,0-8.21.39L208,97.05V72a16,16,0,0,0-16-16H32A16,16,0,0,0,16,72V184a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V159l35.56,23.71A8,8,0,0,0,256,176V80A8,8,0,0,0,251.77,73ZM192,184H32V72H192V184Zm48-22.95-32-21.33V116.28l32-21.33Z" />
        </svg>
        No visual proof — backend change · check the diff
      </div>
    );
  }

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8,
        color: 'var(--t-text-muted)', fontSize: 10.5, fontWeight: 600,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        fontFamily: 'var(--font-sans-system)',
      }}>
        <svg width="13" height="13" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" style={{ opacity: 0.8 }}>
          <path d="M208,56H180.28L166.65,35.56A8,8,0,0,0,160,32H96a8,8,0,0,0-6.65,3.56L75.71,56H48A24,24,0,0,0,24,80V192a24,24,0,0,0,24,24H208a24,24,0,0,0,24-24V80A24,24,0,0,0,208,56Zm8,136a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V80a8,8,0,0,1,8-8H80a8,8,0,0,0,6.66-3.56L100.28,48h55.43l13.63,20.44A8,8,0,0,0,176,72h32a8,8,0,0,1,8,8ZM128,88a44,44,0,1,0,44,44A44.05,44.05,0,0,0,128,88Zm0,72a28,28,0,1,1,28-28A28,28,0,0,1,128,160Z" />
        </svg>
        <span>{title}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {groups.map((g) => (
          <GroupCard key={g.key} group={g} height={height} onOpen={setActive} />
        ))}
      </div>

      <ArtifactLightbox
        open={active !== null}
        before={active?.before ?? null}
        after={active?.after ?? null}
        single={active?.single ?? null}
        onClose={() => setActive(null)}
      />
    </div>
  );
}
