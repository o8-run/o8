import { afterAll, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { GET, POST } from './route';
import {
  externalServerToMcpConfig,
  listExternalMcpServers,
  removeExternalMcpServer,
} from '@/lib/mcp/external-servers';

describe.sequential('MCP server setup save path', () => {
  let serverId: string | null = null;

  afterAll(async () => {
    if (serverId) removeExternalMcpServer(serverId);
    const { closeDb } = await import('@/lib/db');
    closeDb();
  });

  it('persists exact argv and env without starting the configured command', async () => {
    const response = await POST(new Request('http://127.0.0.1/api/setup/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'save-path-fixture',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'fixture-package', '', ' value with edges '],
        env: { API_TOKEN: '  synthetic secret  ' },
        enabled: true,
      }),
    }));

    expect(response.status).toBe(200);
    const payload = await response.json() as { server: { id: string } };
    serverId = payload.server.id;
    const stored = listExternalMcpServers().find((server) => server.id === serverId);
    expect(stored).toMatchObject({
      name: 'save-path-fixture',
      command: 'npx',
      args: ['-y', 'fixture-package', '', ' value with edges '],
      env: { API_TOKEN: '  synthetic secret  ' },
    });
    const launch = externalServerToMcpConfig(stored!);
    expect(launch).toMatchObject({ type: 'stdio', command: process.execPath, args: ['-e', expect.any(String), expect.any(String)] });
    expect(JSON.stringify(launch).includes('  synthetic secret  ')).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();

    const listed = await GET();
    const listedPayload = await listed.json() as {
      servers: Array<{ id: string; env: unknown; envJson: unknown; hasEnv: boolean }>;
    };
    expect(listedPayload.servers.find((server) => server.id === serverId)).toMatchObject({
      env: null,
      envJson: null,
      hasEnv: true,
    });
  });
});
