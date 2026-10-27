import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const testRoot = mkdtempSync(join(tmpdir(), 'o8-mobile-first-thread-'));
process.env.CORTEX_IDE_DATA_DIR = testRoot;

const threadRoute = await import('@/app/api/mobile/orchestrator/threads/route');
const historyRoute = await import('@/app/api/v2/chat-history/route');
const historyListRoute = await import('@/app/api/v2/chat-history/list/route');
const mediaRoute = await import('@/app/api/mobile/media/route');
const { buildOrchestratorSendPayload } = await import(
  '@/components/desktop/thoughts/use-orchestrator-stream/send-payload'
);
const { serializeChatThreadMessages } = await import(
  '@/components/desktop/thoughts/chat-panel/usePersistChatThread'
);
const {
  createMobileOrchestratorThreadFromRepo,
} = await import('@/lib/mobile/orchestrator-thread-create');
const {
  listMobileOrchestratorThreads,
  safeOrchestratorHistoryPath,
} = await import('@/lib/mobile/orchestrator-thread-history');
const { OrchestratorThreadProjectError } = await import(
  '@/lib/mobile/orchestrator-thread-project'
);
const { persistOrchestratorThreadUserMessageFromWire } = await import(
  '@/lib/ws-server/orchestrator-thread-send'
);
const { createProject } = await import('@/lib/projects/store');

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  rmSync(testRoot, { recursive: true, force: true });
});

