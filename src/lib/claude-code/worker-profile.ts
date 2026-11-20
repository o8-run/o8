import 'server-only';

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveOpenRouterKey } from '@/lib/cortex/qa/llm/byok-keys';
import { getDataDir } from '@/lib/data-dir-migration';
import { writeFileAtomic } from '@/lib/settings/toml';
import {
  CODEX_SUBSCRIPTION_CLAUDE_CODE_DEFAULT_MODEL,
  CLAUDE_CODE_WORKER_PROFILE_FALLBACK,
  OPENROUTER_CLAUDE_CODE_DEFAULT_MODEL,
  isClaudeCodeModelSource,
  normalizeClaudeCodeGatewayModel,
  normalizeClaudeCodeRepoSkillAllowlist,
  type ClaudeCodeWorkerProfile,
} from './worker-profile-types';

const PROFILE_VERSION = 3;
export const OPENROUTER_CLAUDE_CODE_BASE_URL = 'https://openrouter.ai/api';
export { OPENROUTER_CLAUDE_CODE_DEFAULT_MODEL } from './worker-profile-types';

type StoredProfile = ClaudeCodeWorkerProfile & { version: number };

let profileMutationQueue: Promise<void> = Promise.resolve();

function profilePath(): string {
  return path.join(getDataDir(), 'claude-code-worker.json');
}

function normalizeProfile(value: unknown): ClaudeCodeWorkerProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...CLAUDE_CODE_WORKER_PROFILE_FALLBACK };
  }
  const record = value as Record<string, unknown>;
  return {
    source: isClaudeCodeModelSource(record.source)
      ? record.source
      : CLAUDE_CODE_WORKER_PROFILE_FALLBACK.source,
    model: normalizeClaudeCodeGatewayModel(record.model),
    codexModel: normalizeClaudeCodeGatewayModel(record.codexModel),
    repoSkillAllowlist: normalizeClaudeCodeRepoSkillAllowlist(record.repoSkillAllowlist),
  };
}

export function readClaudeCodeWorkerProfileSync(): ClaudeCodeWorkerProfile {
  try {
    return normalizeProfile(JSON.parse(readFileSync(profilePath(), 'utf8')));
  } catch {
    return { ...CLAUDE_CODE_WORKER_PROFILE_FALLBACK };
  }
}

export async function writeClaudeCodeWorkerProfile(
  profile: ClaudeCodeWorkerProfile,
): Promise<ClaudeCodeWorkerProfile> {
  return enqueueProfileMutation(() => persistProfile(profile));
}

function enqueueProfileMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const pending = profileMutationQueue.then(mutation, mutation);
  profileMutationQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

async function persistProfile(profile: ClaudeCodeWorkerProfile): Promise<ClaudeCodeWorkerProfile> {
  const normalized = normalizeProfile(profile);
  const stored: StoredProfile = { version: PROFILE_VERSION, ...normalized };
  await writeFileAtomic(profilePath(), `${JSON.stringify(stored, null, 2)}\n`);
  return normalized;
}

export function selectedClaudeCodeWorkerModelSync(): string | null {
  const profile = readClaudeCodeWorkerProfileSync();
  if (profile.source === 'openrouter') {
    return profile.model ?? OPENROUTER_CLAUDE_CODE_DEFAULT_MODEL;
  }
  if (profile.source === 'codex-subscription') {
    return profile.codexModel ?? CODEX_SUBSCRIPTION_CLAUDE_CODE_DEFAULT_MODEL;
  }
  return null;
}

export function resolveClaudeCodeWorkerSelection(input: {
  carrier?: unknown;
  model?: unknown;
} = {}): { source: ClaudeCodeWorkerProfile['source']; model: string | null } {
  const profile = readClaudeCodeWorkerProfileSync();
  const source = isClaudeCodeModelSource(input.carrier) ? input.carrier : profile.source;
  const pinnedModel = normalizeClaudeCodeGatewayModel(input.model);
  if (pinnedModel) return { source, model: pinnedModel };
  if (source === 'openrouter') {
    return { source, model: profile.model ?? OPENROUTER_CLAUDE_CODE_DEFAULT_MODEL };
  }
  if (source === 'codex-subscription') {
    return { source, model: profile.codexModel ?? CODEX_SUBSCRIPTION_CLAUDE_CODE_DEFAULT_MODEL };
  }
  return { source, model: null };
}

export async function resolveClaudeCodeWorkerGatewayKey(): Promise<string | null> {
  return resolveOpenRouterKey();
}

export function buildClaudeCodeWorkerSpawnEnv(
  source: ClaudeCodeWorkerProfile['source'],
  model: string | undefined,
  credential: string | null,
  gatewayBaseUrl?: string,
): Record<string, string> {
  if (source === 'native') return {};
  const selectedModel = normalizeClaudeCodeGatewayModel(model)
    ?? (source === 'codex-subscription'
      ? CODEX_SUBSCRIPTION_CLAUDE_CODE_DEFAULT_MODEL
      : OPENROUTER_CLAUDE_CODE_DEFAULT_MODEL);
  return {
    ANTHROPIC_BASE_URL: source === 'codex-subscription'
      ? gatewayBaseUrl ?? ''
      : OPENROUTER_CLAUDE_CODE_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: credential ?? '',
    // Claude Code otherwise may prefer an inherited Anthropic API key.
    ANTHROPIC_API_KEY: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    ANTHROPIC_MODEL: selectedModel,
    ANTHROPIC_DEFAULT_FABLE_MODEL: selectedModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: selectedModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedModel,
    CLAUDE_CODE_SUBAGENT_MODEL: selectedModel,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...(source === 'codex-subscription' ? {
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
      CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '3',
      ENABLE_TOOL_SEARCH: 'false',
    } : {}),
  };
}
