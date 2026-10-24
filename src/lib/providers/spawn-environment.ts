import { workerParentEnvironment } from './worker-environment';
import { deferredMcpArgumentsForCheck } from './deferred-mcp-arguments';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { getDataDir } from '@/lib/data-dir-migration';
import { credentialPolicyFingerprint } from './credential-policy';
import { PROVIDER_ENV_KEYS, PROVIDER_KEY_ALIASES, providerCredentialMaterials, resolveProviderKey, type ProviderCredentialMaterials } from './key-store';
import { matchesProviderCredential } from './credential-materials';
import { runtimeBillingMode } from './runtime-billing';
import { ensureLaunchPolicy } from './launch-policy';
import { ORCHESTRATOR_RUNTIMES } from '@/lib/orchestrator/runtime-capabilities';

const permitsApiCredentials = (runtimeId: string | undefined): boolean => Boolean(runtimeId && runtimeId !== 'codex'
  && (Object.hasOwn(ORCHESTRATOR_RUNTIMES, runtimeId) || runtimeId === 'openclaw') && runtimeBillingMode(runtimeId) === 'api');

// These aliases have no provider identity. Resolve the selected provider; never trust their literal value.
const SCOPED_ALIASES: Record<string, string> = { O8_FABLE_ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY' };
const GENERIC_ALIASES = ['LLM_API_KEY', 'GOOSE_API_KEY', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN'];
export function providerCredentialName(name: string): boolean {
  return Object.hasOwn(SCOPED_ALIASES, name) || GENERIC_ALIASES.includes(name) || (PROVIDER_ENV_KEYS as readonly string[]).includes(name) || Object.values(PROVIDER_KEY_ALIASES).some(aliases => aliases.includes(name));
}
function genericProvider(input: Record<string, string | undefined>, alias: string): string | null {
  const selected = alias === 'GOOSE_API_KEY' ? input.GOOSE_PROVIDER
    : alias.startsWith('COPILOT_PROVIDER_') ? input.COPILOT_PROVIDER_TYPE : input.LLM_PROVIDER;
  const providers: Record<string, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY', google: 'GEMINI_API_KEY', gemini: 'GEMINI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', groq: 'GROQ_API_KEY' };
  const provider = selected?.toLowerCase();
  return provider && Object.hasOwn(providers, provider) ? providers[provider] : null;
}

export function providerCanonicalName(input: Record<string, string | undefined>, name: string): string | null {
  if (Object.hasOwn(SCOPED_ALIASES, name)) return SCOPED_ALIASES[name];
  if (GENERIC_ALIASES.includes(name)) return genericProvider(input, name);
  return Object.entries(PROVIDER_KEY_ALIASES).find(([, aliases]) => aliases.includes(name))?.[0] ?? (providerCredentialName(name) ? name : null);
}

export type SpawnOptions = { inject?: boolean; clearInherited?: boolean; runtimeId?: string; runtimeLaunch?: boolean; onlyExisting?: boolean; omitEnv?: readonly string[] };
type Context = SpawnOptions & { deniedValues?: readonly string[]; policy?: string; transport?: Record<string, string>; brokerKey?: string };
const contexts = new WeakMap<object, Context>();
const observedSecrets = new Set<string>();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function credentialMaterials(input: Record<string, string | undefined>, allowed: ReadonlySet<string> = new Set()): ProviderCredentialMaterials {
  const saved = providerCredentialMaterials();
  for (const value of saved.values) observedSecrets.add(value);
  for (const [name, value] of Object.entries(process.env)) if (providerCredentialName(name) && value?.trim()) observedSecrets.add(value.trim());
  const secrets = new Set(observedSecrets);
  for (const [name, value] of Object.entries(input)) if (providerCredentialName(name) && value?.trim()) secrets.add(value.trim());
  const hashes = new Set(saved.hashes);
  for (const value of allowed) hashes.delete(digest(value));
  return { ...saved, hashes, values: [...secrets].filter(value => !allowed.has(value)) };
}
function resolvedEnvironment(input: Record<string, string | undefined>, inject: boolean, options: Context): Record<string, string> & Pick<NodeJS.ProcessEnv, 'NODE_ENV'> {
  const aliases = [...Object.values(PROVIDER_KEY_ALIASES).flat(), ...GENERIC_ALIASES, ...Object.keys(SCOPED_ALIASES)];
  const canonical = new Set<string>([...PROVIDER_ENV_KEYS, ...Object.keys(input).filter(name => providerCredentialName(name) && !aliases.includes(name))]);
  const credentials = new Set([...canonical, ...aliases]);
  const materials = credentialMaterials(input);
  const env = Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined && !credentials.has(entry[0]) && entry[0] !== 'O8_MASTER_KEY'
    && !matchesProviderCredential(entry[1], materials)));
  if (options.clearInherited) for (const name of credentials) env[name] = '';
  if (inject) {
    for (const name of canonical) {
      if (options.onlyExisting && !(name in input) && !PROVIDER_KEY_ALIASES[name]?.some(alias => alias in input)) continue;
      if (options.onlyExisting && input[name] === '') { env[name] = ''; continue; }
      const value = resolveProviderKey(name, input);
      if (value) {
        env[name] = value;
        for (const alias of PROVIDER_KEY_ALIASES[name] ?? []) if (!options.onlyExisting || alias in input) env[alias] = value;
      }
    }
    for (const alias of [...GENERIC_ALIASES, ...Object.keys(SCOPED_ALIASES)]) if (alias in input) {
      if (input[alias] === '') { env[alias] = ''; continue; }
      const provider = SCOPED_ALIASES[alias] ?? genericProvider(input, alias);
      const value = provider ? resolveProviderKey(provider, { ...input, [provider]: input[provider] || input[alias] }) : null;
      if (value) env[alias] = value;
    }
  }
  if (inject) {
    const allowed = new Set([...credentials].map(name => env[name]).filter(Boolean));
    const denied = credentialMaterials(input, allowed);
    for (const [name, value] of Object.entries(input)) if (value && !credentials.has(name) && name !== 'O8_MASTER_KEY' && !matchesProviderCredential(value, denied)) env[name] = value;
  }
  const mode = input.NODE_ENV;
  const result = { ...env, NODE_ENV: mode === 'development' || mode === 'test' ? mode : 'production' } as Record<string, string> & Pick<NodeJS.ProcessEnv, 'NODE_ENV'>;
  for (const name of options.omitEnv ?? []) delete result[name];
  contexts.set(result, { ...options, deniedValues: [...new Set([...(options.deniedValues ?? []), ...Object.entries(input).filter(([name, value]) => providerCredentialName(name) && value?.trim()).map(([, value]) => value!.trim())])], policy: options.runtimeId ? credentialPolicyFingerprint(options.runtimeId) : undefined });
  return result;
}