describe('mobile first orchestrator conversation', () => {
  it('round-trips a valid project through creation, persistence, and both thread lists', async () => {
    expect(listMobileOrchestratorThreads()).toEqual([]);
    const project = createProject({ name: 'Shared repo project' });

    const thread = await createMobileOrchestratorThreadFromRepo({
      repoPath: '/tmp/repos/first-mobile-repo',
      repoName: 'First mobile repo',
      repoBranch: 'main',
      projectId: project.id,
    }, {
      token: 'mobile-test-token',
      fetchImpl: async (input, init) => threadRoute.POST(new NextRequest(`http://localhost${input}`, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      })),
    });

    expect(thread).toMatchObject({
      id: expect.stringMatching(/^thoughts-/),
      repoPath: '/tmp/repos/first-mobile-repo',
      repoName: 'First mobile repo',
      repoBranch: 'main',
      status: 'idle',
      projectId: project.id,
    });
    expect(JSON.parse(readFileSync(safeOrchestratorHistoryPath(thread.id), 'utf8')))
      .toMatchObject({ projectId: project.id });

    const desktopPersistenceResponse = await historyRoute.POST(new NextRequest(
      'http://localhost/api/v2/chat-history',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tabId: thread.id,
          messages: [{ role: 'user', content: 'Keep the original project identity.' }],
          repoPath: '/tmp/repos/first-mobile-repo',
        }),
      },
    ));
    expect(desktopPersistenceResponse.status).toBe(200);

    const mobileListResponse = await threadRoute.GET(
      new NextRequest('http://localhost/api/mobile/orchestrator/threads'),
    );
    const mobileList = await mobileListResponse.json();
    expect(mobileList.threads).toContainEqual(expect.objectContaining({
      id: thread.id,
      repoPath: '/tmp/repos/first-mobile-repo',
      projectId: project.id,
    }));

    const historyListResponse = await historyListRoute.GET(
      new NextRequest('http://localhost/api/v2/chat-history/list?include=orchestrator'),
    );
    const historyList = await historyListResponse.json();
    expect(historyList.conversations).toContainEqual(expect.objectContaining({
      tabId: thread.id,
      projectId: project.id,
    }));
  });

  it('rejects an unknown projectId with a structured error', async () => {
    const response = await threadRoute.POST(new NextRequest(
      'http://localhost/api/mobile/orchestrator/threads',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repoPath: '/tmp/repos/unknown-project',
          projectId: 'proj-does-not-exist',
        }),
      },
    ));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: 'orchestrator_thread_project_not_found',
        message: 'Project proj-does-not-exist does not exist.',
        projectId: 'proj-does-not-exist',
      },
    });
  });

  it('keeps projectId optional for legacy clients', async () => {
    const response = await threadRoute.POST(new NextRequest(
      'http://localhost/api/mobile/orchestrator/threads',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoPath: '/tmp/repos/legacy-client' }),
      },
    ));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.thread).toMatchObject({
      repoPath: '/tmp/repos/legacy-client',
      projectId: null,
    });
  });

  it('round-trips the desktop WebSocket send project through persisted thread state', async () => {
    const project = createProject({ name: 'Desktop shared repo project' });
    const payload = JSON.parse(buildOrchestratorSendPayload({
      repoPath: '/tmp/repos/shared-desktop-repo',
      projectId: project.id,
      threadId: 'thoughts-desktop-project',
      clientMessageId: 'desktop-message-1',
      wireMessage: 'Ship the selected project.',
      displayMessage: 'Ship the selected project.',
      permissionMode: 'full',
      orchestrationMode: 'fleet',
      model: 'claude-code',
      backend: 'claude',
    })) as Record<string, unknown>;

    const thread = persistOrchestratorThreadUserMessageFromWire({
      message: payload,
      tabId: payload.threadId as string,
      repoPath: payload.repoPath as string,
      transcriptMessage: payload.message as string,
      messageId: payload.clientMessageId as string,
      backend: 'claude',
      timestampMs: 1_753_900_000_000,
    });
    expect(thread).toMatchObject({
      id: 'thoughts-desktop-project',
      projectId: project.id,
    });

    const mobileListResponse = await threadRoute.GET(
      new NextRequest('http://localhost/api/mobile/orchestrator/threads'),
    );
    const mobileList = await mobileListResponse.json();
    expect(mobileList.threads).toContainEqual(expect.objectContaining({
      id: 'thoughts-desktop-project',
      projectId: project.id,
    }));
  });

  it('keeps a sent image visible and durable across a stale client transcript POST', async () => {
    const dataUri = 'data:image/png;base64,' + Buffer.from('image-fixture').toString('base64');
    const threadId = 'thoughts-desktop-image-send';
    const optimisticMessages = serializeChatThreadMessages([{
      id: 'orch-user-image-1', role: 'user', text: 'Please inspect this image.',
      timestamp: 1_753_900_000_100,
      media: [{ kind: 'image', path: dataUri, name: 'photo.png' }],
    }]);
    const earlyPost = await historyRoute.POST(new NextRequest('http://localhost/api/v2/chat-history', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tabId: threadId, repoPath: '/tmp/repos/image-send', messages: optimisticMessages }),
    }));
    expect(earlyPost.status).toBe(200);
    persistOrchestratorThreadUserMessageFromWire({
      message: { threadId },
      tabId: threadId,
      repoPath: '/tmp/repos/image-send',
      transcriptMessage: 'Please inspect this image.',
      messageId: 'orch-user-image-1',
      backend: 'codex',
      timestampMs: 1_753_900_000_100,
      attachments: [{ dataUri, name: 'photo.png' }],
    });
    const stored = JSON.parse(readFileSync(safeOrchestratorHistoryPath(threadId), 'utf8'));
    const media = stored.messages[0].media[0];
    expect(media).toMatchObject({ kind: 'image', name: 'photo.png', mimeType: 'image/png' });
    expect(media.path).not.toContain('data:');
    expect(readFileSync(media.path).toString()).toBe('image-fixture');
    const mediaResponse = await mediaRoute.GET(new NextRequest(
      `http://localhost/api/mobile/media?path=${encodeURIComponent(media.path)}`,
    ));
    expect(mediaResponse.status).toBe(415);
    expect(await mediaResponse.json()).toMatchObject({ code: 'binary_preview_refused', redaction: { version: 1 } });
    expect(readFileSync(media.path).toString()).toBe('image-fixture');

    const response = await historyRoute.POST(new NextRequest('http://localhost/api/v2/chat-history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tabId: threadId,
        repoPath: '/tmp/repos/image-send',
        messages: optimisticMessages,
      }),
    }));
    expect(response.status).toBe(200);
    const afterPost = JSON.parse(readFileSync(safeOrchestratorHistoryPath(threadId), 'utf8'));
    expect(afterPost.messages[0].media).toEqual([media]);
  });

  it('puts explicit handoff consent on the WebSocket command', () => {
    const payload = JSON.parse(buildOrchestratorSendPayload({
      repoPath: '/tmp/repos/shared-desktop-repo',
      threadId: 'thoughts-explicit-handoff',
      clientMessageId: 'desktop-message-handoff',
      wireMessage: 'Continue with measured context.',
      displayMessage: 'Continue with measured context.',
      permissionMode: 'full',
      orchestrationMode: 'fleet',
      model: 'destination/model',
      backend: 'codex',
      handoffMode: 'handoff',
    })) as Record<string, unknown>;

    expect(payload.handoffMode).toBe('handoff');
  });

  it('rejects an unknown project from the desktop WebSocket persistence entry', () => {
    const payload = JSON.parse(buildOrchestratorSendPayload({
      repoPath: '/tmp/repos/shared-desktop-repo',
      projectId: 'proj-does-not-exist',
      threadId: 'thoughts-desktop-unknown-project',
      clientMessageId: 'desktop-message-2',
      wireMessage: 'This must be rejected.',
      displayMessage: 'This must be rejected.',
      permissionMode: 'full',
      orchestrationMode: 'fleet',
      model: 'claude-code',
      backend: 'claude',
    })) as Record<string, unknown>;

    let rejection: unknown;
    try {
      persistOrchestratorThreadUserMessageFromWire({
        message: payload,
        tabId: payload.threadId as string,
        repoPath: payload.repoPath as string,
        transcriptMessage: payload.message as string,
        messageId: payload.clientMessageId as string,
        backend: 'claude',
        timestampMs: 1_753_900_001_000,
      });
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(OrchestratorThreadProjectError);
    if (!(rejection instanceof OrchestratorThreadProjectError)) {
      throw new Error('Expected a structured project rejection.');
    }
    expect(rejection.toPayload()).toEqual({
      code: 'orchestrator_thread_project_not_found',
      message: 'Project proj-does-not-exist does not exist.',
      projectId: 'proj-does-not-exist',
    });
    expect(listMobileOrchestratorThreads()).not.toContainEqual(expect.objectContaining({
      id: 'thoughts-desktop-unknown-project',
    }));
  });
});
