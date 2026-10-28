import { invalidateCliCache, resolveCli } from '@/lib/runtimes/shared/cli-resolver';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';
import { getRuntimeInstallInfo } from './runtime-install';
import { compareUpdateVersions, parseUpdateVersion, CLI_UPDATE_VERSION_PATTERN } from './cli-update-progress';
import { inspectCliInstallation } from './cli-installation';

export type CliUpdateStatus = 'current' | 'update-available' | 'unknown' | 'not-installed';

export interface CliUpdateRecord {
  runtimeId: string;
  label: string;
  installedVersion: string | null;
  latestVersion: string | null;
  status: CliUpdateStatus;
  updateUrl: string;
  selectedPath: string | null;
  manager?: 'npm' | 'native' | 'homebrew' | 'manual';
  updateSupported?: boolean;
  updateHint?: string;
}

type CliUpdateSpec = {
  runtimeId: string;
  label: string;
  binaryName: string;
  envOverride: string;
  extraEnvOverrides?: string[];
  versionArgs?: string[];
  release: { kind: 'npm'; packageName: string; channel?: string } | { kind: 'github'; repository: string }
    | { kind: 'claude-native'; channel: 'stable' | 'latest' }
    | { kind: 'grok-native' }
    | { kind: 'manual' }
    | { kind: 'homebrew'; package: string; packageKind: 'cask' | 'formula' };
  updateUrl: string;
};

// Compare each CLI with its own release channel. Antigravity is a separate Go
// binary; the Gemini npm package is not an Antigravity update.
const PROVIDER_UPDATE_SPECS: CliUpdateSpec[] = [
  {
    runtimeId: 'codex', label: 'Codex CLI', binaryName: 'codex',
    envOverride: 'O8_CODEX_BIN', release: { kind: 'npm', packageName: '@openai/codex' },
    updateUrl: 'https://learn.chatgpt.com/docs/codex/cli',
  },
  {
    runtimeId: 'claude-code', label: 'Claude Code', binaryName: 'claude',
    envOverride: 'O8_CLAUDE_CODE_BIN', extraEnvOverrides: ['CLAUDE_BIN'],
    release: { kind: 'npm', packageName: '@anthropic-ai/claude-code' },
    updateUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  },
  {
    runtimeId: 'grok', label: 'Grok Build', binaryName: 'grok', envOverride: 'O8_GROK_BIN',
    versionArgs: ['--no-auto-update', '--version'], release: { kind: 'npm', packageName: '@xai-official/grok' },
    updateUrl: 'https://docs.x.ai/build/cli/reference',
  },
  {
    runtimeId: 'opencode', label: 'OpenCode', binaryName: ORCHESTRATOR_RUNTIMES.opencode.binaryName,
    envOverride: 'O8_OPENCODE_BIN', release: { kind: 'npm', packageName: '@opencode-ai/cli', channel: 'next' },
    updateUrl: 'https://dev.opencode.ai/v2/docs/cli/commands/#upgrade',
  },
  {
    runtimeId: 'antigravity', label: 'Antigravity CLI', binaryName: 'agy',
    envOverride: 'O8_ANTIGRAVITY_BIN',
    release: { kind: 'github', repository: 'google-antigravity/antigravity-cli' },
    updateUrl: 'https://antigravity.google/docs/getting-started?tab=cli',
  },
  {
    runtimeId: 'gemini', label: 'Gemini CLI', binaryName: 'gemini',
    envOverride: 'O8_GEMINI_BIN', release: { kind: 'npm', packageName: '@google/gemini-cli' },
    updateUrl: 'https://github.com/google-gemini/gemini-cli',
  },
];

export const CLI_UPDATE_RUNTIME_IDS = Object.freeze([
  ...PROVIDER_UPDATE_SPECS.map(spec => spec.runtimeId),
  ...Object.entries(ORCHESTRATOR_RUNTIMES).filter(([id, capability]) => capability.dispatchable && id !== 'pi-builtin'
    && !PROVIDER_UPDATE_SPECS.some(spec => spec.runtimeId === id)).map(([id]) => id),
]);
const UPDATE_SPECS: CliUpdateSpec[] = CLI_UPDATE_RUNTIME_IDS.map(runtimeId => {
  const known = PROVIDER_UPDATE_SPECS.find(spec => spec.runtimeId === runtimeId);
  if (known) return known;
  const capability = ORCHESTRATOR_RUNTIMES[runtimeId as keyof typeof ORCHESTRATOR_RUNTIMES];
  return { runtimeId, label: capability.label, binaryName: capability.binaryName,
    envOverride: `O8_${runtimeId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_BIN`,
    release: { kind: 'manual' }, updateUrl: getRuntimeInstallInfo(runtimeId)?.link ?? '' };
});

