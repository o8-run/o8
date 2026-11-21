import { childEnvironment } from '@/lib/providers/spawn-environment';
import { NextResponse } from 'next/server';
import { execFileSync } from '@/lib/providers/child-process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  probeCodexVoiceCapability,
  type CodexVoiceCapability,
} from '@/lib/codex/appserver-probe';
import { pathLookupProgram, pickLookupResult, scanAndLink } from '@/lib/runtimes/shared/cli-locate';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { detectRuntimeAuthStatus } from '@/lib/runtimes/shared/auth-detect';
import {
  CLAUDE_PROBE_TIMEOUT_MS,
  probeClaudeLoginState,
} from '@/lib/runtimes/shared/claude-login-probe';
import { opencodeAuthenticatedProviders } from '@/lib/runtimes/shared/opencode-readiness';
import { hasLiveClaudeOAuth } from '@/lib/claude-code/oauth-credential';
import { getDataDir } from '@/lib/data-dir-migration';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DetectedTool {
  id: string;
  name: string;
  detected: boolean;
  /** Runtimes only: binary present AND its required auth (key/login) is configured. */
  ready?: boolean;
  /** When detected but not ready, the one-line fix (e.g. "set GEMINI_API_KEY"). */
  authHint?: string;
  version?: string;
  path?: string;
  details?: Record<string, unknown>;
}

interface DetectionResult {
  tools: DetectedTool[];
  codexVoiceCapability?: CodexVoiceCapability;
  hasAnything: boolean;
  hasAgentSurface: boolean;
  hasCliAgent: boolean;
  hasApiKey: boolean;
  hasEmbeddings: boolean;
  recommendedPath: 'ready' | 'quick-setup' | 'full-wizard';
  summary: string;
  partial?: boolean;
  timedOut?: boolean;
}

const ROUTE_DEADLINE_MS = 10_000;
const MIN_PROBE_TIMEOUT_MS = 50;

function boundedTimeout(timeoutMs: number, deadlineAt?: number): number {
  if (!deadlineAt) return timeoutMs;
  const remaining = deadlineAt - Date.now();
  if (remaining < MIN_PROBE_TIMEOUT_MS) return 0;
  return Math.min(timeoutMs, remaining);
}

function safeExec(cmd: string, args: string[], timeoutMs = 2000, deadlineAt?: number): string {
  const timeout = boundedTimeout(timeoutMs, deadlineAt);
  if (timeout === 0) return '';
  try {
    // Callers pass a located binary, which on Windows is usually the `.cmd`
    // shim npm writes — execFile cannot run one, so every `--version` probe
    // came back empty and the wizard reported installed tools as missing.
    const run = cliInvocation(cmd, args);
    return execFileSync(run.command, run.args, {
      windowsHide: true,
      encoding: 'utf-8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: childEnvironment({ env: { MUSE_NO_AUTO_UPDATE: '1' } }),
    }).trim();
  } catch {
    return '';
  }
}

