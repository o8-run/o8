import { withProviderStoreLock } from '@/lib/providers/store-lock';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toOpenclawJson } from '@/lib/mcp/tool-spine/emit-openclaw';
import { sanitizeRuntimeConfigText, copyRuntimeConfigFile } from '@/lib/providers/runtime-config';
import { assertRuntimeProfilesAvailable } from '@/lib/providers/legacy-runtime-config';
export const OPENCLAW_PROFILE = 'o8';
const OPENCLAW_SOURCE_HOME = join(homedir(), '.openclaw');
export const OPENCLAW_SOURCE_CONFIG = join(OPENCLAW_SOURCE_HOME, 'openclaw.json');
const OPENCLAW_O8_HOME = join(homedir(), `.openclaw-${OPENCLAW_PROFILE}`);
export const OPENCLAW_O8_CONFIG = join(OPENCLAW_O8_HOME, 'openclaw.json');

/**
 * Schema version of the generated o8 profile. Bumped whenever the derivation
 * shape changes so a stale profile is re-derived even when its mtime says "up
 * to date" — see `ensureOpenclawProfile`. v4: per-agent auth (auth-profiles.json
 * + auth-state.json) carried. v3: channels/bindings stripped + npm/plugins
 * runtime dirs symlink-borrowed.
 */
const O8_PROFILE_SCHEMA = 4;
/**
 * Sidecar marker holding `O8_PROFILE_SCHEMA`. Lives in ~/.o8 — NOT inside the
 * generated profile — because openclaw's config validator rejects any
 * unrecognized top-level key.
 */
const OPENCLAW_PROFILE_SCHEMA_FILE = join(getDataDir(), 'openclaw-profile-schema');

function governOpenclawAgent(agent: Record<string, unknown>): Record<string, unknown> {
  const tools: Record<string, unknown> = {
    ...((agent.tools as Record<string, unknown> | undefined) ?? {}),
  };
  const deny = Array.isArray(tools.deny)
    ? (tools.deny as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];
  if (!deny.includes('sessions_spawn')) deny.push('sessions_spawn');
  tools.deny = deny;
  if (Array.isArray(tools.alsoAllow)) {
    tools.alsoAllow = (tools.alsoAllow as unknown[]).filter((t) => t !== 'sessions_spawn');
  }

  // OpenClaw 2026.7.1 removed `agents.list[].systemPromptOverride` ("OpenClaw
  // owns the generated system prompt") — writing it makes the WHOLE profile
  // config invalid and the gateway dies before becoming ready (live-hit
  // 2026-07-16, Q's runtime sweep). Strip it from the governed copy (the
  // operator's source agent may still carry the legacy key) and deliver the
  // o8 orchestrator framing per-session instead: sendOpenclawTurn seeds
  // OPENCLAW_ORCHESTRATOR_PROMPT into the session's FIRST message.
  const { systemPromptOverride: _legacy, ...rest } = agent as Record<string, unknown> & {
    systemPromptOverride?: unknown;
  };
  return { ...rest, tools };
}

/**
 * Symlink-borrow a runtime directory from the operator's openclaw into the o8
 * profile — read-only sharing of code that is identical regardless of profile.
 * Used for `npm` (the @openclaw/* plugin packages, including the codex
 * agent-runtime) and `plugins` (the install manifest). Without these the o8
 * gateway loads only bundled plugins → the codex harness is not registered.
 */
function linkProfileDir(name: string): void {
  const src = join(OPENCLAW_SOURCE_HOME, name);
  const dest = join(OPENCLAW_O8_HOME, name);
  if (!existsSync(src)) return;
  try {
    const st = lstatSync(dest);
    if (st.isSymbolicLink()) {
      if (readlinkSync(dest) === src) return; // already linked correctly
      unlinkSync(dest); // stale link — unlink removes the link, never the target
    } else {
      console.warn(`[openclaw-orchestrator] ${dest} exists and is not a symlink — skipping link`);
      return;
    }
  } catch {
    // dest does not exist — fall through to create the symlink.
  }
  symlinkSync(src, dest);
  console.log(`[openclaw-orchestrator] Linked ${dest} -> ${src}`);
}

/**
 * Build the governed o8 profile object from the operator's source openclaw
 * config: headless (channels/bindings dropped), agents governed (#1075), gateway
 * on the dedicated o8 port, and `mcp.servers` locked to o8 ONLY (every other
 * source mcp server is dropped — the governed profile exposes only o8's tools).
 *
 * The o8 entry is supplied by the caller. Post-F that's the Tool-Spine registry
 * projection (o8 owns its own entry) rather than the source passthrough — that
 * is the ONLY value that differs between the old and new behavior; everything
 * else here is a pure function of `source` and is unchanged. Exported for the
 * Step-F containment test.
 */
