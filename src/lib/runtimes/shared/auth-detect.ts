import { resolveProviderKey } from '@/lib/providers/key-store';
import 'server-only';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import {
  ORCHESTRATOR_RUNTIMES,
  getRuntimeCapability,
  listDispatchableRuntimes,
  type RuntimeAuthHouse,
} from '@/lib/orchestrator/runtime-capabilities';
import { readClaudeCodeWorkerProfileSync } from '@/lib/claude-code/worker-profile';
import { requiresNativeWorkerToken } from '@/lib/claude-code/worker-token';
import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import { claudeCarrierPresentation } from './claude-carrier-presentation';
import { scanAndLink } from './cli-locate';
import { probeAntigravityLogin } from './antigravity-login-probe';
import { detectNativeClaudeAuth, type ClaudeLoginState } from './claude-login-probe';
import {
  localProviderIds,
  opencodeAuthenticatedProviders,
  opencodeCredentialProviders,
  opencodeCliProviders,
  clearOpencodeCliProbeMemo,
  opencodeCliModels,
  opencodeCliResolvesModel,
  probeOpencodeServiceVersion,
  providerHasConfiguredCredential,
  providerIdForModel,
  readOpencodeConfig,
} from './opencode-readiness';
import { hermesReadiness } from './hermes-readiness';
import { piBuiltinReadiness } from './pi-builtin-readiness';
import { detectPiUserSetup, type PiUserSetup } from '@/lib/pi/user-setup';
import { validateRuntimeModelSelection } from './model-compatibility';
import { suggestMachineAuthProfile } from './auth-profile-suggestion';
import { codexAuthEvidence } from './codex-auth-evidence';
import { connectionEvidence, localCredentialEvidence, runtimeConnection, type RuntimeConnectionEvidence } from './connection-evidence';
import { assertThreecodeWorkerModelAvailable } from '@/lib/runtimes/threecode-model-catalogue';
const CACHE_TTL_MS = 60_000;
const UNKNOWN_CLAUDE_CACHE_TTL_MS = 5_000;

export type RuntimeHouse = RuntimeAuthHouse;
export type RuntimeUnavailableReason = 'not_installed' | 'needs_auth' | 'needs_restart' | 'adapter_unavailable' | 'incompatible_model';

export interface RuntimeAuthStatus {
  house: RuntimeHouse | null;
  runtime: OrchestratorRuntime;
  installed: boolean;
  /** True when the runtime can dispatch without a model-specific readiness check. */
  ready: boolean;
  /** Credential evidence only; a keyless local runtime can be ready while this is false. */
  authenticated: boolean;
  /**
   * Claude Code only: no positive native credential evidence was found. Kept as raw
   * signal because the snapshot bakes in the stored profile carrier, while a mission
   * or persisted packet can pin a gateway carrier that does not use native auth.
   */
  nativeSignInBlocked?: boolean;
  /** Claude Code only: bounded CLI probe outcome, retained for safe constant messaging. */
  nativeLoginState?: ClaudeLoginState;
  nativeConnection?: RuntimeConnectionEvidence;
  unavailableReason: RuntimeUnavailableReason | null;
  detail: string;
  fix: string;
  checkedAt: number;
  binaryPath?: string;
  connection?: RuntimeConnectionEvidence;
  piSetup?: PiUserSetup;
}

export interface MachineAuthProfileSuggestion {
  profile: 'claude-only' | 'codex-only' | null;
  detail: string | null;
}

export interface RuntimeAuthSnapshot {
  statuses: Record<RuntimeHouse, RuntimeAuthStatus>;
  suggestedSubscriptionProfile: MachineAuthProfileSuggestion;
}

export interface DispatchableRuntimeAvailability {
  connection?: RuntimeConnectionEvidence;
  piSetup?: PiUserSetup;
  installed?: boolean;
  id: OrchestratorRuntime;
  label: string;
  available: boolean;
  unavailableReason: RuntimeUnavailableReason | null;
  detail: string;
  fix: string;
}