function safeWhich(bin: string, deadlineAt?: number): string {
  const timeout = boundedTimeout(1000, deadlineAt);
  if (timeout === 0) return '';
  try {
    // `which` does not exist on Windows; `where` does, and it prints every
    // match on its own line (npm's extensionless script first).
    const stdout = execFileSync(pathLookupProgram(), [bin], {
      windowsHide: true,
      encoding: 'utf-8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return pickLookupResult(stdout) ?? '';
  } catch {
    return '';
  }
}

/**
 * Locate a runtime CLI: PATH first, then the deterministic well-known-dirs
 * scan (Claude native installer's ~/.local/bin, per-version nvm/fnm bins, bun,
 * pnpm, …). The scan also repairs ~/.o8/bin symlinks so PATH-based consumers
 * work afterward. Bare `which` alone missed real installs whenever the PATH
 * line lived in ~/.zshrc — the v0.1.548 "Claude/Gemini not detected" report.
 */
function locateBin(bin: string, deadlineAt?: number): string {
  const fromPath = safeWhich(bin, deadlineAt);
  if (fromPath) return fromPath;
  try {
    return scanAndLink(bin) ?? '';
  } catch {
    return '';
  }
}

async function safeFetch(url: string, timeoutMs = 2000, deadlineAt?: number): Promise<Response | null> {
  const timeout = boundedTimeout(timeoutMs, deadlineAt);
  if (timeout === 0) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- Runtime auth readiness ---------------------------------------------------
// A green "Ready" dot must mean the runtime will actually RUN, not just that the
// binary is on PATH. Each runtime needs an API key or a CLI login. We check both
// process.env (what the Tauri sidecar forwards to dispatched workers) and the
// .env.local files. Lenient where a login can't be detected reliably (codex /
// claude-code): only flag "auth missing" when we're confident none exists.
function loadConfiguredKeyNames(): Set<string> {
  const repoRoot = process.env.CORTEX_IDE_REPO_ROOT || process.cwd();
  const names = new Set<string>();
  for (const envPath of [join(getDataDir(), '.env.local'), join(repoRoot, '.env.local')]) {
    if (!existsSync(envPath)) continue;
    try {
      for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq === -1) continue;
        const k = t.slice(0, eq).trim();
        const v = t.slice(eq + 1).trim();
        if (k && v && v !== '""' && v !== "''") names.add(k);
      }
    } catch { /* ignore */ }
  }
  return names;
}

function keyPresent(names: string[], configured: Set<string>): boolean {
  return names.some((n) => {
    const v = process.env[n];
    return (typeof v === 'string' && v.trim().length > 0) || configured.has(n);
  });
}

function detectCodex(deadlineAt?: number): DetectedTool {
  const home = homedir();
  const path = locateBin('codex', deadlineAt);
  const detected = !!path;
  let version: string | undefined;
  let threadCount = 0;

  if (detected) {
    version = safeExec(path, ['--version'], 2000, deadlineAt);
  }

  const sqlitePath = join(home, '.codex', 'state_5.sqlite');
  if (existsSync(sqlitePath)) {
    const count = safeExec('sqlite3', [
      '-json',
      sqlitePath,
      'SELECT count(*) as cnt FROM threads WHERE archived=0',
    ], 2000, deadlineAt);
    try {
      const parsed = JSON.parse(count) as Array<{ cnt: number }>;
      threadCount = parsed[0]?.cnt ?? 0;
    } catch {
      // ignore
    }
  }

  const authPresent = keyPresent(['OPENAI_API_KEY'], loadConfiguredKeyNames())
    || existsSync(join(home, '.codex', 'auth.json'))
    || threadCount > 0;
  return {
    id: 'codex',
    name: 'Codex CLI',
    detected,
    ready: detected ? authPresent : undefined,
    authHint: detected && !authPresent ? 'run: codex login (or set OPENAI_API_KEY)' : undefined,
    version,
    path,
    details: { threadCount, authPresent },
  };
}

async function detectClaudeCode(deadlineAt?: number): Promise<DetectedTool> {
  const home = homedir();
  const path = locateBin('claude', deadlineAt);
  const detected = !!path;
  let version: string | undefined;
  let sessionCount = 0;

  if (detected) {
    version = safeExec(path, ['--version'], 2000, deadlineAt);
  }

  // The operator can relocate the whole Claude config with CLAUDE_CONFIG_DIR; reading
  // ~/.claude unconditionally reports a relocated, signed-in machine as signed out.
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
  const projectsDir = join(configDir, 'projects');
  if (existsSync(projectsDir)) {
    try {
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const files = readdirSync(projectsDir);
      sessionCount = files.filter(f => {
        if (!f.endsWith('.jsonl')) return false;
        try {
          const stat = statSync(join(projectsDir, f));
          return stat.mtimeMs > sevenDaysAgo;
        } catch {
          return false;
        }
      }).length;
    } catch {
      // ignore
    }
  }

  // An existing .credentials.json is not evidence — Claude Code leaves the file behind
  // with empty token fields after a sign-out. Only live OAuth material counts.
  let storedOauth = '';
  try {
    storedOauth = readFileSync(join(configDir, '.credentials.json'), 'utf8');
  } catch {
    storedOauth = '';
  }
  // Recent transcripts are session history, never authentication: ~/.claude/projects
  // survives a sign-out intact, so counting it here reported a logged-out machine as
  // ready. It stays in `details` as context for the operator.
  const envCredentialPresent = keyPresent(
    ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    loadConfiguredKeyNames(),
  );
  const probeTimeout = boundedTimeout(CLAUDE_PROBE_TIMEOUT_MS, deadlineAt);
  const loginState = detected && !envCredentialPresent && probeTimeout > 0
    ? await probeClaudeLoginState(path, probeTimeout)
    : 'unknown';
  // The authoritative CLI status recognizes macOS Keychain-only sessions without
  // reading Keychain directly. Explicit logged-out status outranks a stale credential
  // file; only an inconclusive probe falls back to live on-disk OAuth material.
  const authPresent = envCredentialPresent
    || loginState === 'logged_in'
    || (loginState === 'unknown' && hasLiveClaudeOAuth(storedOauth));
  return {
    id: 'claude-code',
    name: 'Claude Code CLI',
    detected,
    ready: detected ? authPresent : undefined,
    authHint: detected && !authPresent ? 'log in by running claude once (or set ANTHROPIC_API_KEY)' : undefined,
    version,
    path,
    details: { sessionCount, authPresent },
  };
}


async function detectAntigravity(deadlineAt?: number): Promise<DetectedTool> {
  const readiness = await detectRuntimeAuthStatus('antigravity', deadlineAt);
  return {
    id: 'antigravity',
    name: 'Antigravity CLI',
    detected: readiness.installed,
    ready: readiness.ready,
    authHint: readiness.ready ? undefined : readiness.fix,
    path: readiness.binaryPath,
    details: { authPresent: readiness.authenticated, readiness: readiness.detail },
  };
}

async function detectOpenCode(deadlineAt?: number): Promise<DetectedTool> {
  const path = locateBin('opencode2', deadlineAt);
  const detected = !!path;
  let version: string | undefined;
  let authedProviders: string[] = [];

  if (detected) {
    version = safeExec(path, ['--version'], 2000, deadlineAt);
  }

  const readiness = detected ? await detectRuntimeAuthStatus('opencode') : null;
  if (detected) {
    authedProviders = [...await opencodeAuthenticatedProviders(homedir(), path)].sort();
  }
  const authPresent = readiness?.authenticated === true;
  const ready = readiness?.ready === true;
  return {
    id: 'opencode',
    name: 'OpenCode 2 CLI',
    detected,
    ready: detected ? ready : undefined,
    authHint: detected && !ready ? readiness?.fix ?? 'run: opencode2 auth login' : undefined,
    version,
    path,
    details: { authedProviders, authPresent, readiness: readiness?.detail },
  };
}

function detect3code(deadlineAt?: number): DetectedTool {
  const path = locateBin('3code', deadlineAt);
  const detected = Boolean(path);
  const configPath = join(homedir(), '.config', '3code', 'config');
  const authPresent = existsSync(configPath);

  return {
    id: '3code',
    name: '3code CLI',
    detected,
    ready: detected ? authPresent : undefined,
    authHint: detected && !authPresent ? 'run: 3code (then configure a model provider)' : undefined,
    path,
    details: { authPresent, configPath },
  };
}




function detectPi(deadlineAt?: number): DetectedTool {
  const path = locateBin('pi', deadlineAt);
  const detected = !!path;
  let version: string | undefined;

  if (detected) {
    version = safeExec(path, ['--version'], 2000, deadlineAt);
  }

  const authPresent = keyPresent(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], loadConfiguredKeyNames())
    || existsSync(join(homedir(), '.pi'));
  return {
    id: 'pi',
    name: 'Pi',
    detected,
    ready: detected ? authPresent : undefined,
    authHint: detected && !authPresent ? 'set ANTHROPIC_API_KEY or OPENAI_API_KEY' : undefined,
    version,
    path,
    details: { authPresent },
  };
}

