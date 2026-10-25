import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-prompt-library-api-'));
const token = 'prompt-library-route-test-token-0123456789';
writeFileSync(path.join(dataDir, 'ws-token'), `${token}\n`, 'utf8');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { getSqlite } = await import('@/lib/db');
const { panelGateMiddleware } = await import('@/middleware');
const collectionRoute = await import('@/app/api/prompt-library/route');
const entryRoute = await import('@/app/api/prompt-library/[id]/route');
const importRoute = await import('@/app/api/prompt-library/import/route');
const useRoute = await import('@/app/api/prompt-library/[id]/use/route');

function request(pathname: string, method: string = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`http://localhost:3001${pathname}`, {
    method,
    headers: {
      host: 'localhost:3001',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('prompt library API real path', () => {
  it('refuses a stale saved-prompt update through the production route', async () => {
    const made = await collectionRoute.POST(request('/api/prompt-library', 'POST', { title: 'Revision', body: 'Original text' }));
    const { prompt } = await made.json();
    const desktop = await entryRoute.PATCH(request(`/api/prompt-library/${prompt.id}`, 'PATCH', { body: 'Desktop text' }), context(prompt.id));
    const newer = (await desktop.json()).prompt;
    expect(newer.updatedAt).toBeGreaterThan(prompt.updatedAt);
    const stale = await entryRoute.PATCH(request(`/api/prompt-library/${prompt.id}`, 'PATCH', {
      body: 'Stale native text', expectedUpdatedAt: prompt.updatedAt,
    }), context(prompt.id));
    expect(stale.status).toBe(409);
    const current = await entryRoute.GET(request(`/api/prompt-library/${prompt.id}`), context(prompt.id));
    expect((await current.json()).prompt.body).toBe('Desktop text');
    const fresh = await entryRoute.PATCH(request(`/api/prompt-library/${prompt.id}`, 'PATCH', {
      body: 'Fresh native text', expectedUpdatedAt: newer.updatedAt,
    }), context(prompt.id));
    expect(fresh.status).toBe(200);
  });

  it('refuses a stale saved-prompt deletion through the production route', async () => {
    const made = await collectionRoute.POST(request('/api/prompt-library', 'POST', { title: 'Revision', body: 'Original text' }));
    const { prompt } = await made.json();
    const desktop = await entryRoute.PATCH(request(`/api/prompt-library/${prompt.id}`, 'PATCH', { body: 'Desktop text' }), context(prompt.id));
    const newer = (await desktop.json()).prompt;
    const stale = await entryRoute.DELETE(request(`/api/prompt-library/${prompt.id}?expectedUpdatedAt=${prompt.updatedAt}`, 'DELETE'), context(prompt.id));
    expect(stale.status).toBe(409);
    const current = await entryRoute.GET(request(`/api/prompt-library/${prompt.id}`), context(prompt.id));
    expect((await current.json()).prompt.body).toBe('Desktop text');
    const fresh = await entryRoute.DELETE(request(`/api/prompt-library/${prompt.id}?expectedUpdatedAt=${newer.updatedAt}`, 'DELETE'), context(prompt.id));
    expect(fresh.status).toBe(200);
  });

  beforeEach(() => {
    getSqlite().exec('DELETE FROM prompt_library');
    getSqlite().exec("DELETE FROM automations WHERE id LIKE 'prompt-import-%'");
    getSqlite().exec("DELETE FROM watched_agents WHERE surface_id LIKE 'prompt-import-%'");
  });

  it('is operator-gated and persists searchable prompts through the route handlers', async () => {
    const remoteGate = panelGateMiddleware(new NextRequest(
      'http://192.0.2.10:3001/api/prompt-library',
      { method: 'GET', headers: { host: '192.0.2.10:3001' } },
    ));
    expect(remoteGate.status).toBe(401);
    const operatorGate = panelGateMiddleware(new NextRequest(
      'http://192.0.2.10:3001/api/prompt-library',
      {
        method: 'GET',
        headers: { host: '192.0.2.10:3001', authorization: `Bearer ${token}` },
      },
    ));
    expect(operatorGate.status).toBe(200);

    const createResponse = await collectionRoute.POST(request('/api/prompt-library', 'POST', {
      title: 'Security boundary review',
      body: 'Inspect authentication and authorization boundaries. Report concrete findings.',
      tags: ['security', 'review'],
      scope: 'repo',
      repoPath: '/repos/o8',
    }));
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      created: boolean;
      prompt: { id: string; title: string; useCount: number };
    };
    expect(created.created).toBe(true);

    const duplicateResponse = await collectionRoute.POST(request('/api/prompt-library', 'POST', {
      title: 'Duplicate security review',
      body: 'Inspect authentication and authorization boundaries. Report concrete findings.',
      scope: 'repo',
      repoPath: '/repos/o8',
    }));
    expect(duplicateResponse.status).toBe(200);
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      created: false,
      prompt: { id: created.prompt.id },
    });

    const searchResponse = await collectionRoute.GET(request(
      '/api/prompt-library?scope=available&repoPath=%2Frepos%2Fo8&query=security+review',
    ));
    expect(searchResponse.status).toBe(200);
    await expect(searchResponse.json()).resolves.toMatchObject({
      ok: true,
      prompts: [{ id: created.prompt.id, tags: ['security', 'review'] }],
    });

    const updateResponse = await entryRoute.PATCH(
      request(`/api/prompt-library/${created.prompt.id}`, 'PATCH', {
        title: 'Security and authorization review',
        tags: ['security', 'authorization'],
      }),
      context(created.prompt.id),
    );
    expect(updateResponse.status).toBe(200);

    const useResponse = await useRoute.POST(
      request(`/api/prompt-library/${created.prompt.id}/use`, 'POST'),
      context(created.prompt.id),
    );
    expect(useResponse.status).toBe(200);
    await expect(useResponse.json()).resolves.toMatchObject({
      prompt: {
        id: created.prompt.id,
        title: 'Security and authorization review',
        useCount: 1,
      },
    });

    const readResponse = await entryRoute.GET(
      request(`/api/prompt-library/${created.prompt.id}`),
      context(created.prompt.id),
    );
    await expect(readResponse.json()).resolves.toMatchObject({
      prompt: {
        id: created.prompt.id,
        body: 'Inspect authentication and authorization boundaries. Report concrete findings.',
        useCount: 1,
      },
    });

    const deleteResponse = await entryRoute.DELETE(
      request(`/api/prompt-library/${created.prompt.id}`, 'DELETE'),
      context(created.prompt.id),
    );
    expect(deleteResponse.status).toBe(200);
    const missingResponse = await entryRoute.GET(
      request(`/api/prompt-library/${created.prompt.id}`),
      context(created.prompt.id),
    );
    expect(missingResponse.status).toBe(404);
  });

  it('requires a repo path for repo-scoped saves', async () => {
    const response = await collectionRoute.POST(request('/api/prompt-library', 'POST', {
      title: 'Repo prompt',
      body: 'Inspect this repository.',
      scope: 'repo',
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'repo_path_required' },
    });
  });

  it('offers and imports existing prompt-bearing work through the gated route', async () => {
    getSqlite().prepare(`
      INSERT INTO automations (id, name, owner, repo_path, runtime, prompt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'prompt-import-automation',
      'Dependency audit',
      'operator',
      '/repos/o8',
      'codex',
      'Audit dependency advisories and report the remaining count.',
    );

    const sourcesResponse = await importRoute.GET(request(
      '/api/prompt-library/import?repoPath=%2Frepos%2Fo8',
    ));
    expect(sourcesResponse.status).toBe(200);
    const sourcesPayload = await sourcesResponse.json() as {
      sources: Array<{ sourceKind: 'automation'; sourceId: string }>;
    };
    expect(sourcesPayload.sources).toEqual([
      expect.objectContaining({ sourceKind: 'automation', sourceId: 'prompt-import-automation' }),
    ]);

    const importResponse = await importRoute.POST(request('/api/prompt-library/import', 'POST', {
      sources: sourcesPayload.sources,
      repoPath: '/repos/o8',
    }));
    expect(importResponse.status).toBe(200);
    await expect(importResponse.json()).resolves.toMatchObject({
      ok: true,
      created: 1,
      skipped: 0,
      entries: [{ sourceId: 'prompt-import-automation', scope: 'repo', repoPath: '/repos/o8' }],
    });

    const repeatedResponse = await importRoute.POST(request('/api/prompt-library/import', 'POST', {
      sources: sourcesPayload.sources,
      repoPath: '/repos/o8',
    }));
    await expect(repeatedResponse.json()).resolves.toMatchObject({ created: 0, skipped: 1 });
  });
});
