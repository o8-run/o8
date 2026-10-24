import type { PullRequestStackObservation } from '@/lib/github-client/pr-stack';

const readLabels: Record<PullRequestStackObservation['status'], string> = {
  ready: 'Native GitHub stack', none: 'No native stack', unauthorized: 'Stack access unavailable',
  unsupported_or_not_found: 'Stack preview unsupported or not found',
  unsupported_cross_fork: 'Cross-fork stack unsupported', deferred: 'Stack read deferred',
  offline: 'Stack offline', unavailable: 'Stack unavailable',
};

export function PrStackSummary({ observation, prNumber, onSelect, retained = false, repo }: {
  observation: PullRequestStackObservation; prNumber: number; onSelect?: (number: number) => void; retained?: boolean; repo?: string;
}) {
  const { snapshot, status, fetchedAt } = observation;
  const stale = observation.stale || retained;
  return <section aria-label="Pull request stack" style={{ minWidth: 0, borderTop: '1px solid var(--t-border)',
    paddingTop: 8, color: 'var(--t-text)', fontFamily: 'var(--font-sans-system)', fontSize: 11, fontWeight: 300 }}>
    <div>{readLabels[status]}{status === 'ready' && snapshot ? ` #${snapshot.number}` : ''}</div>
    {repo ? <a href={`https://github.com/${repo}/pull/${prNumber}`} target="_blank" rel="noreferrer" style={{ color: 'var(--t-text-muted)' }}>Open PR #{prNumber} on GitHub</a> : null}
    {snapshot ? <>
      {stale ? <div style={{ color: 'var(--t-text-muted)', marginTop: 4 }}>Last known stack #{snapshot.number}</div> : null}
      <div style={{ color: 'var(--t-text-muted)', marginTop: 4, overflowWrap: 'anywhere' }}>Trunk: {snapshot.trunk}</div>
      <div style={{ maxHeight: 180, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarWidth: 'none', marginTop: 4 }}>
        {snapshot.layers.map(layer => <button key={layer.number} type="button" data-stack-layer={layer.number}
          aria-current={layer.number === prNumber ? 'true' : undefined} disabled={!onSelect}
          onClick={() => onSelect?.(layer.number)} style={{ display: 'block', width: '100%', textAlign: 'left',
            border: 0, borderRadius: 6, paddingTop: 6, paddingRight: 6, paddingBottom: 6, paddingLeft: 6,
            background: layer.number === prNumber ? 'var(--t-hover)' : 'transparent', color: 'inherit',
            font: 'inherit', cursor: onSelect ? 'pointer' : 'default', overflowWrap: 'anywhere' }}>
          <span>#{layer.number} {layer.title} · {layer.state}</span>
          <span style={{ display: 'block', color: 'var(--t-text-muted)', fontSize: 10, marginTop: 3 }}>
            {layer.baseRef} <code title={layer.baseSha}>{layer.baseSha.slice(0, 7)}</code>
            {' → '}{layer.headRef} <code title={layer.headSha}>{layer.headSha.slice(0, 7)}</code>
          </span>
        </button>)}
      </div>
    </> : null}
    {observation.history?.length ? <details style={{ marginTop: 6 }}><summary>Native revision history · {observation.history.length}</summary>
      {observation.history.map((entry, index) => <div key={`${entry.revision}:${index}`} style={{ overflowWrap: 'anywhere', marginTop: 4 }}>
        {entry.trigger} · <time dateTime={entry.fetchedAt}>{entry.fetchedAt}</time> · {entry.snapshot ? `stack #${entry.snapshot.number}: ${entry.snapshot.layers.map(layer => `#${layer.number}`).join(' → ')}` : 'No native stack'} · <code title={entry.revision}>{entry.revision.slice(0, 12)}</code>
      </div>)}
    </details> : null}
    {fetchedAt ? <div style={{ color: 'var(--t-text-faint)', fontSize: 9.5, marginTop: 4 }}>
      Last confirmed read: <time dateTime={fetchedAt} title={fetchedAt}>{fetchedAt}</time>
    </div> : null}
  </section>;
}
