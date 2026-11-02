import { readLiveClaudeRuntimeCapacity } from './live-capacity';
import { runtimeBillingMode } from '@/lib/providers/runtime-billing';
import { controlledProviderConfig, providerFromConfig } from '@/lib/runtimes/shared/owned-session/controlled-provider';
import { prepareControlledGateway } from './controlled-gateway';
import { mkdir } from 'node:fs/promises';
import { createOwnedExecutionPolicy } from '@/lib/runtimes/shared/owned-session/execution-policy';
import path from 'node:path';

import {
  buildClaudeStreamJsonArgs,
  buildClaudeStreamJsonUserPayload,
} from '@/lib/claude-code/interactive-session';
import { claudeReadOnlyLockoutArgs } from '@/lib/claude-code/read-only-args';
import {
  isReadOnlyRuntimeConfig,
  workModeRuntimeConfig,
} from '@/lib/runtimes/shared/owned-session/work-mode';
import { parseClaudeOwnedRunLog } from './owned-log';
import { createOwnedSessionStore } from '@/lib/runtimes/shared/owned-session';
import { MODEL_IDS } from '@/lib/models';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type {
  OwnedRuntimeAdapter,
} from '@/lib/runtimes/shared/owned-session/types';
import { getDataDir } from '@/lib/data-dir-migration';
import {
  buildClaudeCodeWorkerSpawnEnv,
  resolveClaudeCodeWorkerGatewayKey,
  resolveClaudeCodeWorkerSelection,
} from '@/lib/claude-code/worker-profile';
import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import type { PacketSpendCap } from '@/lib/orchestrator/metered-spend';
import type { WorkerWorkMode } from '@/lib/orchestrator/types';
import { prepareMeteredGatewaySession } from '@/lib/claude-code/metered-gateway';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { recordLaneEvent } from '@/lib/lane/events';
import {
  ClaudeCodeWorkerAuthenticationError,
  prepareClaudeCodeWorkerConfig,
  ensureCodexSubscriptionProxyReady,
} from '@/lib/claude-code/codex-subscription-proxy';