class DispatchPreflightError extends Error {
  public readonly code = 'dispatch_cli_auth_unavailable';
  public readonly status: RuntimeAuthStatus;

  constructor(status: RuntimeAuthStatus) {
    super(status.detail);
    this.name = 'DispatchPreflightError';
    this.status = status;
  }
}

export { DispatchPreflightError };
let cache: { snapshot: RuntimeAuthSnapshot; cachedAt: number } | null = null;
let cacheGeneration = 0;
let snapshotRefresh: { generation: number; promise: Promise<RuntimeAuthSnapshot> } | null = null;
// The OpenCode probe alone spawns 2-3 subprocesses (up to PROBE_TIMEOUT_MS each), so it gets its
// own short TTL + in-flight coalescing on top of the general CACHE_TTL_MS cache below — otherwise
// every getRuntimeAuthSnapshot() call inside a fresh main-cache window re-probes it unconditionally.
let opencodeRefresh: { promise: Promise<RuntimeAuthStatus>; refreshedAt: number } | null = null;
const OPENCODE_REFRESH_TTL_MS = 10_000;

function nowStatus(
  house: RuntimeHouse,
  runtime: OrchestratorRuntime,
  update: Omit<RuntimeAuthStatus, 'house' | 'runtime' | 'checkedAt' | 'ready' | 'fix' | 'unavailableReason'> & {
    ready?: boolean;
    fix?: string;
    unavailableReason?: RuntimeUnavailableReason | null;
  },
): RuntimeAuthStatus {
  const ready = update.ready ?? update.authenticated;
  return {
    house,
    runtime,
    checkedAt: Date.now(),
    ...update,
    connection: update.connection ?? runtimeConnection({ installed: update.installed, checkedAt: Date.now() }),
    ready,
    fix: update.fix ?? (house === 'codex' ? 'Run `codex login`.' : 'Run `claude` once to sign in.'),
    unavailableReason: update.unavailableReason
      ?? (!update.installed ? 'not_installed' : !ready ? 'needs_auth' : null),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function opencodeModelStatus(
  status: RuntimeAuthStatus,
  model: string,
  cwd?: string | null,
): Promise<RuntimeAuthStatus> {
  const providerId = providerIdForModel(model);
  if (!providerId) {
    return {
      ...status,
      authenticated: false,
      ready: false,
      unavailableReason: 'needs_auth',
      detail: 'The selected OpenCode 2 model does not identify its provider.',
      fix: 'Select an OpenCode 2 model using its provider/model identifier.',
    };
  }

  const [credentialProviders, config] = await Promise.all([
    opencodeAuthenticatedProviders(os.homedir(), status.binaryPath),
    readOpencodeConfig(os.homedir(), cwd),
  ]);
  const localProviders = localProviderIds(config);
  const authenticated = credentialProviders.has(providerId)
    || providerHasConfiguredCredential(config, providerId);
  const local = localProviders.has(providerId);
  // Absent credential evidence is unknown, not "no": OpenCode 2 keeps credentials
  // server-side, where neither the auth listing nor the credential file can see
  // them. Ask the CLI what it resolves — a model it lists is a model it will
  // dispatch, and an install with nothing connected lists nothing — but only once
  // the cheaper local evidence has come up empty.
  const cliResolves = !authenticated
    && !local
    && await opencodeCliResolvesModel(status.binaryPath, model);
  const ready = authenticated || local || cliResolves;
  return {
    ...status,
    authenticated,
    ready,
    unavailableReason: ready ? null : 'needs_auth',
    detail: authenticated
      ? `OpenCode 2 provider "${providerId}" has credential evidence.`
      : local
        ? `OpenCode 2 provider "${providerId}" is configured for local dispatch.`
      : cliResolves
        ? `OpenCode 2 lists model "${model.trim()}" as one it can resolve.`
        : `OpenCode 2 provider "${providerId}" has no credential evidence and is not configured for local dispatch.`,
    fix: ready
      ? 'No action needed.'
      : `Sign in to the OpenCode 2 provider "${providerId}" or configure that provider with a local baseURL.`,
  };
}

async function detectCodex(): Promise<RuntimeAuthStatus> {
  const binaryPath = scanAndLink('codex') ?? undefined;
  if (!binaryPath) return nowStatus('codex', 'codex', {
    installed: false, authenticated: false, detail: 'Codex CLI is not installed.',
    fix: 'Install Codex, then run `codex login`.',
  });
  const evidence = await codexAuthEvidence(binaryPath);
  return nowStatus('codex', 'codex', {
    installed: true, ...evidence, binaryPath,
    detail: evidence.authenticated
      ? 'Codex CLI has credential evidence. Provider access has not been checked.'
      : evidence.connection.state === 'not_connected' ? 'Codex CLI reports it is not signed in.'
      : 'Codex CLI is installed but its sign-in state could not be verified.',
  });
}

/**
 * Which carrier supplies the Claude Code worker's credential. A worker routed through
 * the OpenRouter gateway or the Codex subscription proxy does not use the native CLI
 * login at all, so a logged-out native CLI must never mark the runtime undispatchable.
 */
function claudeWorkerCarrier(): ClaudeCodeModelSource {
  try {
    return readClaudeCodeWorkerProfileSync().source;
  } catch {
    return 'native';
  }
}

async function detectClaude(binaryPath = scanAndLink('claude') ?? undefined): Promise<RuntimeAuthStatus> {
  if (!binaryPath) {
    return nowStatus('claude', 'claude-code', {
      installed: false,
      authenticated: false,
      detail: 'Claude Code CLI is not installed.',
      fix: 'Install Claude Code, then run `claude` once to sign in.',
    });
  }

  const carrier = claudeWorkerCarrier();
  const { authenticated, loginState, source } = await detectNativeClaudeAuth(binaryPath);
  // Native launch is fail-closed: an inconclusive probe without an environment or
  // stored OAuth credential is not positive authentication evidence. Gateway carriers
  // remain ready because their launch path never consumes the native credential.
  const nativeSignInBlocked = !authenticated;
  const nativeConnection = connectionEvidence(authenticated ? ['Anthropic'] : [], [
    { source: source ?? 'cli_report', outcome: authenticated ? 'present' : loginState === 'logged_out' ? 'absent' : 'unknown' },
  ]);

  return nowStatus('claude', 'claude-code', {
    installed: true,
    authenticated,
    nativeSignInBlocked,
    nativeLoginState: loginState,
    nativeConnection,
    connection: carrier === 'native' ? nativeConnection : connectionEvidence(
      [carrier === 'openrouter' ? 'OpenRouter' : 'OpenAI'], [{ source: 'runtime_config', outcome: 'configured' }]),
    // Details are short constants: probe stdout never reaches an operator-facing string.
    ...claudeCarrierPresentation(carrier, authenticated, nativeSignInBlocked, loginState),
    binaryPath,
  });
}

/**
 * Re-derive the cached Claude status for an effective carrier.
 *
 * The snapshot is computed against the *stored* worker profile, but a mission or a
 * persisted packet can pin `openrouter` / `codex-subscription` for this dispatch only.
 * Without this, a logged-out native CLI refuses a worker that never touches it.
 * Only the claude house is touched, and only when the runtime is installed.
 */
function claudeSnapshotForCarrier(
  snapshot: RuntimeAuthSnapshot,
  carrier: ClaudeCodeModelSource | null | undefined,
): RuntimeAuthSnapshot {
  const status = snapshot.statuses.claude;
  // Deliberately unconditional when a carrier is supplied: comparing against the
  // stored profile would re-couple this to the cached snapshot's staleness, and the
  // recompute is pure, so an effective carrier equal to the stored one is a no-op.
  if (!carrier || !status?.installed) return snapshot;
  const presentation = claudeCarrierPresentation(
    carrier,
    status.authenticated,
    status.nativeSignInBlocked === true,
    status.nativeLoginState,
  );
  const claude: RuntimeAuthStatus = {
    ...status,
    ...presentation,
    connection: carrier === 'native' ? status.nativeConnection : connectionEvidence(
      [carrier === 'openrouter' ? 'OpenRouter' : 'OpenAI'], [{ source: 'runtime_config', outcome: 'configured' }], status.checkedAt),
    unavailableReason: presentation.ready ? null : 'needs_auth',
  };
  return { ...snapshot, statuses: { ...snapshot.statuses, claude } };
}

async function detectOpencode(): Promise<RuntimeAuthStatus> {
  const binaryPath = scanAndLink('opencode2') ?? undefined;
  if (!binaryPath) {
    return nowStatus('opencode', 'opencode', {
      installed: false,
      authenticated: false,
      detail: 'OpenCode 2 CLI is not installed.',
      fix: 'Install `@opencode-ai/cli@next`, then sign in or configure a local provider.',
    });
  }

  const [storedProviders, reportedProviders, config, serviceVersion, cliModels] = await Promise.all([
    opencodeCredentialProviders(os.homedir()),
    opencodeCliProviders(binaryPath),
    readOpencodeConfig(os.homedir()),
    probeOpencodeServiceVersion(binaryPath),
    opencodeCliModels(binaryPath),
  ]);
  const credentialProviders = new Set([...storedProviders, ...(reportedProviders ?? [])]);
  const authenticated = credentialProviders.size > 0;
  const localProviders = localProviderIds(config);
  const localProviderConfigured = localProviders.size > 0;
  const connection = connectionEvidence([...credentialProviders, ...localProviders,
    ...[...(cliModels ?? [])].map(providerIdForModel).filter((id): id is string => Boolean(id))], [
    { source: 'cli_report', outcome: reportedProviders?.size || cliModels?.size ? 'present' : 'unknown' },
    { source: 'runtime_config', outcome: localProviderConfigured ? 'configured' : 'unknown' },
    { source: 'credential_store', outcome: storedProviders.size ? 'present' : 'unknown' },
  ]);
  if (serviceVersion.state === 'version_skew') {
    return nowStatus('opencode', 'opencode', {
      installed: true,
      authenticated, connection,
      ready: false,
      unavailableReason: 'needs_restart',
      detail: `OpenCode 2 CLI ${serviceVersion.cliVersion} does not match resident service ${serviceVersion.serviceVersion}.`,
      fix: 'Run `opencode2 service restart` so the resident service matches the installed CLI.',
      binaryPath,
    });
  }
  if (serviceVersion.state === 'incompatible') {
    return nowStatus('opencode', 'opencode', {
      installed: true,
      authenticated, connection,
      ready: false,
      unavailableReason: 'needs_restart',
      detail: 'OpenCode 2 has a running resident service that did not return a compatible health response.',
      fix: 'Run `opencode2 service restart` before dispatching OpenCode 2.',
      binaryPath,
    });
  }
  // A listing that names anything is dispatch evidence for the same reason the
  // per-model gate trusts it, and it replaces a hardcoded keyless-model list that
  // went stale the moment the free tier changed.
  const cliDispatchable = Boolean(cliModels?.size);
  const ready = authenticated || cliDispatchable || localProviderConfigured;
  return nowStatus('opencode', 'opencode', {
    installed: true,
    authenticated, connection,
    ready,
    detail: authenticated
      ? 'OpenCode 2 CLI is installed and has provider credential evidence.'
      : cliDispatchable
        ? 'OpenCode 2 CLI is installed and lists models it can resolve.'
      : localProviderConfigured
        ? 'OpenCode 2 CLI is installed and has a configured local provider; select one of that provider\'s models to dispatch.'
        : 'OpenCode 2 CLI is installed but has no credential evidence or configured local provider.',
    fix: ready
      ? 'No action needed.'
      : 'Run `opencode2 auth login` or configure a provider with a local baseURL.',
    binaryPath,
  });
}

/**
 * Runs detectOpencode() at most once per OPENCODE_REFRESH_TTL_MS, coalescing any callers that
 * land inside an in-flight probe onto the same promise instead of spawning another one.
 */
function refreshOpencodeStatus(): Promise<RuntimeAuthStatus> {
  const now = Date.now();
  if (opencodeRefresh && now - opencodeRefresh.refreshedAt < OPENCODE_REFRESH_TTL_MS) {
    return opencodeRefresh.promise;
  }
  const promise = detectOpencode();
  opencodeRefresh = { promise, refreshedAt: now };
  promise.catch(() => {
    if (opencodeRefresh?.promise === promise) {
      opencodeRefresh = null;
    }
  });
  return promise;
}

async function detectPi(): Promise<RuntimeAuthStatus> {
  const piSetup = await detectPiUserSetup();
  const binaryPath = piSetup.binaryPath;
  const authenticated = Boolean(binaryPath && (
    resolveProviderKey('ANTHROPIC_API_KEY')
    || resolveProviderKey('OPENAI_API_KEY')
    || resolveProviderKey('GEMINI_API_KEY')
    || piSetup.credentialsPresent
  ));
  return nowStatus('pi', 'pi', {
    installed: Boolean(binaryPath),
    authenticated,
    connection: localCredentialEvidence([resolveProviderKey('ANTHROPIC_API_KEY') ? 'Anthropic' : '', resolveProviderKey('OPENAI_API_KEY') ? 'OpenAI' : '', resolveProviderKey('GEMINI_API_KEY') ? 'Google' : ''].filter(Boolean), authenticated),
    detail: !binaryPath
      ? process.platform === 'win32' ? 'Existing Pi setup detection is not available on Windows yet.' : 'Worker runtime "pi" is not installed. The built-in Pi worker that ships with o8 is runtime "pi-builtin".'
      : authenticated
      ? 'Pi CLI is installed and has provider credentials.'
      : 'Pi CLI is installed but no provider credentials were found.',
    fix: !binaryPath ? 'Install Pi, then configure a provider with `pi`.' : 'Run `pi` and configure a provider before dispatching.',
    binaryPath,
    piSetup,
  });
}

async function detectDeclarativeRuntime(runtime: OrchestratorRuntime): Promise<RuntimeAuthStatus> {
  const capability = getRuntimeCapability(runtime);
  const manifest = capability.declarative;
  const house = capability.authHouse;
  if (!manifest || !house) {
    throw new Error(`Runtime ${runtime} has no declarative auth manifest.`);
  }
  const envToken = runtime.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  const binaryPath = scanAndLink(capability.binaryName)
    ?? process.env[`O8_${envToken}_BIN`]?.trim()
    ?? undefined;
  if (!binaryPath) {
    return nowStatus(house, runtime, {
      installed: false,
      authenticated: false,
      detail: `${capability.label} CLI is not installed.`,
      fix: manifest.authFix,
    });
  }

  const authenticated = manifest.authEnvVars.some((name) => Boolean(process.env[name]?.trim()))
    || (await Promise.all(manifest.authPaths.map((relativePath) => fileExists(path.join(os.homedir(), relativePath))))).some(Boolean);
  return nowStatus(house, runtime, {
    installed: true,
    authenticated,
    detail: authenticated
      ? `${capability.label} CLI is installed and has local credential evidence.`
      : `${capability.label} CLI is installed but no local credential evidence was found.`,
    fix: manifest.authFix,
    binaryPath,
  });
}

export function detectRuntimeAuthStatus(runtime: OrchestratorRuntime, deadlineAt?: number): Promise<RuntimeAuthStatus> {
  switch (runtime) {
    case 'codex': return detectCodex();
    case 'claude-code': return detectClaude();
    case 'antigravity': return probeAntigravityLogin(deadlineAt).then(status => nowStatus('antigravity', 'antigravity', status));
    case 'opencode': return detectOpencode();
    case 'pi': return detectPi();
    case 'hermes': return hermesReadiness().then(status => nowStatus('hermes', 'hermes', status));
    case 'pi-builtin': return piBuiltinReadiness().then(status => nowStatus('pi-builtin', 'pi-builtin', status));
    default: return detectDeclarativeRuntime(runtime);
  }
}

export function invalidateRuntimeAuthCache(): void {
  cacheGeneration += 1;
  cache = null;
  snapshotRefresh = null;
  opencodeRefresh = null;
  // The CLI listings are memoized a level down (#2195); an operator login has to
  // clear that with everything else, or the refusal it just fixed would persist.
  clearOpencodeCliProbeMemo();
}

async function refreshNativeWorkerReadiness(snapshot: RuntimeAuthSnapshot): Promise<RuntimeAuthSnapshot> {
  const binaryPath = snapshot.statuses.claude.binaryPath;
  if (!requiresNativeWorkerToken() || !binaryPath) return snapshot;
  // The operator login runs in another process and cannot invalidate this cache.
  // Re-read only its encrypted credential, never the native CLI or other providers.
  const statuses = { ...snapshot.statuses, claude: await detectClaude(binaryPath) };
  return { statuses, suggestedSubscriptionProfile: suggestMachineAuthProfile(statuses) };
}

export async function getRuntimeAuthSnapshot(): Promise<RuntimeAuthSnapshot> {
  await (await import('@/lib/cortex/qa/llm/byok-keys')).resolveOpenRouterKey();
  while (true) {
    const generation = cacheGeneration;
    const cached = cache;
    const cacheTtlMs = cached?.snapshot.statuses.claude.nativeLoginState === 'unknown'
      ? UNKNOWN_CLAUDE_CACHE_TTL_MS
      : CACHE_TTL_MS;
    if (cached && Date.now() - cached.cachedAt < cacheTtlMs) {
      const opencode = await refreshOpencodeStatus();
      const snapshot = await refreshNativeWorkerReadiness({
        ...cached.snapshot,
        statuses: { ...cached.snapshot.statuses, opencode },
      });
      if (generation !== cacheGeneration || cache !== cached) continue;
      cache = { snapshot, cachedAt: cached.cachedAt };
      return snapshot;
    }
    // The dashboard has several consumers of operator defaults. On a cold
    // launch they can arrive before the first auth snapshot fills the cache.
    // Coalesce that miss so one runtime probe set serves every caller instead
    // of spawning the same CLI checks once per request.
    let refresh = snapshotRefresh;
    if (!refresh || refresh.generation !== generation) {
      const promise = Promise.all(listDispatchableRuntimes().map(async (runtime) => {
        const house = getRuntimeCapability(runtime).authHouse;
        if (!house) throw new Error(`Dispatchable runtime ${runtime} has no auth house.`);
        if (runtime === 'opencode') {
          return [house, await refreshOpencodeStatus()] as const;
        }
        return [house, await detectRuntimeAuthStatus(runtime)] as const;
      })).then((entries) => {
        const statuses = Object.fromEntries(entries) as Record<RuntimeHouse, RuntimeAuthStatus>;
        return {
          statuses,
          suggestedSubscriptionProfile: suggestMachineAuthProfile(statuses),
        };
      });
      refresh = { generation, promise };
      snapshotRefresh = refresh;
    }
    const snapshot = await refreshNativeWorkerReadiness(await refresh.promise);
    if (generation !== cacheGeneration) continue;
    if (snapshotRefresh === refresh) snapshotRefresh = null;
    cache = { snapshot, cachedAt: Date.now() };
    return snapshot;
  }
}

/** Re-evaluate Claude readiness for the carrier a concrete surface will launch. */
export async function getRuntimeAuthSnapshotForClaudeCarrier(
  carrier: ClaudeCodeModelSource,
): Promise<RuntimeAuthSnapshot> {
  return claudeSnapshotForCarrier(await getRuntimeAuthSnapshot(), carrier);
}

function houseForRuntime(runtime: OrchestratorRuntime): RuntimeHouse | null {
  return getRuntimeCapability(runtime).authHouse;
}

export async function getDispatchableRuntimeAvailability(
  authSnapshot?: RuntimeAuthSnapshot,
): Promise<DispatchableRuntimeAvailability[]> {
  const [snapshot, runtimeRegistry] = await Promise.all([
    authSnapshot ?? getRuntimeAuthSnapshot(),
    import('@/lib/runtimes'),
  ]);

  return listDispatchableRuntimes().map((id) => {
    const adapter = runtimeRegistry.getRuntime(id);
    if (!adapter?.capabilities.launch) {
      return {
        id,
        label: ORCHESTRATOR_RUNTIMES[id].label,
        available: false,
        unavailableReason: 'adapter_unavailable' as const,
        detail: `${ORCHESTRATOR_RUNTIMES[id].label} does not have a launch-capable runtime adapter.`,
        fix: 'Install a build of o8 that includes this runtime adapter.',
      };
    }

    const house = houseForRuntime(id);
    const status = house ? snapshot.statuses[house] : null;
    const available = Boolean(status?.installed && (status.ready ?? status.authenticated));
    return {
      id,
      label: ORCHESTRATOR_RUNTIMES[id].label,
      installed: status?.installed ?? false,
      connection: runtimeConnection(status),
      available,
      unavailableReason: available ? null : status?.unavailableReason ?? 'adapter_unavailable',
      detail: status?.detail ?? `${ORCHESTRATOR_RUNTIMES[id].label} readiness could not be determined.`,
      fix: status?.fix ?? 'Check the runtime installation and credentials.',
      ...(status?.piSetup ? { piSetup: status.piSetup } : {}),
    };
  });
}

export async function assertRuntimeDispatchable(
  runtime: OrchestratorRuntime,
  model?: string | null,
  cwd?: string | null,
  /**
   * The carrier this specific dispatch will use, when the caller knows it. Missions and
   * persisted packets pin a carrier that can differ from the stored worker profile; a
   * caller that does not know one keeps the stored-profile answer.
   */
  options?: { claudeCodeCarrier?: ClaudeCodeModelSource | null },
): Promise<void> {
  if (runtime === '3code' && model?.trim()) {
    await assertThreecodeWorkerModelAvailable(model);
  }
  const snapshot = runtime === 'claude-code'
    ? options?.claudeCodeCarrier
      ? await getRuntimeAuthSnapshotForClaudeCarrier(options.claudeCodeCarrier)
      : await getRuntimeAuthSnapshot()
    : await getRuntimeAuthSnapshot();
  const availability = (await getDispatchableRuntimeAvailability(snapshot)).find((entry) => entry.id === runtime);
  const house = houseForRuntime(runtime);
  const status = house ? snapshot.statuses[house] : null;
  if (
    runtime === 'opencode'
    && status?.unavailableReason === 'needs_restart'
    && availability?.unavailableReason !== 'adapter_unavailable'
  ) {
    throw new DispatchPreflightError(status);
  }
  if (
    runtime === 'opencode'
    && model?.trim()
    && status?.installed
    && availability?.unavailableReason !== 'adapter_unavailable'
  ) {
    const modelStatus = await opencodeModelStatus(status, model, cwd);
    if (modelStatus.ready) return;
    throw new DispatchPreflightError(modelStatus);
  }
  if (availability?.available) {
    const compatibilityError = validateRuntimeModelSelection(runtime, model, 'Selected');
    if (compatibilityError) {
      throw new DispatchPreflightError({
        ...(status ?? {
          house,
          runtime,
          installed: true,
          authenticated: true,
          checkedAt: Date.now(),
          binaryPath: undefined,
        }),
        ready: false,
        unavailableReason: 'incompatible_model',
        detail: compatibilityError,
        fix: 'Open Settings > Models > Runtime routing to choose a supported model or clear the model pin.',
      });
    }
    return;
  }

  throw new DispatchPreflightError(status ?? {
    house,
    runtime,
    installed: false,
    ready: false,
    authenticated: false,
    unavailableReason: availability?.unavailableReason ?? 'adapter_unavailable',
    detail: availability?.detail ?? `Runtime "${runtime}" is not dispatchable.`,
    fix: availability?.fix ?? 'Choose an available runtime.',
    checkedAt: Date.now(),
  });
}
