import { externalMcpBrokerConfig } from './launch-broker';
import { assertMcpTransport } from '@/lib/providers/mcp-launch-policy';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { externalMcpServers, getDb } from '@/lib/db';
import { invalidateSymonMcpToolCache } from '@/lib/mcp/symon-tools-cache';

export type ExternalMcpTransport = 'stdio' | 'http';

type ExternalMcpEnv = Record<string, string>;

export interface ExternalMcpServerRecord {
  id: string;
  /** Optional team scoping — null means global (user-level) */
  teamId: string | null;
  name: string;
  transport: ExternalMcpTransport;
  command: string;
  args: string[];
  argsJson: string;
  env: ExternalMcpEnv | null;
  envJson: string | null;
  /** HTTP servers: explicit URL (same as command for backwards compat) */
  url: string | null;
  /** OAuth bearer token for authenticated HTTP MCP servers */
  oauthToken: string | null;
  enabled: boolean;
  workerInjection: boolean;
  symonInjection: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InsertExternalMcpServerInput {
  /** Optional team ID to scope this server to a specific team */
  teamId?: string | null;
  name: string;
  transport: ExternalMcpTransport;
  command: string;
  args?: string[];
  env?: ExternalMcpEnv | null;
  /** HTTP transport: explicit URL field */
  url?: string | null;
  /** OAuth bearer token for authenticated HTTP servers (stored as-is) */
  oauthToken?: string | null;
  enabled?: boolean;
  workerInjection?: boolean;
  symonInjection?: boolean;
}

export interface UpdateExternalMcpServerInput {
  enabled?: boolean;
  workerInjection?: boolean;
  symonInjection?: boolean;
}

interface ExternalMcpServerRow {
  id: string;
  teamId: string | null;
  name: string;
  transport: ExternalMcpTransport;
  command: string;
  args: string;
  envJson: string | null;
  url: string | null;
  oauthToken: string | null;
  enabled: boolean;
  workerInjection: boolean;
  symonInjection: boolean;
  createdAt: string;
  updatedAt: string;
}

export type OrchestratorMcpServerConfig =
  | {
    type: 'stdio';
    command: string;
    args: string[];
    env?: Record<string, string>;
  }
  | {
    type: 'http';
    url: string;
    /** Optional headers (e.g. Authorization: Bearer <token>) */
    headers?: Record<string, string>;
  };

function requireDb() {
  const db = getDb();
  if (!db) {
    throw new Error('Database unavailable');
  }
  return db;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeArgs(args: string[] | null | undefined): string[] {
  if (!Array.isArray(args)) return [];
  return args.filter((value): value is string => typeof value === 'string');
}

function parseArgsJson(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

function sanitizeEnv(env: ExternalMcpEnv | null | undefined): ExternalMcpEnv | null {
  if (!env || !isRecord(env)) {
    return null;
  }

  const next: ExternalMcpEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const trimmedKey = key.trim();
    if (!trimmedKey || typeof value !== 'string') {
      continue;
    }
    next[trimmedKey] = value;
  }

  return Object.keys(next).length > 0 ? next : null;
}

function parseEnvJson(raw: string | null): ExternalMcpEnv | null {
  if (!raw?.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return sanitizeEnv(isRecord(parsed) ? parsed as ExternalMcpEnv : null);
  } catch {
    return null;
  }
}

function serializeArgs(args: string[] | null | undefined): string {
  return JSON.stringify(sanitizeArgs(args));
}

function serializeEnv(env: ExternalMcpEnv | null | undefined): string | null {
  const sanitized = sanitizeEnv(env);
  return sanitized ? JSON.stringify(sanitized) : null;
}

function toRecord(row: ExternalMcpServerRow): ExternalMcpServerRecord {
  const args = parseArgsJson(row.args);
  const env = parseEnvJson(row.envJson);
  return {
    ...row,
    args,
    argsJson: JSON.stringify(args),
    env,
    envJson: env ? JSON.stringify(env, null, 2) : null,
    url: row.url ?? null,
    oauthToken: row.oauthToken ?? null,
    teamId: row.teamId ?? null,
  };
}

export function listExternalMcpServers(): ExternalMcpServerRecord[] {
  const db = requireDb();
  return db.select()
    .from(externalMcpServers)
    .orderBy(asc(externalMcpServers.createdAt), asc(externalMcpServers.name))
    .all()
    .map((row) => toRecord(row as ExternalMcpServerRow));
}

export function listEnabledExternalMcpServers(): ExternalMcpServerRecord[] {
  // #559 — Hot-path call from orchestrator-session spawn. If the DB connection
  // was opened before the external_mcp_servers table existed (stale ws-server
  // on an old migration marker), treat "no such table" as an empty result
  // instead of logging every spawn. Unexpected errors still propagate.
  try {
    const db = requireDb();
    return db.select()
      .from(externalMcpServers)
      .where(eq(externalMcpServers.enabled, true))
      .orderBy(asc(externalMcpServers.createdAt), asc(externalMcpServers.name))
      .all()
      .map((row) => toRecord(row as ExternalMcpServerRow));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table|external_mcp_servers/i.test(message)) {
      return [];
    }
    throw error;
  }
}

export function insertExternalMcpServer(input: InsertExternalMcpServerInput): ExternalMcpServerRecord {
  const db = requireDb();
  const now = new Date().toISOString();
  const name = input.name.trim();
  const command = input.command.trim();

  if (!name) {
    throw new Error('Server name is required');
  }
  if (!command) {
    throw new Error(input.transport === 'http' ? 'Server URL is required' : 'Command is required');
  }

  const existing = db.select()
    .from(externalMcpServers)
    .where(eq(externalMcpServers.name, name))
    .get();
  if (existing) {
    throw new Error(`An MCP server named "${name}" already exists`);
  }

  // For HTTP transport, normalize: if url is provided use it, fall back to command
  const resolvedUrl = input.transport === 'http'
    ? (input.url?.trim() || command)
    : null;

  const id = randomUUID();
  db.insert(externalMcpServers).values({
    id,
    teamId: input.teamId ?? null,
    name,
    transport: input.transport,
    command,
    args: serializeArgs(input.args),
    envJson: serializeEnv(input.env),
    url: resolvedUrl,
    oauthToken: input.oauthToken?.trim() || null,
    enabled: input.enabled ?? true,
    workerInjection: input.transport === 'stdio' && input.workerInjection === true,
    symonInjection: input.symonInjection === true,
    createdAt: now,
    updatedAt: now,
  }).run();

  const row = db.select().from(externalMcpServers).where(eq(externalMcpServers.id, id)).get();
  if (!row) {
    throw new Error('Failed to create MCP server');
  }
  invalidateSymonMcpToolCache();
  return toRecord(row as ExternalMcpServerRow);
}

export function setExternalMcpServerEnabled(id: string, enabled: boolean): ExternalMcpServerRecord | null {
  return updateExternalMcpServer(id, { enabled });
}

export function updateExternalMcpServer(
  id: string,
  input: UpdateExternalMcpServerInput,
): ExternalMcpServerRecord | null {
  const db = requireDb();
  const now = new Date().toISOString();
  const existing = db.select()
    .from(externalMcpServers)
    .where(eq(externalMcpServers.id, id))
    .get();
  if (!existing) return null;
  if (input.workerInjection === true && existing.transport !== 'stdio') {
    throw new Error('Worker attachment is supported only for stdio MCP servers');
  }

  const updates: Partial<Pick<ExternalMcpServerRow, 'enabled' | 'workerInjection' | 'symonInjection' | 'updatedAt'>> = {
    updatedAt: now,
  };
  if (typeof input.enabled === 'boolean') updates.enabled = input.enabled;
  if (typeof input.workerInjection === 'boolean') updates.workerInjection = input.workerInjection;
  if (typeof input.symonInjection === 'boolean') updates.symonInjection = input.symonInjection;
  const result = db.update(externalMcpServers)
    .set(updates)
    .where(eq(externalMcpServers.id, id))
    .run();

  if ((result.changes ?? 0) <= 0) {
    return null;
  }

  const row = db.select().from(externalMcpServers).where(eq(externalMcpServers.id, id)).get();
  invalidateSymonMcpToolCache();
  return row ? toRecord(row as ExternalMcpServerRow) : null;
}

export function removeExternalMcpServer(id: string): boolean {
  const db = requireDb();
  const result = db.delete(externalMcpServers)
    .where(eq(externalMcpServers.id, id))
    .run();
  if ((result.changes ?? 0) > 0) invalidateSymonMcpToolCache();
  return (result.changes ?? 0) > 0;
}

export function externalServerToMcpConfig(server: ExternalMcpServerRecord, cwd = process.cwd()): OrchestratorMcpServerConfig {
  if (server.transport === 'http') {
    // Use explicit url field if set, fall back to command for backwards compat
    const url = server.url || server.command;
    assertMcpTransport({ url, token: server.oauthToken });
    if (server.oauthToken) {
      return {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${server.oauthToken}` },
      } as OrchestratorMcpServerConfig;
    }
    return { type: 'http', url };
  }

  return externalMcpBrokerConfig(server, cwd);
}
