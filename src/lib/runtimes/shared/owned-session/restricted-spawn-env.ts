import { childEnvironment, retainChildTransportCredentials } from '@/lib/providers/spawn-environment';
import { resolveProviderKey } from '@/lib/providers/key-store';
import { providerSpawnEnvironment } from '@/lib/providers/spawn-environment';
import { runtimeBillingMode } from '@/lib/providers/runtime-billing';
import { controlledProviderPins } from './controlled-provider';
import type { OwnedSessionRecord } from './types';

const BASE_KEYS = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'];
const ADAPTER_KEYS = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_CODE_OAUTH_TOKEN'];
const CONTROLLED_KEYS = ['TMPDIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];
// An operator-set model endpoint is not a credential. Unrestricted launches
// inherit it through the worker environment; restricted ones keep it too.
const ENDPOINT_KEYS: Record<string, string[]> = { 'claude-code': ['ANTHROPIC_BASE_URL'] };
const RUN_KEYS = ['PWD', 'PATH', 'NODE_ENV', 'FORCE_COLOR', 'NO_COLOR', 'BROWSER',
  'O8_WORKER_TOKEN', 'O8_OWNED_RUN_MARKER', 'O8_API_PORT', 'O8_WS_PORT'];

function pick(input: Record<string, string | undefined>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]!]));
}

/** Native login is pinned by the adapter; ambient API keys and shell hooks are excluded. */
export function ownedSpawnEnvironment(session: OwnedSessionRecord, env: Record<string, string>, clearInherited = false): ReturnType<typeof providerSpawnEnvironment> {
  const runtimeId = session.surfaceId?.split('-owned:')[0] ?? 'unknown';
  const restricted = session.executionPolicy !== undefined;
  const controlled = Boolean(session.controlledTask && controlledProviderPins(session.model, session.effort, session.runtimeConfig));
  const input = restricted
    ? { NODE_ENV: 'development', ...pick(process.env, [...BASE_KEYS, ...(ENDPOINT_KEYS[runtimeId] ?? [])]), ...pick(env, [...ADAPTER_KEYS, ...RUN_KEYS,
      ...(controlled ? CONTROLLED_KEYS : [])]) }
    : childEnvironment({ runtimeId, env });
  const resolved = providerSpawnEnvironment(input, { inject: !restricted, clearInherited, runtimeId });
  // Adapter blanks pin native sign-in (for example Muse); provider injection cannot override them.
  for (const [name, value] of Object.entries(env)) if (value === '') resolved[name] = '';
  // These are explicit transport credentials, never inherited provider aliases.
  const source = session.runtimeConfig?.modelSource;
  if (session.surfaceId?.startsWith('claude-code-owned:') && (!restricted || controlled) && (source === 'codex-subscription' || (source === 'openrouter' && runtimeBillingMode(runtimeId) === 'api' && resolveProviderKey('OPENROUTER_API_KEY'))) && env.ANTHROPIC_BASE_URL) {
    // The local gateway URL includes its transport token in the path.
    const transportNames = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
    for (const name of transportNames) if (env[name] !== undefined) resolved[name] = env[name];
    retainChildTransportCredentials(resolved, transportNames);
  }
  return resolved;
}
