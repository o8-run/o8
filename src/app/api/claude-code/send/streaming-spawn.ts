import os from 'os';
import { knowledgeSourceWriteRefusal, normalizeKnowledgeWritePath } from '@/lib/cortex/knowledge/sources';
import { ensureSession, sendMessage } from '@/lib/claude-code/interactive-session';
import type { ClaudeCodePermissionMode } from '@/lib/claude-code/interactive-session';

interface SendRequest {
  message: string;
  cwd?: string;
  sessionId?: string;
  tabId?: string;
  model?: string;
  resumeSessionId?: string;
  planMode?: boolean;
  bypassPermissions?: boolean;
}

function jsonError(error: string, status: number) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function handleClaudeCodeSend(req: Request) {
  let body: SendRequest;
  try {
    body = (await req.json()) as SendRequest;
  } catch {
    return jsonError('Invalid JSON request body', 400);
  }
  const { message, cwd, sessionId, tabId, model, resumeSessionId, planMode, bypassPermissions } = body;

  if (!message?.trim()) {
    return jsonError('Message is required', 400);
  }

  const sessionKey = (tabId || sessionId || '').trim();
  if (!sessionKey) {
    return jsonError('A stable tabId or sessionId is required', 400);
  }

  const sourceRefusal = knowledgeSourceWriteRefusal(cwd);
  if (sourceRefusal) return sourceRefusal;
  const expandedCwd = cwd ? normalizeKnowledgeWritePath(cwd.replace(/^~(?=\/|$)/, os.homedir())) : undefined;
  const workingDir = expandedCwd || process.cwd();
  const resolvedRefusal = knowledgeSourceWriteRefusal(workingDir);
  if (resolvedRefusal) return resolvedRefusal;
  const permissionMode: ClaudeCodePermissionMode = bypassPermissions
    ? 'bypassPermissions'
    : planMode
      ? 'plan'
      : 'acceptEdits';
  let session: ReturnType<typeof ensureSession>;
  // Only resume from an actual captured Claude session_id — never from
  // sessionId, which is a tab/transport routing key, not a Claude session.
  const resumeId = resumeSessionId?.trim() || undefined;
  try {
    session = ensureSession(sessionKey, workingDir, model, permissionMode, resumeId);
  } catch (error) {
    return jsonError(errorText(error), 500);
  }

  const encoder = new TextEncoder();
  let abortController: AbortController | null = null;
  let streamClosed = false;

  const stream = new ReadableStream({
    start(controller) {
      abortController = new AbortController();
      const markClientGone = () => {
        streamClosed = true;
      };
      if (req.signal.aborted) markClientGone();
      else req.signal.addEventListener('abort', markClientGone, { once: true });
      let closeText = '';
      let closeSessionId = session.sessionId ?? null;
      const enqueueEvent = (event: unknown) => {
        if (streamClosed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const closeStream = () => {
        if (streamClosed) return;
        streamClosed = true;
        req.signal.removeEventListener('abort', markClientGone);
        controller.close();
      };
      void sendMessage(session, message, (event) => {
        if (event.type === 'delta') closeText += event.text;
        if (event.type === 'done') {
          closeText = event.text;
          closeSessionId = event.sessionId ?? closeSessionId;
        }
        enqueueEvent(event);
      }, { planMode, signal: abortController.signal }).then(() => {
        const settledSessionId = closeSessionId || session.sessionId || undefined;
        enqueueEvent({
          type: 'close',
          exitCode: 0,
          text: closeText,
          sessionId: settledSessionId,
        });
        closeStream();
      }).catch((error: unknown) => {
        enqueueEvent({ type: 'error', text: errorText(error) });
        closeStream();
      });
    },
    cancel() {
      streamClosed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