/** Runtime launches fail closed without a runtime identity and saved API opt-in. */
export function providerSpawnEnvironment(input: Record<string, string | undefined>, options: SpawnOptions = {}): ReturnType<typeof resolvedEnvironment> {
  return childEnvironment({ ...options, env: input, inherit: false });
}

/** MCP provider slots follow the billing policy of their owning runtime. */
export function providerMcpEnvironment(input: Record<string, string | undefined>, runtimeId?: string): ReturnType<typeof resolvedEnvironment> {
  return providerSpawnEnvironment(input, { onlyExisting: true, runtimeId: runtimeId ?? contexts.get(input)?.runtimeId });
}

/** Config env blocks must not acquire unrelated process variables. */
export function providerConfigEnvironment(input: Record<string, string>, runtimeId: string): Record<string, string> {
  const env: Record<string, string> = providerSpawnEnvironment(input, { onlyExisting: true, runtimeId, inject: false });
  if (!('NODE_ENV' in input)) delete env.NODE_ENV;
  return env;
}

/** The only ambient inheritance point. Runtime identity and persisted API opt-in are required. */
export function childEnvironment(options: SpawnOptions & { env?: Record<string, string | undefined>; inherit?: boolean } = {}): ReturnType<typeof resolvedEnvironment> {
  let parent: Record<string, string | undefined> = {};
  if (options.inherit !== false) {
    parent = options.runtimeId || options.runtimeLaunch
      ? workerParentEnvironment(process.env, options.runtimeId) : process.env;
    // Credentials still enter only through the existing runtime billing/injection policy.
    if (permitsApiCredentials(options.runtimeId)) {
      parent = { ...parent };
      for (const [name, value] of Object.entries(process.env)) if (providerCredentialName(name)) parent[name] = value;
    }
  }
  const input = { ...parent, ...options.env };
  return resolvedEnvironment(input, options.inject !== false && permitsApiCredentials(options.runtimeId), { ...options, deniedValues: [...((options as Context).deniedValues ?? []), ...(options.env ? contexts.get(options.env)?.deniedValues ?? [] : [])] });
}

