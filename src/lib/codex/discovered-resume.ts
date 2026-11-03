import { childEnvironment } from '@/lib/providers/spawn-environment';
import 'server-only';

import { execFileSync } from '@/lib/providers/child-process';
import os from 'node:os';
import path from 'node:path';
import { mkdir, realpath, symlink } from 'node:fs/promises';

import { getRuntime } from '@/lib/runtimes/registry';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { queryCodexThreadById, resolveCodexDiscoveredSessionHome } from './sessions';

/** Keep the orchestrator's private config while making an external thread resumable. */
export async function linkDiscoveredCodexRollout(threadId: string, codexHome: string): Promise<void> {
  const source = await resolveCodexDiscoveredSessionHome(`codex:${threadId}`);
  if (!source) {
    if (await queryCodexThreadById(threadId)) {
      throw new Error('The Codex rollout could not be found. This thread would start fresh, so it was not resumed.');
    }
    return; // A private orchestrator thread need not be in the discovery database.
  }
  const destination = path.join(codexHome, path.relative(source.configHomeRef, source.rolloutPath));
  if (await realpath(destination).catch(() => null) === source.rolloutPath) return;
  await mkdir(path.dirname(destination), { recursive: true });
  // Never replace an existing rollout. A conflicting destination must be surfaced.
  await symlink(source.rolloutPath, destination, 'file');
}

export async function resumeDiscoveredCodexSession(
  sessionKey: string,
  message: string,
): Promise<{ ok: boolean; note: string; responseText: string; status: number; threadId: string }> {
  const threadId = sessionKey.replace(/^codex:/, '').replace(/^codex-discovered:/, '');
  const identityId = await getRuntime('codex')?.getSessionIdentityId?.(sessionKey);
  const providerSession = await resolveCodexDiscoveredSessionHome(
    sessionKey,
    identityId ?? undefined,
  );
  if (!providerSession || providerSession.threadId !== threadId) {
    return {
      ok: false,
      note: 'The Codex session is missing or ambiguous across registered identities, or its rollout could not be found. It was not resumed because it would start fresh.',
      responseText: '',
      status: 409,
      threadId,
    };
  }

  const codexBin = path.join(os.homedir(), '.npm-global', 'bin', 'codex');
  const args = ['exec', 'resume', threadId, message, '--json', '--dangerously-bypass-approvals-and-sandbox'];
  const probe = cliInvocation(codexBin, args);
  const stdout = execFileSync(probe.command, probe.args, {
    windowsHide: true,
    cwd: process.env.HOME || os.homedir(),
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    env: childEnvironment({ runtimeId: 'codex', env: { CODEX_HOME: providerSession.configHomeRef, FORCE_COLOR: '0', NO_COLOR: '1' } }),
    encoding: 'utf-8',
  });

  let responseText = '';
  for (const line of stdout.split('\n').filter(Boolean)) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type !== 'item.completed') continue;
      const item = event.item as { type?: string; text?: string } | undefined;
      if (item?.type === 'agent_message' && item.text) responseText += item.text;
    } catch {
      continue;
    }
  }
  return { ok: true, note: 'Sent to Codex.', responseText, status: 200, threadId };
}