export function buildGovernedO8Profile(source: Record<string, unknown>, o8Entry: unknown, gatewayPort: number): Record<string, unknown> {
  const sourceAgents = (source.agents as Record<string, unknown> | undefined) ?? {};
  const sourceAgentList = Array.isArray(sourceAgents.list)
    ? (sourceAgents.list as Array<Record<string, unknown>>)
    : [];
  const sourceGateway = (source.gateway as Record<string, unknown> | undefined) ?? {};

  return {
    ...source,
    // Headless orchestrator — drop the operator's messaging surface so the o8
    // gateway never starts their Telegram/Discord. `undefined` keys are omitted
    // by JSON.stringify.
    channels: undefined,
    bindings: undefined,
    agents: {
      ...sourceAgents,
      list: sourceAgentList.map(governOpenclawAgent),
    },
    mcp: { servers: { o8: o8Entry } },
    // Dedicated gateway port — never the operator's personal gateway (:18789).
    gateway: { ...sourceGateway, port: gatewayPort },
  };
}

/**
 * Ensure the isolated `o8` openclaw profile exists at ~/.openclaw-o8.
 *
 * Derives the profile config from the operator's working openclaw config —
 * inheriting auth / models / global tool policy — with these changes:
 *   - `agents.list` becomes governed COPIES of the operator's real agents
 *     (`governOpenclawAgent` — the #1075 lockout);
 *   - only the `o8` MCP server is kept;
 *   - `channels` / `bindings` are stripped — the o8 gateway is a headless
 *     orchestrator and must NOT run the operator's Telegram/Discord;
 *   - `gateway.port` is the dedicated o8 port, never the operator's personal
 *     openclaw gateway (:18789).
 * Profile credentials + each governed agent's per-agent auth are copied, and
 * the npm/plugins runtime dirs are symlink-borrowed, so the isolated profile
 * can authenticate and load the codex harness.
 *
 * Existing profiles are used unchanged. File-based API billing belongs to #4340.
 */