export const claudeCodeOwnedAdapter: OwnedRuntimeAdapter = {
  runtimeId: 'claude-code',
  observeCapacity: async session => ({
    ...await readLiveClaudeRuntimeCapacity({ env: { NODE_ENV: process.env.NODE_ENV, CLAUDE_CONFIG_DIR: session.identity?.configHomeRef ?? process.env.CLAUDE_CONFIG_DIR } }),
    identityId: session.identity?.id ?? null,
  }),
  surfaceIdPrefix: 'claude-code-owned:',
  rootEnvVar: 'CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT',
  rootDefault: path.join(getDataDir(), 'owned-claude-code'),
  binaryName: 'claude',
  binaryEnvOverride: 'O8_CLAUDE_CODE_BIN',
  binaryExtraEnvOverrides: ['CLAUDE_BIN'],
  isolatedConfigHomeEnv: 'CLAUDE_CONFIG_DIR',
  workerMcpInjection: 'config-file',
  extraSpawnEnv: async (session) => {
    const configuredSource = session.runtimeConfig?.modelSource;
    const source = configuredSource === 'openrouter' || configuredSource === 'codex-subscription'
      ? configuredSource
      : 'native';
    if (source === 'openrouter' && runtimeBillingMode('claude-code') !== 'api') throw new Error('Set Claude Code billing to My API key in Settings before using OpenRouter.');
    const { configDir: isolatedConfigDir, credentialEnv } = await prepareClaudeCodeWorkerConfig(session.sessionDir, source);
    // Shell scratch must use the same private grant as other runtime state,
    // not a shared system-temp directory outside the worker sandbox.
    const isolatedScratchDir = path.join(isolatedConfigDir, 'tmp');
    await mkdir(isolatedScratchDir, { recursive: true, mode: 0o700 });
    const key = source === 'openrouter' ? await resolveClaudeCodeWorkerGatewayKey() : null;
    if (source === 'openrouter' && !key) {
      throw new Error('This Claude Code worker is pinned to OpenRouter, but its API key is no longer configured. Add the key in Settings > Models > API keys before resuming it.');
    }
    if (providerFromConfig(session.runtimeConfig)) {
      const connection = await prepareControlledGateway(session, key!);
      return { ...buildClaudeCodeWorkerSpawnEnv('openrouter', session.model, connection.token, connection.baseUrl),
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1', CLAUDE_CONFIG_DIR: isolatedConfigDir,
        CLAUDE_CODE_TMPDIR: isolatedScratchDir, TMPDIR: isolatedScratchDir, ...credentialEnv,
        ANTHROPIC_BASE_URL: connection.baseUrl, ANTHROPIC_API_KEY: connection.token, ANTHROPIC_AUTH_TOKEN: '',
        CLAUDE_CODE_OAUTH_TOKEN: '' };
    }
    if (source === 'codex-subscription') {
      const connection = await ensureCodexSubscriptionProxyReady();
      return {
        ...buildClaudeCodeWorkerSpawnEnv(
          source,
          session.model,
          connection.clientToken,
          connection.baseUrl,
        ),
        CLAUDE_CONFIG_DIR: isolatedConfigDir,
        CLAUDE_CODE_TMPDIR: isolatedScratchDir,
        ...credentialEnv,
      };
    }
    const env = buildClaudeCodeWorkerSpawnEnv(source, session.model, key);
    if (source === 'openrouter') {
      const costUsd = Number(session.runtimeConfig?.spendCapCostUsd);
      const inputTokens = Number(session.runtimeConfig?.spendCapInputTokens);
      const cap: PacketSpendCap = { carrier: 'openrouter', costUsd, inputTokens };
      if (!Number.isFinite(costUsd) || costUsd <= 0 || !Number.isFinite(inputTokens) || inputTokens <= 0) {
        throw new Error('Metered worker launch refused because its packet spend cap is missing.');
      }
      env.ANTHROPIC_BASE_URL = await prepareMeteredGatewaySession(
        session,
        process.env.O8_OPENROUTER_CLAUDE_CODE_BASE_URL?.trim() || env.ANTHROPIC_BASE_URL,
        cap,
      );
    }
    env.CLAUDE_CONFIG_DIR = isolatedConfigDir;
    env.CLAUDE_CODE_TMPDIR = isolatedScratchDir;
    return { ...env, ...credentialEnv };
  },
  humanLabel: 'Owned Claude Code',
  squadShortName: 'Claude',
  sessionIdPrefix: 'claude-code-owned-',
  defaultModel: MODEL_IDS.claudeWorkerDefault,
  launchArgs: ({ model, effort, workerMcpConfigPath, runtimeConfig }) => providerFromConfig(runtimeConfig)
    ? ['--print', '--bare', '--restricted', '--tools', 'Read', '--allowedTools', 'Read',
      '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--max-turns', '4',
      '--model', model!, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      ...(workerMcpConfigPath ? ['--mcp-config', workerMcpConfigPath] : [])]
    : [
      ...buildClaudeStreamJsonArgs(model ?? null, 'bypassPermissions', null, effort),
      ...claudeReadOnlyLockoutArgs(isReadOnlyRuntimeConfig(runtimeConfig)),
      '--disable-slash-commands', ...(workerMcpConfigPath ? ['--mcp-config', workerMcpConfigPath] : []),
    ],
  launchStdin: ({ prompt }) => buildClaudeStreamJsonUserPayload(prompt),
  resumeArgs: ({ threadId, model, effort, workerMcpConfigPath, runtimeConfig }) => {
    // Owned workers must address a saved provider UUID, never a session name,
    // path, or the provider's most-recent-session fallback.
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(threadId)) {
      throw new Error('The saved Claude Code session ID is invalid. No continuation was started.');
    }
    return [
      ...buildClaudeStreamJsonArgs(model ?? null, 'bypassPermissions', threadId, effort),
      ...claudeReadOnlyLockoutArgs(isReadOnlyRuntimeConfig(runtimeConfig)),
      '--disable-slash-commands',
      ...(workerMcpConfigPath ? ['--mcp-config', workerMcpConfigPath] : []),
    ];
  },
  resumeStdin: ({ prompt }) => buildClaudeStreamJsonUserPayload(prompt),
  parseRunLog: parseClaudeOwnedRunLog,
  launchGroupLabel: 'Stream-json worker turn',
};

const claudeCodeOwnedStore = createOwnedSessionStore(claudeCodeOwnedAdapter);

export async function continueOwnedClaudeCodeSession(surfaceId: string, prompt: string) {
  return claudeCodeOwnedStore.resume(surfaceId, prompt);
}

export function invalidateOwnedClaudeCodeFleetCache(): void {
  claudeCodeOwnedStore.invalidateFleetCache();
}

export async function archiveOwnedClaudeCodeSession(surfaceId: string) {
  return claudeCodeOwnedStore.archiveSession(surfaceId);
}

export async function ownedClaudeCodeSessionState(surfaceId: string) {
  return claudeCodeOwnedStore.sessionState(surfaceId);
}

export async function sweepOrphanedClaudeCodeSessions(activeSurfaceIds: Set<string>, maxAgeMs: number, chatOwnedSurfaceIds?: ReadonlySet<string>) {
  return claudeCodeOwnedStore.sweepOrphanedSessions(activeSurfaceIds, maxAgeMs, chatOwnedSurfaceIds);
}

