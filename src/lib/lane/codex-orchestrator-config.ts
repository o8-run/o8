import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { serializeCodexMcpServers, toCodexServersMap } from '@/lib/mcp/tool-spine/emit-codex';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import { MODEL_IDS } from '@/lib/models';
import type { OrchestratorMcpServersConfig } from './orchestrator-mcp-config';
import { normalizeRepoPath, orchestratorDataDir, repoHash } from './orchestrator-session-core';

const USER_CODEX_HOME = join(homedir(), '.codex');
const USER_CODEX_CONFIG_PATH = join(USER_CODEX_HOME, 'config.toml');
const USER_CODEX_MODELS_CACHE_PATH = join(USER_CODEX_HOME, 'models_cache.json');
const CODEX_ORCHESTRATOR_HOME_DIR = orchestratorDataDir('codex-orchestrator');

export interface PreparedCodexHome {
  codexHome: string;
  model: string;
  note: string | null;
}

function stripInheritedMcpSections(configToml: string): string {
  if (!configToml.trim()) return '';
  try {
    const retained = parse(configToml) as Record<string, unknown>;
    delete retained.mcp_servers;
    return stringify(retained).trimEnd();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to isolate inherited MCP configuration: ${detail}`, { cause: error });
  }
}

export function stripPluginSections(configToml: string): string {
  if (!configToml.trim()) return '';
  const retained = parse(configToml) as Record<string, unknown>;
  delete retained.marketplaces;
  delete retained.plugins;
  return stringify(retained).trimEnd();
}

export function mergeCodexMcpConfig(baseConfigToml: string, servers: OrchestratorMcpServersConfig): string {
  const retainedConfig = stripInheritedMcpSections(baseConfigToml);
  const mcpConfig = serializeCodexMcpServers(servers);
  return `${[retainedConfig, mcpConfig].filter(Boolean).join('\n\n')}\n`;
}

function cachedCodexModelIds(): string[] | null {
  if (!existsSync(USER_CODEX_MODELS_CACHE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(USER_CODEX_MODELS_CACHE_PATH, 'utf8')) as {
      models?: Array<{ slug?: unknown }>;
    };
    if (!Array.isArray(parsed.models)) return null;
    return parsed.models
      .map((model) => typeof model.slug === 'string' ? model.slug.trim() : '')
      .filter(Boolean);
  } catch {
    return null;
  }
}

export function resolveCachedCodexOrchestratorModel(requestedModel: string): {
  model: string;
  note: string | null;
} {
  if (requestedModel !== MODEL_IDS.raw.openAiGpt6Astra) {
    return { model: requestedModel, note: null };
  }
  const cachedModelIds = cachedCodexModelIds();
  if (cachedModelIds === null || cachedModelIds.includes(requestedModel)) {
    return { model: requestedModel, note: null };
  }
  const model = MODEL_IDS.raw.openAiGpt56Sol;
  return {
    model,
    note: `Host models cache does not list ${requestedModel}; using ${model} for this Codex orchestrator launch.`,
  };
}

function pinCodexOrchestratorModel(
  configToml: string,
  model: string,
  note: string | null,
): string {
  const lines = configToml.replace(/\r\n/g, '\n').split('\n');
  const nextLines: string[] = [];
  let topLevel = true;
  let wroteModel = false;
  const writeModel = () => {
    if (wroteModel) return;
    if (note) nextLines.push(`# o8: ${note}`);
    nextLines.push(`model = ${JSON.stringify(model)}`);
    wroteModel = true;
  };

  for (const line of lines) {
    if (topLevel && /^\s*\[/.test(line)) {
      writeModel();
      if (nextLines.length && nextLines[nextLines.length - 1] !== '') nextLines.push('');
      topLevel = false;
    }
    if (topLevel && /^\s*model\s*=/.test(line)) {
      writeModel();
      continue;
    }
    nextLines.push(line);
  }
  if (!wroteModel) writeModel();
  return `${nextLines.join('\n').trimEnd()}\n`;
}

function syncCodexAuthFiles(codexHome: string): void {
  for (const fileName of ['auth.json', 'installation_id', 'version.json']) {
    const sourcePath = join(USER_CODEX_HOME, fileName);
    if (!existsSync(sourcePath)) continue;
    const destPath = join(codexHome, fileName);
    copyFileSync(sourcePath, destPath);
    if (fileName === 'auth.json') chmodSync(destPath, 0o600);
  }
}

export function prepareCodexHome(
  repoPath: string,
  profile: ToolProfile = 'full',
  requestedModel: string = MODEL_IDS.codexDefault,
  threadId?: string | null,
): PreparedCodexHome {
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const threadSuffix = threadId ? `-${createHash('sha256').update(threadId).digest('hex').slice(0, 12)}` : '';
  const suffix = `${profile === 'full' ? '' : `-${profile}`}${threadSuffix}`;
  const codexHome = join(CODEX_ORCHESTRATOR_HOME_DIR, `${repoHash(normalizedRepoPath)}${suffix}`);
  mkdirSync(codexHome, { recursive: true });
  const resolved = resolveCachedCodexOrchestratorModel(requestedModel);
  const userConfigToml = existsSync(USER_CODEX_CONFIG_PATH)
    ? stripPluginSections(readFileSync(USER_CODEX_CONFIG_PATH, 'utf8'))
    : '';
  const mergedConfig = pinCodexOrchestratorModel(
    mergeCodexMcpConfig(
      userConfigToml,
      toCodexServersMap(buildToolRegistry(normalizedRepoPath, { profile, threadId })),
    ),
    resolved.model,
    resolved.note,
  );
  const configPath = join(codexHome, 'config.toml');
  writeFileSync(configPath, mergedConfig, { encoding: 'utf8', mode: 0o600 });
  chmodSync(configPath, 0o600);
  syncCodexAuthFiles(codexHome);
  return { codexHome, ...resolved };
}

export function ensureCodexHome(repoPath: string, profile: ToolProfile = 'full'): string {
  return prepareCodexHome(repoPath, profile).codexHome;
}

/** The operator's own Codex home, where the Codex app reads its threads. */
export function userCodexHome(): string {
  return USER_CODEX_HOME;
}

function configuredNames(table: unknown): string[] {
  return table && typeof table === 'object' && !Array.isArray(table) ? Object.keys(table) : [];
}

/**
 * Per-thread config for a Codex app-server turn in the operator's own Codex home
 * (#3573). Codex merges these overrides into config.toml instead of replacing
 * tables, so the operator's own MCP servers and plugins are switched off by name,
 * matching the private home that prepareCodexHome() builds. One nested object:
 * mixing dotted keys with a table override is applied in no fixed order.
 */
export function codexAppThreadConfig(
  repoPath: string,
  profile: ToolProfile = 'full',
  threadId?: string | null,
): Record<string, unknown> {
  const userConfig = existsSync(USER_CODEX_CONFIG_PATH)
    ? parse(readFileSync(USER_CODEX_CONFIG_PATH, 'utf8')) as Record<string, unknown>
    : {};
  const off = (table: unknown) => Object.fromEntries(configuredNames(table).map((name) => [name, { enabled: false }]));
  return {
    mcp_servers: {
      ...off(userConfig.mcp_servers),
      ...toCodexServersMap(buildToolRegistry(normalizeRepoPath(repoPath), { profile, threadId })),
    },
    plugins: off(userConfig.plugins),
    tools: { image_generation: false },
  };
}
