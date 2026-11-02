// Owned Activity fixture. Real dossier/receipt/directive routes, isolated DB.
// The host starts no orchestrator tick or worker, so queued tasks never launch.
import type { SurfaceContext, SurfaceRoutes } from '../../../../../scripts/next/surface-routes';
import { NextRequest } from 'next/server';
import { getSqlite } from '../../../../../src/lib/db';
import { listProblemDossiers } from '../../../../../src/lib/problems/dossiers';


export async function install(context: SurfaceContext): Promise<SurfaceRoutes> {
  const { repo } = context;
  const { listRecordedInboxItems } = await import('../../../../../src/lib/supervisor/inbox');
  listRecordedInboxItems();
  listProblemDossiers({ includeSuppressed: true });
  const db = getSqlite();
  const { addRepo } = await import('../../../../../src/lib/repos/registry');
  const { createProject, addRepoToProject } = await import('../../../../../src/lib/projects/store');
  const registered = await addRepo(repo);
  const project = createProject({ name: 'Activity decisions fixture', slug: 'activity-decisions-fixture', description: null });
  addRepoToProject(project.id, registered.id, null, 'manual');
  const projectId = project.id;
  const contract = JSON.stringify({ kind: 'supervisor_incident_absence', sourceKind: 'verification_failed', baseline: { occurrenceCount: 3, distinctAttempts: 3, recordedAt: '2026-10-29T10:00:00Z' }, exposureDenominator: 'distinct_reviewed_releases', requiredComparableExposures: 3 });
  const date = '2026-10-29T10:00:00.000Z';
  for (const [id, status, pain] of [
    ['candidate', 'candidate', 'Verification fails after three independent packet attempts'],
    ['provisional', 'provisionally_resolved', 'Prove the released fix with comparable clean exposures'],
    ['closed', 'verified_closed', 'Closed problem retains its evidence and history'],
    ['suppressed', 'suppressed', 'Temporarily suppress repeated dependency noise'],
    ['foreign', 'candidate', 'Another repository has its own recurring problem'],
  ]) {
    db.prepare(`INSERT INTO problem_dossiers (id,fingerprint,project_id,repo_path,pain_statement,first_observed_at,last_observed_at,occurrence_count,impact_band,evidence_confidence,status,closure_contract_json,cooldown_until,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,3,'moderate','high',?,?,?, ?,?)`).run(id, id, projectId, id === 'foreign' ? `${repo}-other` : repo, pain, date, date, status, contract, status === 'suppressed' ? '2099-01-01T00:00:00Z' : null, date, date);
    db.prepare(`INSERT INTO problem_events (id,dossier_id,event_type,actor,note,from_status,to_status,at) VALUES (?,?,'candidate_promoted','system','Three independent packets share this failure.',NULL,?,?)`).run(`event-${id}`, id, status, date);
    db.prepare(`INSERT INTO problem_evidence (id,dossier_id,source_type,source_id,source_kind,packet_id,observed_at) VALUES (?,?,'supervisor_inbox',?,'verification_failed','fixture-source-packet',?)`).run(`evidence-${id}`, id, `incident-${id}`, date);
  }
  db.prepare(`INSERT INTO problem_remedies (id,dossier_id,sequence,status,mission_id,lane_id,approval_id,release_ref,created_at,updated_at) VALUES ('remedy-preview','candidate',1,'released','fixture-mission','fixture-lane','fixture-approval','fixture-release',?,?)`).run(date, date);
  const route = await import('../../../../../src/app/api/panel/problem-dossiers/route');
  let mode = 'ready';
  let slowed = false;
  const bodies: unknown[] = [];
  const proposalFixture = await (await import('./proposal_fixture')).installProposals(context);
  return { priority: -1, admit: () => 200, routes: {
    ...proposalFixture.routes,
    'GET /api/panel/problem-dossiers': async request => mode === 'error'
      ? Response.json({ error: 'Owned dossier read unavailable' }, { status: 503 }) : route.GET(request),
    'POST /api/panel/problem-dossiers': async request => {
      bodies.push(await request.clone().json());
      if (mode === 'unknown') return Response.json({ outcomeUnknown: true, error: 'Inspect the persisted dossier decision before another action.' }, { status: 409 });
      if (mode === 'denied') return Response.json({ ok: false, error: 'Owned decision refused' }, { status: 403 });
      if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 200));
      const result = await route.POST(request);
      if (mode === 'slow' && !slowed && result.ok) { slowed = true; return Response.json({ ok: true, inProgress: true }, { status: 202 }); }
      return result;
    },
    'GET /api/activity-dossiers-fixture': async (request: NextRequest) => {
      mode = request.nextUrl.searchParams.get('mode') ?? mode;
      const target = request.nextUrl.searchParams.get('status');
      if (target) db.prepare('UPDATE problem_dossiers SET status=? WHERE id=?').run(target, 'candidate');
      return Response.json({ mode, bodies, dossiers: listProblemDossiers({ includeSuppressed: true }) });
    },
  } };
}
