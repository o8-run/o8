export const dynamic = 'force-dynamic';

/**
 * API Key Management (BYOK — Bring Your Own Key)
 *
 * GET  /api/v2/keys — list configured providers (keys masked)
 * POST /api/v2/keys — set/update a provider key
 * DELETE /api/v2/keys — remove a provider key
 * PATCH /api/v2/keys — OpenRouter only: turn the connection on/off or re-check the key
 *
 * Keys are AES-256-GCM encrypted at rest inside ~/.o8/.env.local.
 * The encryption master key lives in the macOS Keychain (Tauri builds) or
 * the O8_MASTER_KEY env var (dev / non-macOS). Plaintext values written by
 * older installs are migrated to encrypted form on first read.
 *
 * Storage format (per line in .env.local):
 *   PROVIDER_KEY=enc:<hex-iv>:<hex-ciphertext+authtag>
 *
 * Legacy plaintext lines are re-encrypted automatically on next write.
 */

import { NextRequest, NextResponse } from 'next/server';
import { MasterKeyUnavailableError } from '@/lib/db/master-key';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveOpenRouterKey } from '@/lib/cortex/qa/llm/byok-keys';
import { assertProviderStoreAvailable, mutateProviderKey, storedProviderKey, resolveProviderKey, providerKeyEnabled } from '@/lib/providers/key-store';
import { checkOpenRouterKey, clearOpenRouterCheck, openRouterConnectionView, readOpenRouterConnection, recordOpenRouterCheck, setOpenRouterEnabled } from '@/lib/providers/openrouter-connection';
import { invalidateRuntimeAuthCache } from '@/lib/runtimes/shared/auth-detect';

interface ProviderKeyConfig {
  id: string;
  label: string;
  envVar: string;
  placeholder: string;
  docsUrl: string;
  validateUrl?: string;
}

// BYOK (#960): OpenRouter + Anthropic are the two user-managed keys for beta.
// CLI runtimes (codex, claude-code, gemini, opencode) handle their own auth.
// CLI credential stores remain owned by their respective runtimes.
const PROVIDERS: ProviderKeyConfig[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    envVar: 'OPENROUTER_API_KEY',
    placeholder: 'sk-or-...',
    docsUrl: 'https://openrouter.ai/keys',
    validateUrl: 'https://openrouter.ai/api/v1/key',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    envVar: 'DEEPSEEK_API_KEY',
    placeholder: 'sk-...',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    validateUrl: 'https://api.deepseek.com/models',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    placeholder: 'sk-ant-...',
    docsUrl: 'https://console.anthropic.com/keys',
    validateUrl: 'https://api.anthropic.com/v1/messages',
  },
  {
    // BYOK for Symon Realtime mode (gpt-realtime). Free path — the user's key
    // bills OpenAI directly, o8 never spends (the managed/proxied path is the
    // paid lever). See src/lib/voice/realtime-access.ts.
    id: 'openai',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    placeholder: 'sk-...',
    docsUrl: 'https://platform.openai.com/api-keys',
    validateUrl: 'https://api.openai.com/v1/models',
  },
];

async function validateKey(config: ProviderKeyConfig, key: string): Promise<{ valid: boolean; error?: string }> {
  if (!config.validateUrl) return { valid: true };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const headers: Record<string, string> = {};

    if (config.id === 'anthropic') {
      headers['x-api-key'] = key;
      headers['anthropic-version'] = '2023-06-01';
      headers['content-type'] = 'application/json';
      // Anthropic requires a POST to /messages — use a minimal request that will 400 but proves auth works
      const res = await fetch(config.validateUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: controller.signal,
      });
      // 200 or 400 (bad request) means the key authenticated — only 401/403 means invalid
      if (res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid API key' };
      if (!res.ok && res.status !== 400) return { valid: true, error: `Provider validation unavailable (${res.status}) — key saved without verification` };
      return { valid: true };
    }

    if (config.id === 'google') {
      const res = await fetch(config.validateUrl, {
        headers: { 'x-goog-api-key': key },
        signal: controller.signal,
      });
      if (res.status === 400 || res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid API key' };
      return { valid: true };
    }

    if (config.id === 'github') {
      headers['Authorization'] = `token ${key}`;
    } else {
      headers['Authorization'] = `Bearer ${key}`;
    }

    const res = await fetch(config.validateUrl, { headers, signal: controller.signal });
    if (res.status === 401 || res.status === 403) return { valid: false, error: 'Invalid API key' };
    if (!res.ok) return { valid: true, error: `Provider validation unavailable (${res.status}) — key saved without verification` };
    return { valid: true };
  } catch {
    // Network error — don't block saving, just warn
    return { valid: true, error: 'Could not validate (network error) — key saved anyway' };
  } finally {
    clearTimeout(timeout);
  }
}

function maskKey(key: string): string {
  if (key.length <= 8) return '••••••••';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}

// GET — list providers with masked keys
async function handleGET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  assertProviderStoreAvailable();
  const connection = readOpenRouterConnection();
  // Also check process.env (may be set outside .env.local)
  const providers = PROVIDERS.map((p) => {
    const envValue = storedProviderKey(p.envVar) || resolveProviderKey(p.envVar) || '';
    return {
      id: p.id,
      label: p.label,
      envVar: p.envVar,
      placeholder: p.placeholder,
      docsUrl: p.docsUrl,
      configured: !!envValue,
      enabled: providerKeyEnabled(p.envVar),
      maskedKey: envValue ? maskKey(envValue) : null,
      ...(p.id === 'openrouter' ? { connection: openRouterConnectionView(envValue || null, connection) } : {}),
    };
  });

  return NextResponse.json({ providers });
}

