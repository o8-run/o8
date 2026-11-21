import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from '@/lib/providers/child-process';
import { EMBEDDED_CHILD_POLICY_SCRIPT } from '@/lib/providers/embedded-child-policy';
import { constants, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { getDataDir } from '@/lib/data-dir-migration';
import { createBroadcastRedactionContext, redactBroadcastText } from '@/lib/broadcast/redaction';
import { resolveScope } from '@/lib/customize/storage';
import { ActionPluginError } from './errors';
import { acquiredSource, githubSourceSchema, type GithubActionSource } from './source-storage';
import { verifyGithubFiles } from './github-files';
import { actionStateSchema, clearActionState, describeActionState, provisionActionState, type ActionState } from './state-storage';
import { pluginTerminalEnvironment, requirePluginTerminalRuntime, startPluginTerminal, stopPluginTerminal } from './terminal-runtime';

import {
  actionPluginRoot as root, lifecycle, openActionReceiptDb as db, readTerminalReceipts, refreshTerminalReceipt,
  saveTerminalReceipt, type PluginTerminalReceipt,
} from './receipts';

export { ActionPluginError } from './errors';
export { pluginTerminalReceipts, pluginTerminalSessionReferences } from './receipts';
export type { PluginTerminalReceipt } from './receipts';

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
const fileName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).max(128).refine((name) => name !== '.' && name !== '..' && name !== 'installed.json' && name !== 'o8-actions.json');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
// Keep the action in a separate process group, with an IPC watchdog that survives
// the host long enough to terminate the group if the host exits unexpectedly.
const actionRunner = EMBEDDED_CHILD_POLICY_SCRIPT + String.raw`
const { spawn } = require('node:child_process');
const entry = process.argv[1];
const args = process.argv.slice(2);
const stop = () => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } };
process.on('disconnect', stop);
process.on('SIGTERM', stop);
const timer = setTimeout(stop, Number(process.env.O8_ACTION_TIMEOUT_MS) + 1000);
let action;
try { action = withO8ChildPolicy(env => spawn(entry, args, { stdio: ['ignore', 'inherit', 'inherit'], env }), { env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV, ...(process.env.O8_PLUGIN_STATE_DIR ? { O8_PLUGIN_STATE_DIR: process.env.O8_PLUGIN_STATE_DIR } : {}) } }); }
catch (error) { process.send?.({ type: 'spawn_error', message: error.message }, () => process.exit(1)); }
if (action) {
  action.on('error', (error) => process.send?.({ type: 'spawn_error', message: error.message }, () => process.exit(1)));
  action.on('exit', (code) => {
    clearTimeout(timer);
    process.send?.({ type: 'complete', code }, stop);
  });
}
`;
export const actionManifestSchema = z.object({
  format: z.literal('o8-actions-v1'),
  id: slug,
  name: z.string().trim().min(1).max(100),
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  description: z.string().trim().min(1).max(500),
  supportedPlatforms: z.array(z.enum(['darwin', 'linux'])).min(1).max(2).refine((items) => new Set(items).size === items.length),
  workspace: z.enum(['none', 'registered-project']),
  state: z.object({ scope: z.literal('source-and-project') }).strict().optional(),
  files: z.array(z.object({ path: fileName, sha256: digest }).strict()).min(1).max(12),
  actions: z.array(z.object({
    id: slug,
    description: z.string().trim().min(1).max(500),
    entry: fileName,
    args: z.array(z.string().max(256).refine((arg) => !arg.includes('\0'), 'Arguments cannot contain NUL characters.')).max(16).default([]),
    timeoutMs: z.number().int().min(100).max(30_000),
  }).strict()).max(12),
  terminals: z.array(z.object({
    id: slug,
    description: z.string().trim().min(1).max(500),
    entry: fileName,
    args: z.array(z.string().max(256).refine((arg) => !arg.includes('\0'), 'Arguments cannot contain NUL characters.')).max(16).default([]),
  }).strict()).min(1).max(12).optional(),
}).strict().superRefine((manifest, ctx) => {
  if (new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length) ctx.addIssue({ code: 'custom', message: 'Duplicate files' });
  if (new Set(manifest.actions.map((action) => action.id)).size !== manifest.actions.length) ctx.addIssue({ code: 'custom', message: 'Duplicate actions' });
  for (const action of manifest.actions) if (!manifest.files.some((file) => file.path === action.entry)) ctx.addIssue({ code: 'custom', message: 'Action entry is not a declared file' });
  if (!manifest.actions.length && !manifest.terminals?.length) ctx.addIssue({ code: 'custom', message: 'Declare an action or a terminal' });
  if (manifest.terminals && new Set(manifest.terminals.map((terminal) => terminal.id)).size !== manifest.terminals.length) ctx.addIssue({ code: 'custom', message: 'Duplicate terminals' });
  for (const terminal of manifest.terminals ?? []) if (!manifest.files.some((file) => file.path === terminal.entry)) ctx.addIssue({ code: 'custom', message: 'Terminal entry is not a declared file' });
});
export type ActionManifest = z.infer<typeof actionManifestSchema>;
type Saved = { manifest: ActionManifest; revision: string; enabled: boolean; linkedAt: string; sourceDirectory: string; workspaceRoot: string | null; source?: GithubActionSource };
function sha(data: Buffer | string) { return createHash('sha256').update(data).digest('hex'); }
function revisionFor(manifest: ActionManifest, workspaceRoot: string | null, sourceDirectory: string, source?: GithubActionSource) { return sha(JSON.stringify({ manifest, workspaceRoot, sourceDirectory, ...(source ? { source } : {}) })); }
function sourceDir(input: string) {
  if (!path.isAbsolute(input)) throw new ActionPluginError('unsafe_path', 'Choose an absolute local folder.');
  let at = path.parse(input).root;
  for (const part of input.slice(at.length).replace(/\/+$/, '').split(path.sep)) {
    if (!part || part === '.' || part === '..') throw new ActionPluginError('unsafe_path', 'Linked folders and traversal are not allowed.');
    at = path.join(at, part);
    const stat = lstatSync(at);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ActionPluginError('unsafe_path', 'Linked folders are not allowed.');
  }
  return at;
}
function safeFile(dir: string, name: string, limit: number) {
  const file = path.join(dir, name);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw new ActionPluginError('unsafe_file', 'Action file is linked, oversized, or invalid.');
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const data = readFileSync(fd);
    if (data.length > limit) throw new ActionPluginError('too_large', 'Action file is too large.');
    return data;
  } finally { closeSync(fd); }
}
export async function reviewActionSource(directory: string, repo?: string, signal?: AbortSignal) {
  const dir = sourceDir(directory);
  const manifestBytes = safeFile(dir, 'o8-actions.json', 64 * 1024);
  const manifest = actionManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  const source = acquiredSource(dir, manifestBytes);
  if (manifest.workspace === 'registered-project' && repo === undefined) throw new ActionPluginError('invalid_workspace', 'Choose a registered repository for review.');
  const workspaceRoot = manifest.workspace === 'none' ? null : await resolveScope(repo);
  if (manifest.workspace === 'registered-project' && !workspaceRoot) throw new ActionPluginError('invalid_workspace', 'Choose a registered repository for review.');
  const sourceFiles = [{ path: 'o8-actions.json', data: manifestBytes }];
  const files = manifest.files.map((file) => {
    const data = safeFile(dir, file.path, 1024 * 1024);
    sourceFiles.push({ path: file.path, data });
    if (sha(data) !== file.sha256) throw new ActionPluginError('digest_mismatch', `File ${file.path} changed or does not match its digest.`, 409);
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { throw new ActionPluginError('unreviewable_file', `File ${file.path} is not UTF-8 text and cannot be reviewed in this version.`); }
    if (content.includes('\0')) throw new ActionPluginError('unreviewable_file', `File ${file.path} contains NUL bytes and cannot be reviewed in this version.`);
    return { path: file.path, bytes: data.length, sha256: file.sha256, content };
  });
  if (source) await verifyGithubFiles(source, sourceFiles, signal);
  const state = manifest.state ? describeActionState({ id: manifest.id, sourceDirectory: dir, workspaceRoot, source }) : undefined;
  return {
    manifest, revision: revisionFor(manifest, workspaceRoot, dir, source), files, sourceDirectory: dir, ...(source ? { source } : {}),
    execution: { cwd: workspaceRoot ?? path.join(getDataDir(), 'customizations', 'actions', manifest.id), environmentKeys: ['PATH', 'NODE_ENV', ...(state ? [state.environmentKey] : [])], principal: 'local-user' as const, ...(state ? { state } : {}), ...(manifest.terminals ? { terminalEnvironmentKeys: Object.keys(pluginTerminalEnvironment(state?.directory)) } : {}) },
    workspaceRoot,
  };
}
function savedPath(id: string) { return path.join(root(false), slug.parse(id), 'installed.json'); }
function readSaved(id: string): Saved {
  const dir = path.dirname(savedPath(id));
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new ActionPluginError('unsafe_path', 'Invalid installation.');
  const saved = JSON.parse(safeFile(dir, 'installed.json', 64 * 1024).toString('utf8')) as Saved;
  const manifest = actionManifestSchema.parse(saved.manifest);
  const source = saved.source === undefined ? undefined : githubSourceSchema.parse(saved.source);
  if (manifest.id !== id || typeof saved.sourceDirectory !== 'string' || (saved.workspaceRoot !== null && typeof saved.workspaceRoot !== 'string')
    || saved.revision !== revisionFor(manifest, saved.workspaceRoot, saved.sourceDirectory, source) || typeof saved.enabled !== 'boolean') throw new ActionPluginError('damaged', 'Action installation is damaged.');
  return { ...saved, manifest };
}
function refuseRunning(database: Database.Database, id: string) {
  for (const terminal of readTerminalReceipts(database, id)) {
    if (['launching', 'running'].includes(refreshTerminalReceipt(database, terminal).status)) throw new ActionPluginError('busy', 'Stop this plugin’s active or pending terminal before changing its installation or saved data.', 409);
  }
  const now = new Date().toISOString();
  database.prepare("UPDATE receipts SET status = 'interrupted', finished_at = ?, error = 'Host stopped before completion' WHERE plugin_id = ? AND status = 'running' AND started_at < ?")
    .run(now, id, new Date(Date.now() - 60_000).toISOString());
  const active = database.prepare("SELECT id FROM receipts WHERE plugin_id = ? AND status = 'running' LIMIT 1").get(id);
  if (active) throw new ActionPluginError('busy', 'An action from this plugin is running.', 409);
}

