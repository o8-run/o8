import { NextRequest, NextResponse } from 'next/server';
import { POST as saveChatHistory } from '@/app/api/v2/chat-history/route';
import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { mutationWorkspace } from '@/lib/repos/mutation-workspace';
import {
  canImportDiscoveredSession,
  discoveredImportTabId,
  discoverImportSessions,
  existingImportedSession,
  importedSessionBindings,
  type ImportedSession,
} from '@/lib/runtime/discovered-session-import';

export const dynamic = 'force-dynamic';

/** POST { sessionKeys: string[] }: validate the complete selection before writing. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!Array.isArray(body?.sessionKeys) || body.sessionKeys.some((key: unknown) => typeof key !== 'string' || !key.trim())) {
    return NextResponse.json({ error: { code: 'invalid_selection', message: 'sessionKeys must be an array of non-empty strings.' } }, { status: 400 });
  }
  const sessionKeys = [...new Set<string>(body.sessionKeys)];
  const workspace = mutationWorkspace(request);
  try {
    const discovered = new Map((await discoverImportSessions(workspace)).map(session => [session.sessionKey, session]));
    // The shared lease serializes imports across the HTTP and WS server processes.
    return await withPacketLifecycleMutationLock('system:discovered-session-import', async () => {
      const bindings = importedSessionBindings(workspace);
      for (const key of sessionKeys) {
        const prior = existingImportedSession(key, bindings, workspace);
        if (prior) bindings.set(key, prior);
      }
      const unknown = sessionKeys.filter(key => !bindings.has(key) && !discovered.has(key));
      if (unknown.length) {
        return NextResponse.json({ error: { code: 'unknown_discovered_session', message: 'Selection contains unknown sessions.', sessionKeys: unknown } }, { status: 404 });
      }
      // Name every session that cannot resume, so a picker can drop them all in one retry.
      const notResumable: string[] = [];
      for (const key of sessionKeys) {
        if (!bindings.has(key) && !await canImportDiscoveredSession(discovered.get(key)!)) notResumable.push(key);
      }
      if (notResumable.length) {
        return NextResponse.json({ error: { code: 'session_not_resumable', message: 'The provider rollout is missing or ambiguous.',
          sessionKey: notResumable[0], sessionKeys: notResumable } }, { status: 409 });
      }
      const created: ImportedSession[] = [];
      const existing: ImportedSession[] = [];
      for (const sessionKey of sessionKeys) {
        const prior = bindings.get(sessionKey);
        if (prior) { existing.push({ sessionKey, tabId: prior }); continue; }
        const session = discovered.get(sessionKey)!;
        const tabId = discoveredImportTabId(sessionKey);
        const url = new URL(request.url);
        url.pathname = '/api/v2/chat-history';
        // Exactly the single-row Continue save path: retain its metadata, indexing,
        // workspace checks and provider binding behavior without copying its writer.
        const response = await saveChatHistory(new NextRequest(url, {
          method: 'POST', headers: request.headers,
          body: JSON.stringify({ tabId, messages: [], orchestratorVisible: true, title: session.title, repoPath: session.repoPath,
            repoName: session.repoName, repoBranch: session.repoBranch, backend: session.backend,
            model: session.backend === 'codex' ? 'codex' : 'claude-code',
            orchestratorSessionIds: { [session.backend]: session.providerSessionId } }),
        }));
        if (!response.ok) {
          return NextResponse.json({ error: { code: 'import_failed', message: 'Could not save an imported chat.' }, created, existing }, { status: response.status });
        }
        created.push({ sessionKey, tabId });
        bindings.set(sessionKey, tabId);
      }
      return NextResponse.json({ created, existing }, { headers: { 'Cache-Control': 'no-store' } });
    });
  } catch {
    return NextResponse.json({ error: { code: 'import_failed', message: 'Could not import discovered sessions. Retry the same selection safely.' } }, { status: 500 });
  }
}
