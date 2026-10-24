import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { NextResponse, type NextRequest } from 'next/server';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { getOperatorDefaults, updateOperatorDefaults } from '@/lib/operator/defaults';
import { configuredKnowledgeSources } from '@/lib/cortex/knowledge/sources';
import { ensureKnowledgeSourceWatcher, forgetKnowledgeSource, indexKnowledgeSources, invalidateKnowledgeSource, knowledgeSourceState } from '@/lib/cortex/knowledge';
export const runtime = 'nodejs';
const reply = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
function denied(request: Request) {
  return resolveRequestPrincipalContext(request).role !== 'operator' ? reply({ error: 'Knowledge sources require an operator credential.' }, 403) : null;
}
export async function GET(request: NextRequest) {
  const refusal = denied(request); if (refusal) return refusal;
  return reply({ sources: configuredKnowledgeSources().map(knowledgeSourceState) });
}
let mutations: Promise<unknown> = Promise.resolve();
export async function POST(request: NextRequest) {
  const refusal = denied(request); if (refusal) return refusal;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const operation = mutations.catch(() => {}).then(async () => {
    if (!body || !['add', 'remove', 'refresh'].includes(String(body.action))) return reply({ error: 'Choose add, remove or refresh.' }, 400);
    try {
      const { values } = await getOperatorDefaults();
      if (body.action === 'add') {
        if (typeof body.path !== 'string' || !body.path.trim()) return reply({ error: 'A folder path is required.' }, 400);
        const source = { id: randomUUID(), path: body.path.trim(), name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : path.basename(body.path.trim()),
          include: body.include ?? ['**/*.md'], exclude: body.exclude ?? [] };
        await updateOperatorDefaults({ knowledgeSources: [...values.knowledgeSources, source] as typeof values.knowledgeSources });
      } else if (body.action === 'remove') {
        if (typeof body.id !== 'string' || !values.knowledgeSources.some(s => s.id === body.id)) return reply({ error: 'Knowledge source not found.' }, 404);
        invalidateKnowledgeSource(body.id);
        await updateOperatorDefaults({ knowledgeSources: values.knowledgeSources.filter(s => s.id !== body.id) });
        forgetKnowledgeSource(body.id);
      }
      ensureKnowledgeSourceWatcher();
      void indexKnowledgeSources();
      return reply({ sources: configuredKnowledgeSources().map(knowledgeSourceState) });
    } catch (error) { return reply({ error: error instanceof Error ? error.message : 'Knowledge source could not be updated.' }, 400); }
  });
  mutations = operation;
  return operation;
}