// POST — set/update a key
async function handlePOST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  if (typeof body?.provider !== 'string' || typeof body?.key !== 'string') {
    return NextResponse.json({ error: 'provider and key are required' }, { status: 400 });
  }

  const config = PROVIDERS.find((p) => p.id === body.provider);
  if (!config) {
    return NextResponse.json({ error: `Unknown provider: ${body.provider}` }, { status: 400 });
  }

  const key = body.key.trim();
  if (!key) {
    return NextResponse.json({ error: 'Key cannot be empty' }, { status: 400 });
  }

  // Validate key against provider API before saving. OpenRouter keeps the
  // check result (#3583) so the connection can show verified, unverified or failing.
  const openRouterCheck = config.id === 'openrouter' ? await checkOpenRouterKey(key) : null;
  const validation = openRouterCheck
    ? { valid: openRouterCheck.status !== 'invalid', error: openRouterCheck.status === 'ok' ? undefined : `${openRouterCheck.error} The key is saved and marked unverified.` }
    : await validateKey(config, key);
  if (!validation.valid) {
    return NextResponse.json({ error: openRouterCheck?.error || validation.error || 'Invalid API key' }, { status: 400 });
  }

  // Replace only this credential; retain unrelated ciphertext verbatim.
  assertProviderStoreAvailable();
  if (config.id === 'openrouter') readOpenRouterConnection();
  mutateProviderKey(config.envVar, { key });
  // payer policy part b: preserve the base save-to-ambient behavior for deferred MCP consumers.
  // Every ordinary child crosses its own persisted billing boundary.
  process.env[config.envVar] = key;

  let warning = validation.error;
  let connection;
  if (openRouterCheck) {
    try { connection = openRouterConnectionView(key, recordOpenRouterCheck(key, openRouterCheck)); }
    catch { warning = 'Key saved. Provider check status could not be persisted.'; }
  }
  invalidateRuntimeAuthCache();

  return NextResponse.json({
    success: true,
    provider: config.id,
    maskedKey: maskKey(key),
    warning: warning || undefined,
    ...(connection ? { connection } : {}),
  });
}

// DELETE — remove a key
async function handleDELETE(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  if (!body?.provider) {
    return NextResponse.json({ error: 'provider is required' }, { status: 400 });
  }

  const config = PROVIDERS.find((p) => p.id === body.provider);
  if (!config) {
    return NextResponse.json({ error: `Unknown provider: ${body.provider}` }, { status: 400 });
  }

  // A durable removal marker prevents old native entries from returning.
  assertProviderStoreAvailable();
  if (config.id === 'openrouter') readOpenRouterConnection();
  mutateProviderKey(config.envVar, { key: null });
  delete process.env[config.envVar];

  let warning = 'External environment and project-local keys are managed separately.';
  if (config.id === 'openrouter') {
    try { clearOpenRouterCheck(); } catch { warning = 'Key removed. Provider check status cleanup is pending.'; }
  }
  invalidateRuntimeAuthCache();

  return NextResponse.json({ success: true, provider: config.id, warning });
}

// PATCH — OpenRouter connection controls (#3583). Turning it off keeps the key
// but stops every o8 OpenRouter call; Check re-reads the key's status.
async function handlePATCH(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => null);
  const config = PROVIDERS.find((provider) => provider.id === body?.provider);
  if (!config) return NextResponse.json({ error: 'Unknown provider' }, { status: 400 });
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
  if (enabled === undefined && (config.id !== 'openrouter' || body.check !== true)) {
    return NextResponse.json({ error: 'enabled (boolean) or check (true) is required' }, { status: 400 });
  }

  if (enabled !== undefined && body.check === true) return NextResponse.json({ error: 'Check and enabled must be separate actions' }, { status: 400 });
  assertProviderStoreAvailable();
  if (config.id !== 'openrouter') {
    if (enabled !== undefined) {
      mutateProviderKey(config.envVar, { enabled });
      resolveProviderKey(config.envVar);
      invalidateRuntimeAuthCache();
    }
    return NextResponse.json({ success: true, provider: config.id, enabled: providerKeyEnabled(config.envVar) });
  }
  if (enabled !== undefined) {
    setOpenRouterEnabled(enabled);
    const stored = storedProviderKey('OPENROUTER_API_KEY');
    if (enabled && stored) process.env.OPENROUTER_API_KEY = stored;
    else if (!enabled && stored && process.env.OPENROUTER_API_KEY === stored) delete process.env.OPENROUTER_API_KEY;
    // Resolving applies the new state to this process's environment.
    await resolveOpenRouterKey();
    invalidateRuntimeAuthCache();
  }

  const key = await resolveOpenRouterKey();
  if (body.check === true) {
    if (!readOpenRouterConnection().enabled) {
      return NextResponse.json({ error: 'Turn the OpenRouter connection on before checking it' }, { status: 409 });
    }
    if (!key) return NextResponse.json({ error: 'No OpenRouter key is connected' }, { status: 409 });
    recordOpenRouterCheck(key, await checkOpenRouterKey(key));
  }

  return NextResponse.json({ success: true, provider: 'openrouter', connection: openRouterConnectionView(key) });
}

function storageGuard(handler: (request: NextRequest) => Promise<NextResponse>) {
  return async (request: NextRequest) => {
    try { return await handler(request); }
    catch (error) {
      if (error instanceof MasterKeyUnavailableError) return NextResponse.json({ error: error.message, code: error.code }, { status: 503 });
      return NextResponse.json({ error: 'Credential store unavailable. Previous keys were preserved.', code: 'key_store_unavailable' }, { status: 503 });
    }
  };
}
export const GET = storageGuard(handleGET);
export const POST = storageGuard(handlePOST);
export const DELETE = storageGuard(handleDELETE);
export const PATCH = storageGuard(handlePATCH);