async function detectOllama(deadlineAt?: number): Promise<DetectedTool> {
  const res = await safeFetch('http://localhost:11434/api/tags', 2000, deadlineAt);
  const detected = res?.ok ?? false;
  let models: string[] = [];
  let hasEmbed = false;

  if (detected && res) {
    try {
      const data = await res.json() as { models?: Array<{ name: string }> };
      models = data.models?.map(m => m.name) ?? [];
      hasEmbed = models.some(m => m.toLowerCase().includes('embed'));
    } catch {
      // ignore
    }
  }

  return {
    id: 'ollama',
    name: 'Ollama',
    detected,
    details: { models, hasEmbed },
  };
}

function detectApiKeys(): DetectedTool {
  // Prefer the explicit env var; otherwise use the current working directory
  // (the Next server's cwd) which is the repo root in both dev and packaged builds.
  const repoRoot = process.env.CORTEX_IDE_REPO_ROOT || process.cwd();
  const paths = [
    join(getDataDir(), '.env.local'),
    join(repoRoot, '.env.local'),
  ];

  // v1: only OpenRouter is exposed in the wizard. The o8 Operator uses Gemini
  // under the hood via GOOGLE_AI_API_KEY which is provisioned silently.
  const keys = {
    OPENROUTER_API_KEY: false,
  };

  for (const envPath of paths) {
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (key in keys && value && value !== '""' && value !== "''") {
          keys[key as keyof typeof keys] = true;
        }
      }
    } catch {
      // ignore
    }
  }

  const providers = Object.entries(keys).map(([key, configured]) => ({
    provider: key.replace('_API_KEY', '').toLowerCase(),
    configured,
  }));

  const detected = providers.some(p => p.configured);

  return {
    id: 'api-keys',
    name: 'API Keys',
    detected,
    details: { providers },
  };
}

