import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliError } from '../../cli/src/api';
import { runMission } from '../../cli/src/commands/mission';
// Loaded at collection time: the handler graph takes seconds to transform on a
// cold worker, and that cost must not count against the test timeout.
import { handleCreateMission } from '../../src/lib/mcp/operator-handlers/mission';
import {
  GOVERNED_EXISTING_BRANCH_POLICY,
  governedMissionCreateArgs,
} from '../../scripts/bench/coding-governed-mission';

const mode = { human: false, verbose: false };

function textContent(result: {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
}): string {
  return result.content.find((entry) => entry.type === 'text')?.text ?? '';
}

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('mission existing-branch policy', () => {
  it('rejects an invalid CLI value with the same message as the MCP path', async () => {
    const mcpResult = await handleCreateMission({
      repoPath: '/tmp/o8-policy-test',
      issues_inline: [{ title: 'policy parity' }],
      existingBranchPolicy: 'replace',
      dispatch: false,
    });
    const mcpMessage = textContent(mcpResult).replace(/^Failed to create mission: /, '');

    let cliError: unknown;
    try {
      await runMission(mode, 'create', [
        '--title', 'policy parity',
        '--existingBranchPolicy', 'replace',
      ]);
    } catch (error) {
      cliError = error;
    }

    expect(cliError).toBeInstanceOf(CliError);
    expect((cliError as CliError).message).toBe(mcpMessage);
  });

  it('passes reset to the route, omits the field by default, and keeps JSON output stable', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const paths: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      paths.push(new URL(String(input)).pathname);
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      // The dispatch route answers an admitted dispatch as the real server does.
      if (new URL(String(input)).pathname === '/api/orchestrator/dispatch') {
        return new Response(JSON.stringify({ ok: true, result: { initiated: true, async: true, missionId: 'mission-3', status: 'queued', queued: [] } }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        result: {
          missionId: `mission-${bodies.length}`,
          packets: [{ id: `pkt-${bodies.length}`, title: 'policy parity', wave: 1 }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const write = vi.mocked(process.stdout.write);

    await runMission(mode, 'create', [
      '--title', 'policy parity',
      '--existingBranchPolicy', 'reset',
      '--model', 'gateway/model-y',
      '--carrier', 'openrouter',
    ]);
    await runMission(mode, 'create', ['--title', 'route default parity']);
    await runMission(mode, 'create', ['--title', 'explicit dispatch', '--dispatch']);

    expect(bodies[0]?.existingBranchPolicy).toBe('reset');
    expect(bodies[0]).toMatchObject({
      model: 'gateway/model-y',
      carrier: 'openrouter',
    });
    expect(bodies[1]).not.toHaveProperty('existingBranchPolicy');
    expect(bodies[2]).toMatchObject({ dispatchOnCreate: true });
    expect(paths).toEqual([
      '/api/orchestrator/create-mission',
      '/api/orchestrator/create-mission',
      '/api/orchestrator/create-mission',
      '/api/orchestrator/dispatch',
    ]);
    expect(bodies[3]).toMatchObject({ missionId: 'mission-3', wait: false });
    expect(write.mock.calls.map(([value]) => String(value)).join('')).toContain(
      '"schema": "o8/cli/mission.create/v1"',
    );
  });

  it('builds governed mission creation with a recorded fresh-start policy', () => {
    const args = governedMissionCreateArgs({
      title: 'governed policy',
      body: 'body',
      repoRoot: '/repo',
      issue: 1676,
    });
    const policyFlag = args.indexOf('--existingBranchPolicy');

    expect(GOVERNED_EXISTING_BRANCH_POLICY).toBe('reset');
    expect(args.slice(policyFlag, policyFlag + 2)).toEqual([
      '--existingBranchPolicy',
      GOVERNED_EXISTING_BRANCH_POLICY,
    ]);
  });
});