const LATEST_TTL_MS = 6 * 60 * 60_000;
const latestCache = new Map<string, { version: string; checkedAt: number }>();

async function latestVersion(release: CliUpdateSpec['release'], refresh: boolean): Promise<string | null> {
  if (release.kind === 'manual') return null;
  const cacheKey = JSON.stringify(release);
  const cached = latestCache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.checkedAt < LATEST_TTL_MS) return cached.version;
  try {
    const url = release.kind === 'npm'
      ? `https://registry.npmjs.org/${encodeURIComponent(release.packageName)}/${release.channel ?? 'latest'}`
      : release.kind === 'github' ? `https://api.github.com/repos/${release.repository}/releases/latest`
        : release.kind === 'homebrew' ? `https://formulae.brew.sh/api/${release.packageKind}/${release.package}.json`
          : release.kind === 'grok-native' ? 'https://x.ai/cli/stable' : `https://downloads.claude.ai/claude-code-releases/${release.channel}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3_000),
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body = release.kind === 'claude-native' || release.kind === 'grok-native' ? { version: (await response.text()).trim() }
      : await response.json() as { version?: unknown; tag_name?: unknown; versions?: { stable?: unknown } };
    const rawVersion = release.kind === 'github' ? body.tag_name
      : release.kind === 'homebrew' && release.packageKind === 'formula' ? body.versions?.stable : body.version;
    const version = typeof rawVersion === 'string'
      && (release.kind !== 'npm' || /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(rawVersion))
      ? parseUpdateVersion(rawVersion) : null;
    if (version) latestCache.set(cacheKey, { version, checkedAt: Date.now() });
    return version;
  } catch {
    return null;
  }
}

export async function checkCliUpdates(refresh = false, runtimeId?: string, onTool?: (tool: CliUpdateRecord) => void): Promise<CliUpdateRecord[]> {
  return Promise.all(UPDATE_SPECS.filter((spec) => !runtimeId || spec.runtimeId === runtimeId).map(async (spec): Promise<CliUpdateRecord> => {
    let installedVersion: string | null = null;
    let selectedPath: string | null = null;
    let manager: CliUpdateRecord['manager'];
    let release = spec.release;
    try {
      // Other runtime callers may have cached only the numeric base version.
      if (spec.runtimeId === 'opencode') invalidateCliCache('opencode');
      const selected = await resolveCli({
        ...(spec.runtimeId === 'opencode' ? { versionPattern: CLI_UPDATE_VERSION_PATTERN } : {}),
        runtimeId: spec.runtimeId,
        binaryName: spec.binaryName,
        envOverride: spec.envOverride,
        extraEnvOverrides: spec.extraEnvOverrides,
        versionArgs: spec.versionArgs,
      });
      selectedPath = selected.path;
      installedVersion = parseUpdateVersion(selected.version);
      if (['codex', 'claude-code', 'grok', 'opencode', 'gemini'].includes(spec.runtimeId)) {
        const install = await inspectCliInstallation(spec.runtimeId as import('./cli-installation').StableCli, selected);
        manager = install.manager;
        if (spec.runtimeId === 'opencode' && install.npmPackage) release = { kind: 'npm', packageName: install.npmPackage, channel: install.channel ?? 'latest' };
        if (install.manager === 'homebrew') release = { kind: 'homebrew', package: install.package!, packageKind: install.packageKind! };
        if (install.manager === 'native' && spec.runtimeId === 'claude-code') release = { kind: 'claude-native', channel: install.channel === 'stable' ? 'stable' : 'latest' };
        if (install.manager === 'native' && spec.runtimeId === 'grok') release = { kind: 'grok-native' };
      }
    } catch {
      // Missing or unprobeable CLIs do not prevent the rest of the report.
    }
    const latest = selectedPath && !(spec.runtimeId === 'grok' && manager === 'manual') ? await latestVersion(release, refresh) : null;
    const status: CliUpdateStatus = !selectedPath
      ? 'not-installed'
      : !installedVersion || !latest
        ? 'unknown'
        : compareUpdateVersions(installedVersion, latest) < 0
          ? 'update-available'
          : 'current';
    const tool: CliUpdateRecord = {
      runtimeId: spec.runtimeId,
      label: spec.label,
      installedVersion,
      latestVersion: latest,
      status,
      updateUrl: spec.updateUrl,
      selectedPath,
      ...(manager ? { manager } : {}),
      updateSupported: ['codex', 'claude-code', 'grok', 'opencode', 'gemini'].includes(spec.runtimeId) && manager !== 'manual' && !(spec.runtimeId === 'grok' && manager === 'npm'),
      ...(release.kind === 'manual' || manager === 'manual' ? { updateHint: 'Use this tool’s original updater, then check its version again.' } : {}),
    };
    onTool?.(tool);
    return tool;
  }));
}