export async function getOwnedClaudeCodeTelemetrySources(surfaceId: string) {
  return claudeCodeOwnedStore.getTelemetrySources(surfaceId);
}

export async function launchOwnedClaudeCodeSession(request: {
  /** Recall epoch bound before assembling this launch prompt. */
  promptMemoryRevision?: string;
  cwd: string;
  controlledTask?: import('@/lib/mcp/task-execution-store').ControlledTaskBinding;
  executionPolicy?: 'single-attempt';
  controlledProvider?: import('@/lib/runtimes/shared/owned-session/controlled-provider').ControlledOpenRouterPolicy;
  prompt: string;
  clientMutationId?: string;
  model?: string;
  claudeCodeModel?: string;
  claudeCodeCarrier?: ClaudeCodeModelSource;
  effort?: ThinkingEffort;
  laneId?: string;
  packetId?: string;
  spendCap?: PacketSpendCap;
  /** Durable packet work mode; 'read-only' hardens argv and the OS sandbox. */
  workMode?: WorkerWorkMode;
}) {
  const controlledConfig = controlledProviderConfig(request.controlledProvider);
  createOwnedExecutionPolicy({ ...request, runtimeConfig: { ...controlledConfig, ...(request.workMode ? { workMode: request.workMode } : {}),
    ...(request.claudeCodeCarrier ? { modelSource: request.claudeCodeCarrier } : {}) } }, 'claude-code');
  if (request.executionPolicy !== undefined && (request.claudeCodeCarrier !== (request.controlledProvider ? 'openrouter' : 'native')
    || (request.claudeCodeModel !== undefined && request.claudeCodeModel !== request.model))) {
    throw new Error('Single-attempt Claude Code workers require explicit matching native pins.');
  }
  const selection = resolveClaudeCodeWorkerSelection({
    carrier: request.claudeCodeCarrier,
    model: request.claudeCodeModel,
  });
  const selectedModel = selection.model ?? request.model;
  const meteredDefaults = selection.source === 'openrouter' && !request.controlledProvider && !request.spendCap
    ? getOperatorDefaultsSync().values
    : null;
  const spendCap = selection.source === 'openrouter' && !request.controlledProvider
    ? request.spendCap ?? {
        carrier: 'openrouter' as const,
        costUsd: meteredDefaults!.meteredPacketCostCapUsd,
        inputTokens: meteredDefaults!.meteredPacketInputTokenCap,
      }
    : undefined;
  if (selection.source === 'openrouter' && !await resolveClaudeCodeWorkerGatewayKey()) {
    return {
      ok: false,
      runtime: 'claude-code',
      surfaceId: '',
      sideEffect: 'none' as const,
      note: 'Claude Code gateway workers require an OpenRouter API key in Settings > Models > API keys. No worker was started.',
    };
  }
  if (selection.source === 'codex-subscription') {
    try {
      await ensureCodexSubscriptionProxyReady();
    } catch (error) {
      return {
        ok: false,
        runtime: 'claude-code',
        surfaceId: '',
        sideEffect: 'none' as const,
        note: error instanceof Error ? error.message : 'The Codex subscription carrier is unavailable. No worker was started.',
      };
    }
  }
  try {
    return await claudeCodeOwnedStore.launch({
      ...request,
      model: selectedModel ?? undefined,
      runtimeConfig: {
        modelSource: selection.source, ...controlledConfig,
        ...(spendCap ? {
          spendCapCostUsd: String(spendCap.costUsd),
          spendCapInputTokens: String(spendCap.inputTokens),
        } : {}),
        // Pinned like the carrier so retry/rerun of a read-only packet keeps
        // launching read-only even if the caller forgets to re-supply it.
        ...workModeRuntimeConfig(request.workMode),
      },
    });
  } catch (error) {
    if (!(error instanceof ClaudeCodeWorkerAuthenticationError)) throw error;
    if (request.laneId) {
      recordLaneEvent(request.laneId, 'worker_not_authenticated', 'system', {
        runtime: 'claude-code',
        code: error.code,
        reason: error.reason,
        note: error.message,
      });
    }
    return {
      ok: false,
      runtime: 'claude-code',
      surfaceId: '',
      sideEffect: 'none' as const,
      note: `${error.message} No worker was started. Sign in with the operator Claude CLI, then retry the packet.`,
    };
  }
}

export async function getOwnedClaudeCodeFleetAdditions(options?: { fresh?: boolean }) {
  return claudeCodeOwnedStore.getFleetAdditions(options);
}

export async function getOwnedClaudeCodeRuntimeTail(surfaceId: string, limit?: number) {
  return claudeCodeOwnedStore.getRuntimeTail(surfaceId, limit);
}
