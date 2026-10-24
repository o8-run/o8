import type { ReactNode } from 'react';

/** The composer stays in normal flex flow and centers against the full pane. */
export function ComposerFrame({ composeFirst, children }: { composeFirst: boolean; children: ReactNode }) {
  return <div style={{ flexShrink: 0, width: '100%', maxWidth: composeFirst ? 900 : undefined,
    marginRight: 'auto', marginLeft: 'auto', transform: 'none' }}>{children}</div>;
}
