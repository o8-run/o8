import { assertMcpConfiguration } from './mcp-config-policy';
import { withProviderStoreLock } from './store-lock';
import { providerCredentialMaterials } from './key-store';
import { matchesProviderCredential } from './credential-materials';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const PROVIDER_NAMES = new Set(['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_AI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GOOGLE_API_KEY', 'GROQ_API_KEY', 'ELEVENLABS_API_KEY', 'GOOGLE_TTS_API_KEY']);
const PROVIDERS: Record<string, string> = { openai: 'OPENAI_API_KEY', codex: 'OPENAI_API_KEY', 'openai-codex': 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', 'claude-code': 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY', google: 'GEMINI_API_KEY', gemini: 'GEMINI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', groq: 'GROQ_API_KEY' };
const providerName = (name: string) => PROVIDER_NAMES.has(name) || ['LLM_API_KEY', 'GOOSE_API_KEY', 'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN'].includes(name);
const credentialHeader = /^(authorization|proxy-authorization|x-api-key|api-key|apikey|x-goog-api-key|xi-api-key|x-auth-token|x-access-token)$/i;

/** Owned files never contain provider secrets. Account OAuth and service auth stay intact. */
export function filterRuntimeConfig(value: unknown, runtimeId: string, provider = runtimeId, location: string[] = [], materials = providerCredentialMaterials()): unknown {
  if (location.length === 0 && value && typeof value === 'object' && !Array.isArray(value)) assertMcpConfiguration(value, runtimeId);
  // Preserve approved MCP entries without applying provider-file sanitization.
  if (location.some(part => part === 'mcp_servers' || part === 'mcpServers')) return value;
  if (typeof value === 'string') return matchesProviderCredential(value, materials) ? undefined : value;
  if (Array.isArray(value)) return value.map(item => filterRuntimeConfig(item, runtimeId, provider, location, materials)).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const selected = typeof record.provider === 'string' ? record.provider : provider;
  const modelProviders = location.lastIndexOf('model_providers');
  const models = location.lastIndexOf('models');
  const providerMap = modelProviders === location.length - 1 && modelProviders >= 0
    || models >= 0 && location[models + 1] === 'providers' && models + 2 === location.length;
  const providerHeaders = modelProviders >= 0 && location.length > modelProviders + 1
    || models >= 0 && location[models + 1] === 'providers' && location.length > models + 2;
  const providerLocation = location.length === 0 || providerHeaders
    || location[0] === 'model' || (location.includes('providers') && location.some(part => Object.hasOwn(PROVIDERS, part)))
    || (typeof record.provider === 'string' && Object.hasOwn(PROVIDERS, record.provider));
  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(record)) {
    if (providerName(name)) continue;
    if (providerLocation && ((location.at(-1) !== 'headers' && /^(api_?key|experimental_bearer_token)$/i.test(name))
      || ((name === 'key' || name === 'token') && (record.type === 'api_key' || record.type === 'api-key')))) continue;
    if (providerHeaders && (name === 'headers' || name === 'http_headers' || name === 'env_http_headers')) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const retained: Record<string, unknown> = {};
      for (const [header, raw] of Object.entries(item)) {
        if (typeof raw === 'string' && matchesProviderCredential(raw, materials)) {
          continue;
        }
        if (!credentialHeader.test(header)) retained[header] = raw;
        else if (name === 'env_http_headers' && typeof raw === 'string' && PROVIDER_NAMES.has(raw)) retained[header] = raw;
      }
      out[name] = retained;
    } else {
      const filtered = filterRuntimeConfig(item, runtimeId, Object.hasOwn(PROVIDERS, name) ? name : providerMap ? '' : selected, [...location, name], materials);
      if (filtered !== undefined) out[name] = filtered;
    }
  }
  return out;
}

function parseWithoutSecrets<T>(parse: () => T): T {
  try { return parse(); }
  catch { throw new Error('Runtime credential configuration is invalid. Fix its syntax and retry.'); }
}

/** Parse before writing a destination, so even interrupted preparation has no plaintext window. */
export function sanitizeRuntimeConfigText(file: string, raw: string, runtimeId: string): string {
  if (file.endsWith('.json')) return `${JSON.stringify(filterRuntimeConfig(parseWithoutSecrets(() => JSON.parse(raw)), runtimeId) ?? null, null, 2)}\n`;
  if (file.endsWith('.toml')) {
    const original = parseWithoutSecrets(() => parseToml(raw));
    const filtered = filterRuntimeConfig(original, runtimeId) as Record<string, unknown>;
    return JSON.stringify(original) === JSON.stringify(filtered) && !matchesProviderCredential(raw, providerCredentialMaterials()) ? raw : stringifyToml(filtered);
  }
  if (file.endsWith('.yaml') || file.endsWith('.yml')) return stringifyYaml(filterRuntimeConfig(parseWithoutSecrets(() => parseYaml(raw, { logLevel: 'error' })), runtimeId));
  const materials = providerCredentialMaterials();
  return raw.split('\n').filter(line => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return (!match || !providerName(match[1])) && !matchesProviderCredential(line, materials);
  }).join('\n');
}

export function copyRuntimeConfigFile(source: string, destination: string, runtimeId: string): void {
  withProviderStoreLock(() => copyConfig(source, destination, runtimeId));
}

function copyConfig(source: string, destination: string, runtimeId: string): void {
  if (existsSync(destination)) return;
  const raw = readFileSync(source);
  const text = raw.toString('utf8');
  // Remove provider credentials before the first destination write. Opaque OAuth
  // blobs retain their bytes, provided they contain no known saved key.
  const contents = /\.(?:json|toml|ya?ml)$/.test(source) || source.endsWith('.env')
    ? sanitizeRuntimeConfigText(source, text, runtimeId)
    : (assertRuntimeConfigText(source, text, runtimeId), raw);
  writeFileSync(destination, contents, { flag: 'wx', mode: 0o600 });
}

const meaningful = (value: unknown): unknown => {
  if (value == null || value === '' || typeof value === 'string' && /^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value)) return undefined;
  if (Array.isArray(value)) return value.map(meaningful).filter(item => item !== undefined);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, meaningful(item)]).filter(([, item]) => item !== undefined));
  return value;
};

/** Reject a credential-bearing source. Never sanitize or repair its contents. */
export function assertRuntimeConfigText(file: string, raw: string, runtimeId: string): string {
  const materials = providerCredentialMaterials();
  const original = file.endsWith('.json') ? parseWithoutSecrets(() => JSON.parse(raw))
    : file.endsWith('.toml') ? parseWithoutSecrets(() => parseToml(raw))
      : /\.ya?ml$/.test(file) ? parseWithoutSecrets(() => parseYaml(raw, { logLevel: 'error' }))
        : Object.fromEntries(raw.split('\n').flatMap(line => {
          const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
          return match ? [[match[1], match[2]]] : [];
        }));
  if (matchesProviderCredential(raw, materials) || JSON.stringify(meaningful(original)) !== JSON.stringify(meaningful(filterRuntimeConfig(original, runtimeId, runtimeId, [], materials)))) {
    throw new Error('Runtime config contains provider credentials and was left unchanged. File authentication requires #4340.');
  }
  return raw;
}