function buildSummary(tools: DetectedTool[]): string {
  const parts: string[] = [];

  const claudeCode = tools.find(t => t.id === 'claude-code');
  if (claudeCode?.detected) {
    const sessionCount = (claudeCode.details?.sessionCount as number) ?? 0;
    parts.push(`Claude Code (${sessionCount} sessions)`);
  }

  const codex = tools.find(t => t.id === 'codex');
  if (codex?.detected) {
    const threadCount = (codex.details?.threadCount as number) ?? 0;
    parts.push(`Codex (${threadCount} threads)`);
  }

  const ollama = tools.find(t => t.id === 'ollama');
  if (ollama?.detected) {
    parts.push('Ollama ready');
  }

  if (parts.length === 0) {
    return "No tools detected — let's get you set up";
  }

  return parts.join(' · ');
}

function buildDetectionResult(
  tools: DetectedTool[],
  flags: { partial?: boolean; timedOut?: boolean } = {},
  codexVoiceCapability?: CodexVoiceCapability,
): DetectionResult {
  const hasAgentSurface = false;
  const hasCliAgent = tools.some(t => ['codex', 'claude-code', 'antigravity', 'opencode', '3code', 'pi'].includes(t.id) && t.detected);
  const hasApiKey = tools.some(t => t.id === 'api-keys' && t.detected);
  const hasEmbeddings = tools.some(t => t.id === 'ollama' && t.detected);
  const hasAnything = hasAgentSurface || hasCliAgent || hasApiKey;

  let recommendedPath: 'ready' | 'quick-setup' | 'full-wizard';
  if (hasAgentSurface && (hasCliAgent || hasApiKey)) {
    recommendedPath = 'ready';
  } else if (hasAnything) {
    recommendedPath = 'quick-setup';
  } else {
    recommendedPath = 'full-wizard';
  }

  const summary = buildSummary(tools);

  const result: DetectionResult = {
    tools,
    codexVoiceCapability,
    hasAnything,
    hasAgentSurface,
    hasCliAgent,
    hasApiKey,
    hasEmbeddings,
    recommendedPath,
    summary,
    ...flags,
  };
  return result;
}

function isPastDeadline(deadlineAt: number) {
  return Date.now() >= deadlineAt;
}

export async function GET() {
  const deadlineAt = Date.now() + ROUTE_DEADLINE_MS;
  const tools: DetectedTool[] = [];
  let codexVoiceCapability: CodexVoiceCapability | undefined;

  if (!isPastDeadline(deadlineAt)) {
    const codex = detectCodex(deadlineAt);
    tools.push(codex);
    codexVoiceCapability = await probeCodexVoiceCapability({
      binaryPath: codex.path || null,
      version: codex.version ?? null,
      timeoutMs: Math.max(MIN_PROBE_TIMEOUT_MS, boundedTimeout(2_500, deadlineAt)),
    });
  }
  if (!isPastDeadline(deadlineAt)) tools.push(await detectClaudeCode(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(await detectAntigravity(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(await detectOpenCode(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(detect3code(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(detectPi(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(await detectOllama(deadlineAt));
  if (!isPastDeadline(deadlineAt)) tools.push(detectApiKeys());

  const timedOut = isPastDeadline(deadlineAt);
  const result = buildDetectionResult(
    tools,
    timedOut ? { partial: true, timedOut: true } : {},
    codexVoiceCapability,
  );

  return NextResponse.json(result);
}
