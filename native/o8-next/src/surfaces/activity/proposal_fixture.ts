// Authored discovery records; mutations use the existing production routes and
// write only the host's owned data directory. No provider or worker runs here.
import type { SurfaceContext, SurfaceRoutes, Route } from '../../../../../scripts/next/surface-routes';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { NextRequest } from 'next/server';
export async function installProposals({ root, repo, dataDir }: SurfaceContext): Promise<SurfaceRoutes> {
  const proposals = await import('../../../../../src/app/api/cortex/proposals/route');
  const cross = await import('../../../../../src/app/api/cortex/cross-repo-proposals/route');
  const directives = await import('../../../../../src/app/api/cortex/directives/route');
  const observations = await import('../../../../../src/lib/cortex/proposals');
  const observation = observations.proposeObservation({ packetId: 'fixture-observer', laneId: 'fixture-observer-lane', kind: 'gotcha', scope: 'repo', proposed_by: 'fixture-observer', text: 'Keep file writes guarded by the acknowledged content hash.' });
  const peer = join(root, 'directive-source'); mkdirSync(peer); execFileSync('git', ['init', '-q', peer]);
  const { addRepo } = await import('../../../../../src/lib/repos/registry');
  const source = await addRepo(peer); const target = await addRepo(repo);
  const auto = { id: 'auto-fixture', filePattern: 'src/**/*.rs', fixPattern: 'guard writes', hits: 4, lastSeenAt: new Date().toISOString(), outcomeIds: ['fixture-1', 'fixture-2', 'fixture-3', 'fixture-4'], draftDirective: '# Guard file writes\n\nUse the last acknowledged hash when saving a changed file.' };
  const shared = { id: 'cross-fixture', targetRepoId: target.id, targetRepoName: target.name, sourceRepoId: source.id, sourceRepoName: source.name, directiveId: 'fixture-source-rule', directiveTitle: 'Keep verification beside the change', directiveBody: 'Verify the real entry point before reporting a result.', directivePriority: 7, similarity: 0.87, draftDirective: '# Keep verification beside the change\n\nVerify the real entry point before reporting a result.' };
  let mode = 'ready'; let autoHidden = false; let crossHidden = false;
  const bodies: Array<{ path: string; body: unknown }> = [];
  const wrap = (path: string, route: Route): Route => async request => {
    const body = await request.clone().json(); bodies.push({ path, body });
    if (mode === 'fail' || mode === 'fail-origin' && path.includes('cross-repo')) return Response.json({ ok: false, error: 'Owned proposal mutation refused' }, { status: 503 });
    if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 350));
    const result = await route(request);
    if (result.ok && path.endsWith('/proposals') && body.action === 'dismiss') autoHidden = true;
    if (result.ok && path.endsWith('cross-repo-proposals')) crossHidden = true;
    return result;
  };
  const read = (name: string) => existsSync(join(dataDir, name)) ? JSON.parse(readFileSync(join(dataDir, name), 'utf8')) : null;
  return { priority: -2, admit: () => 200, routes: {
    'GET /api/cortex/proposals': async () => Response.json({ ok: true, proposals: [...observations.readObservationProposals(), ...(autoHidden ? [] : [auto])] }),
    'GET /api/cortex/cross-repo-proposals': async () => Response.json({ ok: true, proposals: crossHidden ? [] : [shared] }),
    'POST /api/cortex/proposals': wrap('/api/cortex/proposals', proposals.POST),
    'POST /api/cortex/cross-repo-proposals': wrap('/api/cortex/cross-repo-proposals', cross.POST),
    'POST /api/cortex/directives': wrap('/api/cortex/directives', directives.POST),
    'GET /api/activity-proposals-fixture': async (request: NextRequest) => {
      mode = request.nextUrl.searchParams.get('mode') ?? mode;
      if (request.nextUrl.searchParams.has('many')) {
        for (let n = 0; n < 30; n++) execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', `Fixture retained activity ${n}`]);
      }
      const folder = join(dataDir, 'directives');
      const files = existsSync(folder) ? readdirSync(folder).filter(p => p.startsWith('next-proposal-')).map(p => ({ name: p, content: readFileSync(join(folder, p), 'utf8') })) : [];
      const history = join(dataDir, 'chat-history');
      const messages = readdirSync(history).filter(p => p.endsWith('.json')).reduce((count, p) => { try { const h = JSON.parse(readFileSync(join(history, p), 'utf8')); return count + (Array.isArray(h.messages) ? h.messages.length : 0); } catch { return count; } }, 0);
      return Response.json({ mode, auto, cross: shared, observation, bodies, files, messages, observations: observations.readObservationProposals(), snooze: read('proposal-snooze.json'), crossSnooze: read('cross-repo-snooze.json'), origins: read('directive-origins.json') });
    },
  } };
}
