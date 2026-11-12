import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import * as tasks from '@/app/api/tasks/route';
import * as taskDispatch from '@/app/api/tasks/[taskId]/dispatch/route';
import * as create from '@/app/api/orchestrator/create-mission/route';
import * as spawn from '@/app/api/orchestrator/spawn-prompt/route';
import * as dispatch from '@/app/api/orchestrator/dispatch/route';
import * as delegate from '@/app/api/orchestrator/delegate/route';

const message = 'Requested runtime magnitude is not dispatchable.';
const routes = [
  ['tasks', (request: NextRequest) => tasks.POST(request)],
  ['task-dispatch', (request: NextRequest) => taskDispatch.POST(request, { params: Promise.resolve({ taskId: 'fixture' }) })],
  ['create-mission', (request: NextRequest) => create.POST(request)],
  ['spawn-prompt', (request: NextRequest) => spawn.POST(request)],
  ['dispatch', (request: NextRequest) => dispatch.POST(request)],
  ['delegate', (request: NextRequest) => delegate.POST(request)],
] as const;
it.each(routes)('%s refuses an undispatchable runtime consistently', async (name, post) => {
  const response = await post(new NextRequest('http://localhost/api/'+name, {
    method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({
      runtime: 'magnitude', requestedRuntime: 'magnitude', title: 'Fixture',
      repoPath: process.cwd(), task: 'Inspect fixture', prompt: 'Inspect fixture', isolate: true,
      issues: [{ number: 90131, title: 'Fixture', body: '', url: '' }], clientMutationId: 'refusal-'+name,
    }),
  }));
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.code ?? body.error?.code).toBe('worker_not_enabled');
  expect(typeof body.error === 'string' ? body.error : body.error?.message).toBe(message);
});

it('the CLI task dispatch command and MCP tool preserve the route message', async () => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { vi } = await import('vitest');
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const response = await taskDispatch.POST(new NextRequest('http://localhost'+req.url, {
      method: 'POST', headers: { host: 'localhost' }, body: Buffer.concat(chunks).toString(),
    }), { params: Promise.resolve({ taskId: 'fixture' }) });
    res.writeHead(response.status, { 'content-type': 'application/json' });
    res.end(await response.text());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  vi.stubEnv('O8_API_PORT', String(address.port));
  vi.stubEnv('O8_API_TOKEN', 'fixture');
  try {
    const { runTaskDispatch } = await import('../cli/src/commands/task');
    await expect(runTaskDispatch({ human: false } as Parameters<typeof runTaskDispatch>[0], ['fixture', '--runtime', 'magnitude']))
      .rejects.toMatchObject({ message });
    const { handleTaskDispatch } = await import('@/lib/mcp/operator-handlers/task-dispatch');
    const result = await handleTaskDispatch({ taskId: 'fixture', requestedRuntime: 'magnitude' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(message);
  } finally {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
