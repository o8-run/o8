'use client';

import { useTranscriptVisualizations } from '@/components/desktop/visualizations/useTranscriptVisualizations';
import { useTheme } from './ThemeContext';

export function ThreadVisualizations({ repoPath, threadId, length }: {
  repoPath: string | null; threadId: string; length: number;
}) {
  const { colors } = useTheme();
  const references = useTranscriptVisualizations({ repoPath, threadId, active: true, length });
  return references.length ? <div aria-label="Saved visualizations" style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
    {references.map(reference => <div key={reference.rootId ?? reference.id} style={{ display: 'flex', alignItems: 'center', gap: 12,
      borderRadius: 7, background: colors.cardBg, paddingLeft: 12, paddingRight: 12 }}>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', fontSize: 13.5, fontWeight: 300, color: colors.text }}>{reference.title}</span>
      <a href={`/mobile/visualizations/${reference.id}`} aria-label={`Open ${reference.title}`} style={{ display: 'flex', alignItems: 'center',
        minHeight: 44, color: colors.textSecondary, fontSize: 12, fontWeight: 300 }}>Open</a>
    </div>)}
  </div> : null;
}
