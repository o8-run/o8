import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getDataDir } from '@/lib/data-dir-migration';
import { ActionPluginError } from './errors';
import type { GithubActionSource } from './source-storage';

export const actionStateSchema = z.object({
  scope: z.literal('source-and-project'),
  environmentKey: z.literal('O8_PLUGIN_STATE_DIR'),
  namespace: z.string().regex(/^[a-f0-9]{64}$/),
  directory: z.string().refine(path.isAbsolute),
}).strict();
export type ActionState = z.infer<typeof actionStateSchema>;
type Owner = { id: string; sourceDirectory: string; workspaceRoot: string | null; source?: GithubActionSource };

function binding(owner: Owner) {
  return {
    pluginId: owner.id,
    source: owner.source
      ? { kind: 'github', repository: owner.source.repository.toLowerCase(), directory: owner.source.directory }
      : { kind: 'local', directory: owner.sourceDirectory },
    workspaceRoot: owner.workspaceRoot,
  };
}
export function describeActionState(owner: Owner): ActionState {
  const namespace = createHash('sha256').update(JSON.stringify(binding(owner))).digest('hex');
  return { scope: 'source-and-project', environmentKey: 'O8_PLUGIN_STATE_DIR', namespace, directory: path.join(getDataDir(), 'customizations', 'action-state', namespace) };
}
function directory(at: string, privateMode: boolean) {
  const stat = lstatSync(at);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (privateMode && ((process.platform !== 'win32' && (stat.mode & 0o077) !== 0) || (process.getuid && stat.uid !== process.getuid())))) {
    throw new ActionPluginError('unsafe_state', 'Plugin state storage must be an owned private directory without links.');
  }
}
function root(create: boolean) {
  let at = getDataDir();
  for (const part of ['', 'customizations', 'action-state']) {
    if (part) at = path.join(at, part);
    if (create && !existsSync(at)) {
      try { mkdirSync(at, { recursive: !part, mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    directory(at, part === 'action-state');
  }
  return at;
}
function verify(owner: Owner, state: ActionState) {
  directory(state.directory, true);
  let fd: number;
  try { fd = openSync(path.join(state.directory, '.scope.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new ActionPluginError('unsafe_state', 'Plugin state ownership metadata is unavailable or linked.'); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      || (process.getuid && stat.uid !== process.getuid()) || readFileSync(fd, 'utf8') !== JSON.stringify(binding(owner))) {
      throw new ActionPluginError('unsafe_state', 'Plugin state ownership metadata changed.');
    }
  } finally { closeSync(fd); }
}
export function provisionActionState(owner: Owner): ActionState {
  const state = describeActionState(owner);
  const base = root(true);
  if (!lstatSync(state.directory, { throwIfNoEntry: false })) {
    const stage = path.join(base, `.stage-${randomUUID()}`);
    mkdirSync(stage, { mode: 0o700 });
    try {
      writeFileSync(path.join(stage, '.scope.json'), JSON.stringify(binding(owner)), { flag: 'wx', mode: 0o600 });
      renameSync(stage, state.directory);
    } finally { rmSync(stage, { recursive: true, force: true }); }
  }
  verify(owner, state);
  return state;
}
export function clearActionState(owner: Owner) {
  const state = describeActionState(owner);
  try { root(false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { cleared: false, cleanupPending: false }; throw error; }
  try { verify(owner, state); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { cleared: false, cleanupPending: false }; throw error; }
  const trash = path.join(root(false), `.removed-${randomUUID()}`);
  renameSync(state.directory, trash);
  try { rmSync(trash, { recursive: true }); return { cleared: true, cleanupPending: false }; }
  catch { return { cleared: true, cleanupPending: true }; }
}
