import { NextResponse, type NextRequest } from 'next/server';
import { mutationWorkspace } from '@/lib/repos/mutation-workspace';
import { discoverImportSessions, existingImportedSession, importedSessionBindings } from '@/lib/runtime/discovered-session-import';

export const dynamic = 'force-dynamic';

/** GET: pending provider sessions and their project groups; no recency cap. */
export async function GET(request: NextRequest) {
  try {
    const workspace = mutationWorkspace(request);
    const imported = importedSessionBindings(workspace);
    const sessions = (await discoverImportSessions(workspace)).filter(session => !existingImportedSession(session.sessionKey, imported, workspace));
    const projects = new Map<string, { repoPath: string; repoName: string; sessionKeys: string[] }>();
    for (const session of sessions) {
      const project = projects.get(session.repoPath) ?? { repoPath: session.repoPath, repoName: session.repoName, sessionKeys: [] };
      project.sessionKeys.push(session.sessionKey);
      projects.set(session.repoPath, project);
    }
    return NextResponse.json({ sessions, projects: [...projects.values()] }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: { code: 'discovery_failed', message: 'Could not list discovered sessions.' } }, { status: 500 });
  }
}