export function prepareOpenclawProfile(gatewayPort: number): void {
  assertRuntimeProfilesAvailable([OPENCLAW_O8_HOME]);
  if (existsSync(OPENCLAW_O8_CONFIG)) return;
  assertOwnedDirectory(OPENCLAW_O8_HOME);
  assertOwnedFile(OPENCLAW_O8_CONFIG);
  if (!existsSync(OPENCLAW_SOURCE_CONFIG)) {
    throw new Error(
      'openclaw is not configured — ~/.openclaw/openclaw.json is missing. '
        + 'Run `openclaw onboard` before using the openclaw orchestrator.',
    );
  }

  const source = JSON.parse(sanitizeRuntimeConfigText(OPENCLAW_SOURCE_CONFIG, readFileSync(OPENCLAW_SOURCE_CONFIG, 'utf8'), 'openclaw')) as Record<string, unknown>;
  mkdirSync(OPENCLAW_O8_HOME, { recursive: true });
  // The plugin runtime (incl. the codex agent-runtime) is symlink-borrowed —
  // ensured every call (cheap), even when the config itself is up to date.
  linkProfileDir('npm');
  linkProfileDir('plugins');

  const sourceAgents = (source.agents as Record<string, unknown> | undefined) ?? {};
  const sourceAgentList = Array.isArray(sourceAgents.list)
    ? (sourceAgents.list as Array<Record<string, unknown>>)
    : [];
  if (sourceAgentList.length === 0) {
    throw new Error('openclaw has no agents configured (agents.list is empty).');
  }
  const sourceMcpServers =
    ((source.mcp as Record<string, unknown> | undefined)?.servers as Record<string, unknown> | undefined) ?? {};

  const o8McpServer = sourceMcpServers.o8;
  if (!o8McpServer) {
    throw new Error(
      'The o8 MCP server is not registered in openclaw (mcp.servers.o8 missing). '
        + 'Register it via o8 Settings -> MCP before using the openclaw orchestrator.',
    );
  }
  // TODO(tool-spine-convergence): this throw is vestigial post-F — o8's mcp entry
  // is now EMITTED from the registry below, not the read sourceMcpServers.o8 (the
  // read survives only as a presence check). Removing the throw = the self-heal
  // (auto-register o8 from the registry), which the spec gates separately.

  // o8 owns its own mcp entry: emit it from the Tool-Spine registry instead of
  // passing through whatever the user pre-registered. repoPath is irrelevant to
  // the openclaw surface (operator-only; cortex/externals filtered out).
  const o8Config = buildGovernedO8Profile(
    source,
    toOpenclawJson(buildToolRegistry(process.cwd())).servers.o8, gatewayPort,
  );

  withProviderStoreLock(() => writeFileSync(OPENCLAW_O8_CONFIG, sanitizeRuntimeConfigText(OPENCLAW_O8_CONFIG, JSON.stringify(o8Config), 'openclaw'), { flag: 'wx', mode: 0o600 }));
  // Schema marker — sidecar in ~/.o8, NOT in the config (openclaw rejects
  // unrecognized keys inside its own config).
  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(OPENCLAW_PROFILE_SCHEMA_FILE, `${O8_PROFILE_SCHEMA}\n`, 'utf8');

  // Seed credentials so the isolated profile can resolve model auth.
  //
  // SEED, don't sync (2026-07-16): OAuth refresh tokens are SINGLE-USE. The
  // old copy-on-every-regen guaranteed a recurring death spiral — the o8
  // profile refreshes (its copy advances, the source's token is now consumed),
  // then the next regen pastes the source's DEAD token back over the o8
  // profile's working one ("Your refresh token has already been used…",
  // live-hit during the runtime sweep). Copy only when the destination is
  // missing. Existing profiles and their tokens are never reconciled here.
  const seedIfMissing = (srcFile: string, destFile: string): void => {
    if (!existsSync(srcFile)) return;
    if (existsSync(destFile)) return;
    assertOwnedDirectory(join(destFile, '..')); assertOwnedFile(destFile);
    mkdirSync(join(destFile, '..'), { recursive: true });
    copyRuntimeConfigFile(srcFile, destFile, 'openclaw');
    try { chmodSync(destFile, 0o600); } catch { /* directories keep their mode */ }
  };

  const sourceCredentials = join(OPENCLAW_SOURCE_HOME, 'credentials');
  const destCredentials = join(OPENCLAW_O8_HOME, 'credentials');
  assertOwnedDirectory(destCredentials);
  if (existsSync(sourceCredentials) && !existsSync(destCredentials)) {
    copyOpenclawCredentials(sourceCredentials, destCredentials);
  }

  // Carry each governed agent's per-agent auth — the credential index that
  // pairs with the encrypted `credentials/` blobs above. COPY, never symlink:
  // openclaw's OAuth refresh writes back here, and ~/.openclaw must stay
  // untouched. `codex-home/` is deliberately NOT carried — it is session/log
  // state, not auth; the o8 codex runtime regenerates its own.
  for (const agent of sourceAgentList) {
    const agentId = typeof agent.id === 'string' ? agent.id : null;
    if (!agentId) continue;
    const srcAgentDir = join(OPENCLAW_SOURCE_HOME, 'agents', agentId, 'agent');
    const destAgentDir = join(OPENCLAW_O8_HOME, 'agents', agentId, 'agent');
    for (const file of ['auth-profiles.json', 'auth-state.json']) {
      seedIfMissing(join(srcAgentDir, file), join(destAgentDir, file));
    }
  }

  console.log(`[openclaw-orchestrator] Wrote o8 profile config to ${OPENCLAW_O8_CONFIG}`);
}


function existingEntry(file: string) {
  try { return lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function assertOwnedDirectory(dir: string): void {
  const inside = relative(OPENCLAW_O8_HOME, dir);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('Invalid OpenClaw overlay path.');
  let current = OPENCLAW_O8_HOME;
  for (const part of ['', ...inside.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    const entry = existingEntry(current);
    if (entry && !entry.isDirectory()) throw new Error('OpenClaw owned credential directories cannot follow links.');
  }
}
function assertOwnedFile(file: string): void {
  const entry = existingEntry(file);
  if (entry && !entry.isFile()) throw new Error('OpenClaw owned credential files cannot follow links.');
}

/** Seed only new files whose original bytes contain no provider credentials. */
function copyOpenclawCredentials(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('OpenClaw credential copies cannot follow links.');
    const from = join(source, entry.name); const to = join(destination, entry.name);
    assertOwnedDirectory(destination);
    if (!entry.isDirectory()) assertOwnedFile(to);
    if (entry.isDirectory()) copyOpenclawCredentials(from, to);
    else if (entry.isFile()) copyRuntimeConfigFile(from, to, 'openclaw');
  }
}