export function childEnvironmentContext(env: Record<string, string | undefined> | undefined): Context | undefined {
  return env ? contexts.get(env) : undefined;
}

/** The process boundary refreshes values and policy, including prepared environments. */
export function refreshChildEnvironment(env?: Record<string, string | undefined>): ReturnType<typeof resolvedEnvironment> {
  const context = childEnvironmentContext(env);
  const result = childEnvironment({ ...context, env, inherit: env === undefined });
  const authorized = new Set(Object.entries(result).filter(([name]) => providerCredentialName(name)).map(([, value]) => value).filter((value): value is string => typeof value === 'string'));
  const denied = credentialMaterials({}, authorized);
  for (const [name, value] of Object.entries(context?.transport ?? {})) if (!matchesProviderCredential(value, denied)) result[name] = value;
  if (context?.brokerKey) { result.O8_MASTER_KEY = context.brokerKey; contexts.get(result)!.brokerKey = context.brokerKey; }
  for (const [name, value] of Object.entries(env ?? {})) if (value === '') result[name] = '';
  return result;
}

/** Explicit local subscription transport, never a managed provider key. */
export function retainChildTransportCredentials(env: Record<string, string>, names: string[]): void {
  const context = contexts.get(env);
  if (context) context.transport = Object.fromEntries(names.filter(name => env[name] !== undefined).map(name => [name, env[name]]));
}

/** Prepared argv cannot retain a provider value that the fresh environment denied. */
export function assertChildArguments(args: readonly string[], input: Record<string, string | undefined> | undefined, fresh: NodeJS.ProcessEnv, allowDeferredMcp = false): void {
  const allowed = new Set(Object.entries(fresh).filter(([name]) => providerCredentialName(name)).map(([, value]) => value).filter((value): value is string => Boolean(value)));
  const denied = credentialMaterials(input ?? {}, allowed);
  const prepared = (input ? contexts.get(input)?.deniedValues ?? [] : []).filter(value => value && !allowed.has(value));
  const checked = allowDeferredMcp && input && contexts.get(input)?.runtimeId === 'codex'
    ? deferredMcpArgumentsForCheck(input, args) : args;
  if (checked.some(arg => prepared.some(value => arg.includes(value)) || matchesProviderCredential(arg, denied))) throw new Error('Prepared child arguments contain revoked or unauthorized provider credentials.');
}

/** Trusted internal brokers reread encrypted policy; runtime children never inherit this key. */
export function internalBrokerEnvironment(input?: Record<string, string | undefined>): ReturnType<typeof resolvedEnvironment> {
  const result = refreshChildEnvironment(input);
  const key = process.env.O8_MASTER_KEY;
  if (key) { result.O8_MASTER_KEY = key; contexts.get(result)!.brokerKey = key; }
  return result;
}

/** Non-secret generation stamp for our delayed nested-execution helpers. */
export function stampChildPolicy(env: NodeJS.ProcessEnv): void {
  const context = childEnvironmentContext(env);
  if (!context?.runtimeId) { delete env.O8_CHILD_CREDENTIAL_POLICY; return; }
  const directory = realpathSync(getDataDir());
  const approvedCredentials = Object.fromEntries(Object.entries(env).filter(([name, value]) => providerCredentialName(name) && value?.trim()).map(([name, value]) => [name, digest(value!)]));
  env.O8_CHILD_CREDENTIAL_POLICY = JSON.stringify({ runtimeId: context.runtimeId, directory, ...ensureLaunchPolicy(),
    apiAllowed: permitsApiCredentials(context.runtimeId), approvedCredentials,
    sqliteModule: createRequire(import.meta.url).resolve('better-sqlite3') });
}
