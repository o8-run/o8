import { isAbsolute, basename } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { scope, repos, type Repo } from './scope';
import { trim, type Args, type Json } from './transport';
import { run, prefix } from './process';

export async function gitRepo(args: Args, signal: AbortSignal): Promise<Repo> {
  if (!trim(args, 'repo') && !trim(args, 'repoId') && !trim(args, 'repoPath')) throw new Error("which repo? (e.g. 'o8')");
  return (await scope(args, signal, true))!;
}
const error = (error: string, detail: string): Json => ({ error, detail });
export async function commitDiff(args: Args, signal: AbortSignal): Promise<Json> {
  const requested = trim(args, 'repoPath');
  if (!requested || !isAbsolute(requested) || requested.split('/').some(p => p === '..' || p === '.')) return error('repo_not_tracked', 'repo_commit_diff requires an exact tracked repoPath');
  let repo: Repo;
  let registered: Repo[];
  try { registered = await repos(signal); }
  catch (e) { signal.throwIfAborted(); return error('repo_registry_unavailable', e instanceof Error ? e.message : 'Repository registry unavailable'); }
  try {
    const target = registered.find(r => r.path === requested);
    if (!target) return error('repo_not_tracked', 'repo_commit_diff refused untracked repository path');
    repo = (await scope({ ...args, repoId: trim(args, 'repoId') || target.id, repoPath: requested }, signal, true))!;
    if (!(await stat(repo.path)).isDirectory()) throw new Error('The tracked repository path no longer resolves');
    repo = { ...repo, path: await realpath(repo.path) };
  } catch (e) { signal.throwIfAborted(); return error('repo_not_tracked', e instanceof Error ? e.message : 'The tracked repository path no longer resolves'); }
  if (typeof args.sha !== 'string') return error('invalid_ref', 'repo_commit_diff requires sha');
  const ref = trim(args, 'sha');
  if (!ref || Buffer.byteLength(ref) > 128 || ref.startsWith('-') || !/^[a-zA-Z0-9._/~^-]+$/.test(ref)) return error('invalid_ref', 'repo_commit_diff ref must be 1-128 characters using only letters, numbers, . _ / ~ ^ and -, and must not start with -');
  const git = (a: string[], raw = false) => run('git', a, repo.path, signal, raw);
  try {
    await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
    const show = (format: string, file?: string) => git(['--literal-pathspecs', 'show', '--no-color', '--no-ext-diff', `--format=${format}`, ref, '--', ...(file === undefined ? [] : [file])]);
    if (typeof args.file === 'string') {
      const file = trim(args, 'file');
      if (!file || Buffer.byteLength(file) > 1024 || isAbsolute(file) || file.split('/').some(p => p === '..' || p === '.')) return error('repo_not_tracked', 'repo_commit_diff file must stay within the tracked repository');
      const patch = await show('fuller', file);
      if (!patch.includes('diff --git ')) return error('empty_result', `Commit ${ref} does not contain a patch for '${file}'`);
      const truncated = Buffer.byteLength(patch) > 15 * 1024;
      const marker = `\n… patch for ${prefix(file, 160)} truncated\n`;
      return { patch: truncated ? prefix(patch, 15 * 1024 - Buffer.byteLength(marker)) + marker : patch, truncated, omittedFiles: 0 };
    }
    let metadata = await git(['show', '--no-color', '--no-ext-diff', '--format=fuller', '--no-patch', ref, '--']);
    if (Buffer.byteLength(metadata) > 4096) metadata = prefix(metadata, 4096) + '\n… commit metadata truncated\n';
    const files = (await git(['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', ref, '--'], true)).split('\0').filter(Boolean);
    if (!files.length) return error('empty_result', `Commit ${ref} contains no patch`);
    let output = metadata + (metadata ? '\n' : '');
    for (const [index, file] of files.entries()) {
      const patch = await show('', file), separator = output.endsWith('\n') ? '' : '\n';
      if (Buffer.byteLength(output + separator + patch) <= 15 * 1024) { output += separator + patch; continue; }
      output += separator;
      const omitted = files.length - index - 1;
      output += prefix(patch, Math.max(0, 15 * 1024 - Buffer.byteLength(output))) + `\n… patch for ${prefix(file, 160)} truncated\n` + (omitted ? `… ${omitted} more files omitted\n` : '');
      return { patch: output, truncated: true, omittedFiles: omitted };
    }
    return output.includes('diff --git ') ? { patch: output, truncated: false, omittedFiles: 0 } : error('empty_result', `Commit ${ref} contains no patch`);
  } catch (e) { signal.throwIfAborted(); return error('sha_not_found', `repo_commit_diff could not inspect ${ref}: ${e instanceof Error ? e.message : 'git failed'}`); }
}
export async function gitRead(tool: string, args: Args, signal: AbortSignal): Promise<Json> {
  if (tool === 'repo_commit_diff') return commitDiff(args, signal);
  const repo = await gitRepo(args, signal);
  const count = typeof args.count === 'number' && Number.isInteger(args.count) && args.count >= 0 ? Math.max(1, Math.min(30, args.count)) : 10;
  const output = await run('git', tool === 'git_status' ? ['status', '--short', '--branch'] : ['log', '--oneline', `-n${count}`, '--'], repo.path, signal);
  return { [tool === 'git_status' ? 'status' : 'commits']: output };
}
export const repoLabel = (repo: Repo) => repo.name || basename(repo.path);
