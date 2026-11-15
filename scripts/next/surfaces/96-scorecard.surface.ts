import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export default async function register({ repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--scorecard')) return {};
  const { getSqlite } = await import('../../../src/lib/db');
  const { GET } = await import('../../../src/app/api/panel/analytics/route');
  const db = getSqlite();
  const now = Date.now();
  const old = now - 20 * 86400000;
  const findings = ['bug', 'rule_violation', 'note'].map((severity, index) => ({
    file: `fixture-${index}.ts`, description: `Saved finding ${index}`, severity, resolution: 'deferred',
  }));
  for (const [id, arrived] of [['scorecard-clean', now - 86400000], ['scorecard-repair', old]] as const) {
    db.prepare(`INSERT OR REPLACE INTO lanes (id,label,repo_path,branch,base_branch,runtime,packet_id,status,ownership,created_at,updated_at)
      VALUES (?,?,?,?,'main','codex',?,'reviewing','managed',?,?)`)
      .run(id, `Saved change ${id}`, repo, id, id, new Date(arrived).toISOString(), new Date(now).toISOString());
    const repaired = id === 'scorecard-repair';
    const audit = (repaired ? [false, true] : [true]).map((approved, index) => ({
      type: 'orchestrator_review', actor: 'orchestrator', approved, reviewedHeadSha: 'a'.repeat(40), timestamp: arrived + (index + 1) * 60000,
      findings: repaired ? findings.map((finding, n) => ({ ...finding, resolution: approved ? ['fixed', 'accepted', 'deferred'][n] : 'deferred' })) : [],
    }));
    db.prepare(`INSERT OR REPLACE INTO approvals
      (id,source,runtime,agent,session_key,title,description,summary,tool_name,args_json,packet_id,lane_id,risk,status,created_at,updated_at,audit_json,fingerprint)
      VALUES (?,'runtime','codex','reviewer',?,'Review','','','orchestrator_review',?,?,?,'low','approved',?,?,?,?)`)
      .run(id, id, JSON.stringify({ packetId: id, reviewTurnOutcome: 'completed' }), id, id, arrived, now, JSON.stringify(audit), id);
    db.prepare('INSERT OR REPLACE INTO lane_events (id,lane_id,verb,actor,payload_json,timestamp) VALUES (?,?,?,\'system\',?,?)')
      .run(id, id, 'merge_dispatch_succeeded', JSON.stringify({ reviewedHeadSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40) }), new Date(arrived + 180000).toISOString());
  }
  return { routes: { 'GET /api/panel/analytics': GET } };
}
