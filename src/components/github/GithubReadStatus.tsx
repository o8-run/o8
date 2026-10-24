'use client';
import { useEffect, useState } from 'react';

/** Show retained-data age wherever a shared read has failed or is stale. */
export function GithubReadStatus({ error, updatedAt }: { error?: unknown; updatedAt?: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!error) return;
    const catchUp = setTimeout(() => setNow(Date.now()), 0);
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => { clearTimeout(catchUp); clearInterval(timer); };
  }, [error]);
  if (!error) return null;
  const age = updatedAt && Number.isFinite(updatedAt) ? Math.max(0, Math.floor((now - updatedAt) / 1000)) : null;
  return <span role="status" style={{ display: 'block', fontSize: 11, fontWeight: 300, lineHeight: 1.35, color: 'var(--t-warning)' }}>
    GitHub refresh delayed. {age === null ? 'No saved state is available.' : `Showing saved state updated ${age < 60 ? `${age}s` : `${Math.floor(age / 60)}m`} ago.`}
  </span>;
}