export async function launchPluginTerminal(input: { id: string; terminalId: string; revision: string; requestId: string; repo?: string }) {
  const requestId = z.string().uuid().parse(input.requestId).toLowerCase();
  const dir = path.dirname(savedPath(input.id));
  const cwd = input.repo === undefined ? dir : await resolveScope(input.repo);
  if (!cwd) throw new ActionPluginError('invalid_workspace', 'Choose a registered repository for this terminal.');
  const claim = lifecycle((database) => {
    const saved = readSaved(input.id);
    if (saved.revision !== input.revision) throw new ActionPluginError('conflict', 'Plugin changed since review.', 409);
    if (!saved.enabled) throw new ActionPluginError('disabled', 'Plugin is disabled.', 409);
    if (!saved.manifest.supportedPlatforms.includes(process.platform as 'darwin' | 'linux')) throw new ActionPluginError('unsupported_platform', 'This plugin does not support this platform.', 409);
    if ((saved.manifest.workspace === 'registered-project') !== (input.repo !== undefined) || saved.workspaceRoot !== (input.repo === undefined ? null : cwd)) throw new ActionPluginError('invalid_workspace', 'Use the repository selected during review.', 409);
    const terminal = saved.manifest.terminals?.find((item) => item.id === input.terminalId);
    if (!terminal) throw new ActionPluginError('not_found', 'Terminal entrypoint does not exist.', 404);
    const previous = readTerminalReceipts(database).find((receipt) => receipt.id === requestId);
    if (previous) {
      if (previous.pluginId !== input.id || previous.terminalId !== input.terminalId || previous.revision !== input.revision || previous.workspaceRoot !== saved.workspaceRoot) throw new ActionPluginError('conflict', 'Launch request belongs to another terminal.', 409);
      return { receipt: refreshTerminalReceipt(database, previous), created: false };
    }
    if (['0', 'false', 'off', 'no'].includes(process.env.O8_PERSISTENT_TERMINALS?.trim().toLowerCase() ?? '')) throw new ActionPluginError('persistence_disabled', 'Enable persistent terminals before launching a plugin terminal.', 409);
    for (const file of saved.manifest.files) if (sha(safeFile(dir, file.path, 1024 * 1024)) !== file.sha256) throw new ActionPluginError('damaged', 'Plugin file changed after linking.', 409);
    refuseRunning(database, input.id);
    requirePluginTerminalRuntime();
    const state = saved.manifest.state ? provisionActionState({ ...saved, id: input.id }) : null;
    const receipt: PluginTerminalReceipt = {
      id: requestId, pluginId: input.id, terminalId: input.terminalId, revision: input.revision,
      sessionName: `cortex-dash-${requestId.replaceAll('-', '')}`, label: `${saved.manifest.name} / ${terminal.id}`,
      workspaceRoot: saved.workspaceRoot, source: saved.source ?? null, state, actor: 'local-operator',
      startedAt: new Date().toISOString(), finishedAt: null, status: 'launching', exitCode: null, error: null,
    };
    saveTerminalReceipt(database, receipt);
    return { receipt, created: true };
  });
  if (!claim.created) return claim.receipt;
  // The claim is durable before process creation. Holding a separate lifecycle
  // lock across spawn serializes stop/remove/clear without rolling back that
  // recovery record if the host dies before publishing the launch result.
  return lifecycle((database) => {
    const receipt = readTerminalReceipts(database).find((item) => item.id === requestId);
    if (!receipt) throw new ActionPluginError('damaged', 'Terminal launch receipt is missing.', 409);
    if (receipt.status !== 'launching') return receipt;
    try {
      const saved = readSaved(input.id);
      if (!saved.enabled || saved.revision !== input.revision) throw new ActionPluginError('conflict', 'Plugin changed before terminal launch.', 409);
      const terminal = saved.manifest.terminals?.find((item) => item.id === input.terminalId);
      if (!terminal) throw new ActionPluginError('not_found', 'Terminal entrypoint does not exist.', 404);
      for (const file of saved.manifest.files) if (sha(safeFile(dir, file.path, 1024 * 1024)) !== file.sha256) throw new ActionPluginError('damaged', 'Plugin file changed before terminal launch.', 409);
      const current = startPluginTerminal({ sessionName: receipt.sessionName, cwd, entry: path.join(dir, terminal.entry), args: terminal.args, stateDirectory: receipt.state?.directory });
      return saveTerminalReceipt(database, { ...receipt, ...current });
    } catch (error) {
      // A tmux timeout may occur after creation. Keep the durable reservation
      // until inspection proves its state or the operator explicitly stops it.
      return refreshTerminalReceipt(database, saveTerminalReceipt(database, { ...receipt, error: error instanceof ActionPluginError ? error.message : 'Terminal launch outcome is unresolved. Inspect or stop this session before launching again.' }));
    }
  });
}
export function stopPluginTerminalRun(receiptId: string) {
  return lifecycle((database) => {
    const receipt = readTerminalReceipts(database).find((item) => item.id === receiptId.toLowerCase());
    if (!receipt) throw new ActionPluginError('not_found', 'Terminal receipt does not exist.', 404);
    if (receipt.status === 'stopped') return receipt;
    stopPluginTerminal(receipt.sessionName);
    return saveTerminalReceipt(database, { ...receipt, status: 'stopped', finishedAt: receipt.finishedAt ?? new Date().toISOString() });
  });
}
export function listActionPlugins() {
  let dir: string;
  try { dir = root(false); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { installed: [], damaged: [] }; throw error; }
  const installed: Array<Saved & { state?: ActionState }> = []; const damaged: string[] = [];
  for (const id of readdirSync(dir).filter((name) => slug.safeParse(name).success)) {
    try {
      const saved = readSaved(id);
      installed.push({ ...saved, ...(saved.manifest.state ? { state: describeActionState({ ...saved, id }) } : {}) });
    } catch { damaged.push(id); }
  }
  return { installed, damaged };
}
export async function linkActionSource(directory: string, expectedRevision: string, repo?: string, signal?: AbortSignal) {
  const reviewed = await reviewActionSource(directory, repo, signal);
  if (reviewed.manifest.workspace === 'none' && repo !== undefined) throw new ActionPluginError('invalid_workspace', 'This action does not use a repository.');
  if (reviewed.revision !== expectedRevision) throw new ActionPluginError('conflict', 'Source changed since review.', 409);
  return lifecycle(() => {
    const base = root(true);
    const destination = path.join(base, reviewed.manifest.id);
    if (existsSync(destination)) throw new ActionPluginError('already_linked', 'This action plugin is already linked.', 409);
    const stage = path.join(base, `.stage-${randomUUID()}`);
    mkdirSync(stage, { mode: 0o700 });
    try {
      const currentBytes = safeFile(sourceDir(directory), 'o8-actions.json', 64 * 1024);
      const currentManifest = actionManifestSchema.parse(JSON.parse(currentBytes.toString('utf8')));
      const currentSource = acquiredSource(reviewed.sourceDirectory, currentBytes);
      if (revisionFor(currentManifest, reviewed.workspaceRoot, reviewed.sourceDirectory, currentSource) !== expectedRevision) throw new ActionPluginError('conflict', 'Source changed during linking.', 409);
      for (const file of reviewed.manifest.files) {
        const data = safeFile(sourceDir(directory), file.path, 1024 * 1024);
        if (sha(data) !== file.sha256) throw new ActionPluginError('conflict', 'Source changed during linking.', 409);
        writeFileSync(path.join(stage, file.path), data, { flag: 'wx', mode: 0o700 });
      }
      const saved: Saved = { manifest: reviewed.manifest, revision: reviewed.revision, enabled: true, linkedAt: new Date().toISOString(), sourceDirectory: reviewed.sourceDirectory, workspaceRoot: reviewed.workspaceRoot, ...(reviewed.source ? { source: reviewed.source } : {}) };
      writeFileSync(path.join(stage, 'installed.json'), JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
      renameSync(stage, destination);
      return saved;
    } finally { rmSync(stage, { recursive: true, force: true }); }
  });
}
export function changeActionPlugin(id: string, revision: string, action: 'enable' | 'disable' | 'remove') {
  return lifecycle((database) => {
    refuseRunning(database, id);
    const saved = readSaved(id);
    if (revision !== saved.revision) throw new ActionPluginError('conflict', 'Plugin changed since review.', 409);
    const dir = path.dirname(savedPath(id));
    if (action === 'remove') {
      const trash = path.join(root(false), `.removed-${randomUUID()}`);
      renameSync(dir, trash);
      try { rmSync(trash, { recursive: true }); return { cleanupPending: false }; }
      catch { return { cleanupPending: true }; }
    }
    const temporary = path.join(dir, `.save-${randomUUID()}`);
    try {
      writeFileSync(temporary, JSON.stringify({ ...saved, enabled: action === 'enable' }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path.join(dir, 'installed.json'));
    } finally { rmSync(temporary, { force: true }); }
    return { cleanupPending: false };
  });
}
export function clearActionPluginState(id: string, revision: string) {
  return lifecycle((database) => {
    refuseRunning(database, id);
    const saved = readSaved(id);
    if (saved.revision !== revision) throw new ActionPluginError('conflict', 'Plugin changed since review.', 409);
    if (!saved.manifest.state) throw new ActionPluginError('state_not_declared', 'This plugin does not declare persistent state.', 409);
    return clearActionState({ ...saved, id });
  });
}
export async function invokeActionPlugin(id: string, actionId: string, actor = 'local-operator', signal?: AbortSignal, expectedRevision?: string, repo?: string) {
  if (process.platform === 'win32') throw new ActionPluginError('unsupported_platform', 'Executable actions are not available on Windows in this version.', 409);
  const saved = readSaved(id);
  if (expectedRevision !== saved.revision) throw new ActionPluginError('conflict', 'Plugin changed since review.', 409);
  if (!saved.enabled) throw new ActionPluginError('disabled', 'Action plugin is disabled.', 409);
  if (!saved.manifest.supportedPlatforms.includes(process.platform as 'darwin' | 'linux')) throw new ActionPluginError('unsupported_platform', 'This action plugin does not support this platform.', 409);
  const dir = path.dirname(savedPath(id));
  if (saved.manifest.workspace === 'none' && repo !== undefined) throw new ActionPluginError('invalid_workspace', 'This action does not use a repository.');
  if (saved.manifest.workspace === 'registered-project' && repo === undefined) throw new ActionPluginError('invalid_workspace', 'Choose a registered repository for this action.');
  const cwd = repo === undefined ? dir : await resolveScope(repo);
  if (!cwd) throw new ActionPluginError('invalid_workspace', 'Choose a registered repository for this action.');
  const receiptId = randomUUID();
  const startedAt = new Date().toISOString();
  const claimed = lifecycle((database) => {
      const fresh = readSaved(id);
      if (expectedRevision !== fresh.revision) throw new ActionPluginError('conflict', 'Plugin changed since review.', 409);
      if (!fresh.enabled) throw new ActionPluginError('disabled', 'Action plugin is disabled.', 409);
      if (fresh.workspaceRoot !== (repo === undefined ? null : cwd)) throw new ActionPluginError('invalid_workspace', 'Use the repository selected during review.', 409);
      if (!fresh.manifest.supportedPlatforms.includes(process.platform as 'darwin' | 'linux')) throw new ActionPluginError('unsupported_platform', 'This action plugin does not support this platform.', 409);
      const currentAction = fresh.manifest.actions.find((candidate) => candidate.id === actionId);
      if (!currentAction) throw new ActionPluginError('not_found', 'Action does not exist.', 404);
      for (const file of fresh.manifest.files) if (sha(safeFile(dir, file.path, 1024 * 1024)) !== file.sha256) throw new ActionPluginError('damaged', 'Action file changed after linking.', 409);
      refuseRunning(database, id);
      if (fresh.manifest.state && signal?.aborted) throw new ActionPluginError('cancelled', 'Run cancelled before state provisioning.', 409);
      const state = fresh.manifest.state ? provisionActionState({ ...fresh, id }) : undefined;
      database.prepare('INSERT INTO receipts (id, plugin_id, action_id, actor, revision, status, started_at, source_metadata, state_metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(receiptId, id, actionId, actor, fresh.revision, 'running', startedAt, fresh.source ? JSON.stringify(fresh.source) : null, state ? JSON.stringify(state) : null);
      return { saved: fresh, action: currentAction, state };
  });
  const action = claimed.action;
  const result = await new Promise<{ status: string; exitCode: number | null; stdout: string; stderr: string; error: string | null }>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, ['-e', actionRunner, path.join(dir, action.entry), ...action.args], { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: process.env.NODE_ENV ?? 'production', O8_ACTION_TIMEOUT_MS: String(action.timeoutMs), ...(claimed.state ? { O8_PLUGIN_STATE_DIR: claimed.state.directory } : {}) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: true });
    } catch (error) {
      resolve({ status: 'spawn_error', exitCode: null, stdout: '', stderr: '', error: error instanceof Error ? error.message : 'Could not start action.' });
      return;
    }
    let stdout = ''; let stderr = ''; let outputBytes = 0; let retainedBytes = 0; let done = false;
    let cause: 'timeout' | 'cancelled' | 'output_limit' | 'spawn_error' | null = null;
    let failureDetail: string | null = null;
    let actionExitCode: number | null = null;
    const killGroup = () => {
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else child.kill('SIGKILL');
    };
    const stop = (reason: 'timeout' | 'cancelled' | 'output_limit') => {
      cause ??= reason;
      killGroup();
    };
    const timer = setTimeout(() => stop('timeout'), action.timeoutMs);
    const aborted = () => stop('cancelled');
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
    const collect = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      outputBytes += chunk.length;
      const retained = chunk.subarray(0, Math.max(0, 64 * 1024 - retainedBytes));
      retainedBytes += retained.length;
      const value = retained.toString('utf8');
      if (kind === 'stdout') stdout += value;
      else stderr += value;
      if (outputBytes > 64 * 1024) stop('output_limit');
    };
    child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const report = message as { type?: string; code?: number | null; message?: string };
      if (report.type === 'complete') actionExitCode = typeof report.code === 'number' ? report.code : null;
      if (report.type === 'spawn_error') { cause = 'spawn_error'; failureDetail = report.message ?? 'Could not start action.'; }
    });
    child.on('error', (error) => { cause = 'spawn_error'; failureDetail = error.message; });
    child.on('exit', () => { killGroup(); });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      killGroup();
      resolve({ status: cause ?? (actionExitCode === 0 ? 'succeeded' : 'failed'), exitCode: actionExitCode ?? code, stdout, stderr, error: failureDetail ?? cause });
    });
  });
  const finishedAt = new Date().toISOString();
  let safeResult: typeof result;
  try {
    const redaction = createBroadcastRedactionContext();
    safeResult = { ...result, stdout: redactBroadcastText(result.stdout, redaction), stderr: redactBroadcastText(result.stderr, redaction), error: result.error ? redactBroadcastText(result.error, redaction) : null };
  } catch {
    safeResult = { ...result, stdout: '[redacted-output]', stderr: '[redacted-output]', error: result.error ? '[redacted-error]' : null };
  }
  const receipt = { id: receiptId, pluginId: id, actionId, actor, actorKind: 'authorization-class' as const, actorIdentity: null, revision: claimed.saved.revision, source: claimed.saved.source ?? null, state: claimed.state ?? null, startedAt, finishedAt, ...safeResult };
  const finishDb = db();
  try { finishDb.prepare('UPDATE receipts SET status = ?, finished_at = ?, exit_code = ?, stdout = ?, stderr = ?, error = ? WHERE id = ?').run(safeResult.status, finishedAt, safeResult.exitCode, safeResult.stdout, safeResult.stderr, safeResult.error, receiptId); }
  finally { finishDb.close(); }
  return receipt;
}
export function actionReceipts(id?: string) {
  const database = db();
  try {
    const rows = id ? database.prepare('SELECT * FROM receipts WHERE plugin_id = ? ORDER BY started_at DESC LIMIT 100').all(slug.parse(id)) : database.prepare('SELECT * FROM receipts ORDER BY started_at DESC LIMIT 100').all();
    return rows.map((row) => {
      const { source_metadata: metadata, state_metadata: stateMetadata, ...receipt } = row as Record<string, unknown>;
      let source: GithubActionSource | null = null;
      let state: ActionState | null = null;
      try { if (typeof metadata === 'string') source = githubSourceSchema.parse(JSON.parse(metadata)); } catch { /* Never present malformed origin metadata as verified source. */ }
      try { if (typeof stateMetadata === 'string') state = actionStateSchema.parse(JSON.parse(stateMetadata)); } catch { /* Malformed historical state metadata is not an approved scope. */ }
      return { ...receipt, source, state, actorKind: 'authorization-class' as const, actorIdentity: null };
    });
  }
  finally { database.close(); }
}
