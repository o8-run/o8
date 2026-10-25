import { ambientChildEnvironment } from '../../src/lib/providers/ambient-environment';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { preserveRepositoryObjects, restoreRepositoryObjects } from './repository-cache';

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = { maxBuffer: 10 * 1024 * 1024, timeout: 120_000, get env() { return ambientChildEnvironment(); } };

export interface CloneOptions {
  repoUrl: string;
  baseRef: string;
  remoteBranch: string;
  workDir: string;
  cacheDir?: string;
  onCheckout?: (receipt: { cacheHit: boolean; durationMs: number }) => void;
  signal?: AbortSignal;
}

export interface WorkerChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

async function ensureGhAuthIfNeeded(repoUrl: string, signal?: AbortSignal) {
  if (!/github\.com/i.test(repoUrl)) return;
  try {
    await execFileAsync('gh', ['auth', 'status'], { ...EXEC_OPTIONS, signal });
  } catch {
    if (signal?.aborted) throw new Error('[worker/clone-repo] operation aborted');
    if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
      throw new Error(
        '[worker/clone-repo] gh auth status failed and neither GITHUB_TOKEN nor GH_TOKEN is set. Run `gh auth login` or export a token before starting the worker.',
      );
    }
  }
}

function killGitTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === 'win32') { if (child.exitCode === null) child.kill(signal); return; }
  try { process.kill(-child.pid, signal); }
  catch { if (child.exitCode === null) child.kill(signal); }
}

async function runGit(args: string[], cwd?: string, signal?: AbortSignal): Promise<{ stdout: string }> {
  if (signal?.aborted) throw new Error('[worker/clone-repo] operation aborted');
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: ambientChildEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let failure: Error | null = null;
    let forceKill: ReturnType<typeof setTimeout> | null = null;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      killGitTree(child, 'SIGTERM');
      forceKill = setTimeout(() => killGitTree(child, 'SIGKILL'), 5_000);
    };
    const onAbort = () => stop(new Error('[worker/clone-repo] operation aborted'));
    const timeout = setTimeout(() => stop(new Error(`[worker/clone-repo] git ${args[0] ?? 'command'} timed out`)), EXEC_OPTIONS.timeout);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > EXEC_OPTIONS.maxBuffer) stop(new Error('[worker/clone-repo] git output exceeded the limit'));
    });
    child.stderr.on('data', () => { /* Suppress remote URLs and credential-bearing Git diagnostics. */ });
    child.once('error', (error) => { failure = error; });
    child.once('close', (code) => {
      if (failure) killGitTree(child, 'SIGKILL');
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      signal?.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`[worker/clone-repo] git ${args[0] ?? 'command'} failed`));
      else resolve({ stdout });
    });
  });
}

export async function cloneRepoForRun(opts: CloneOptions): Promise<string> {
  const started = performance.now();
  if (opts.signal?.aborted) throw new Error('[worker/clone-repo] operation aborted');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(opts.baseRef)) {
    throw new Error('[worker/clone-repo] baseRef must be a full pinned commit ID');
  }
  if (!opts.repoUrl.trim() || opts.repoUrl.startsWith('-')) {
    throw new Error('[worker/clone-repo] repo URL is invalid');
  }
  await runGit(['check-ref-format', '--branch', opts.remoteBranch], undefined, opts.signal);
  await ensureGhAuthIfNeeded(opts.repoUrl, opts.signal);
  await mkdir(opts.workDir, { recursive: true });

  const cloneTarget = path.join(opts.workDir, 'repo');
  try {
    await mkdir(cloneTarget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('[worker/clone-repo] workDir already has a repo. Pass a fresh --workspace-dir run slot.');
    }
    throw error;
  }

  const baseSha = opts.baseRef.toLowerCase();
  const objectFormat = baseSha.length === 64 ? 'sha256' : 'sha1';
  await runGit(['init', '--quiet', `--object-format=${objectFormat}`, cloneTarget], undefined, opts.signal);
  await runGit(['remote', 'add', 'origin', opts.repoUrl], cloneTarget, opts.signal);
  const cache = opts.cacheDir ? { cacheDir: opts.cacheDir, repoUrl: opts.repoUrl, baseSha, cloneDir: cloneTarget, signal: opts.signal } : null;
  const cacheHit = cache ? await restoreRepositoryObjects(cache) : false;
  if (cacheHit) {
    // Cached bytes are untrusted. Check every object before contacting upstream.
    await runGit(['fsck', '--strict', '--no-reflogs', '--no-dangling'], cloneTarget, opts.signal);
    const cached = await runGit(['rev-parse', '--verify', `${baseSha}^{commit}`], cloneTarget, opts.signal);
    if (cached.stdout.trim() !== baseSha) throw new Error('[worker/clone-repo] repository cache base mismatch');
  }
  // Fetch only the reviewed commit and its checkout; never expand to unrelated history.
  // A hit still fetches upstream: cached data never substitutes for current access.
  await runGit(['fetch', '--depth=1', '--no-tags', ...(cacheHit ? [`--negotiation-tip=${baseSha}`] : []), 'origin', baseSha], cloneTarget, opts.signal);
  const { stdout } = await runGit(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], cloneTarget, opts.signal);
  if (stdout.trim() !== baseSha) throw new Error('[worker/clone-repo] fetched commit does not match the pinned base');
  if (cache && !cacheHit) await preserveRepositoryObjects(cache);
  await runGit(['checkout', '--detach', baseSha], cloneTarget, opts.signal);
  await runGit(['checkout', '-b', opts.remoteBranch, baseSha], cloneTarget, opts.signal);

  opts.onCheckout?.({ cacheHit, durationMs: Math.round(performance.now() - started) });

  return cloneTarget;
}

export async function pushRemoteBranch(cloneDir: string, remoteBranch: string, signal?: AbortSignal): Promise<string> {
  await runGit(['push', '-u', 'origin', remoteBranch], cloneDir, signal);
  const { stdout } = await runGit(['rev-parse', 'HEAD'], cloneDir, signal);
  return stdout.trim();
}

/** Commit agent edits and return the full change set from the pinned base. */
export async function commitWorkerChanges(cloneDir: string, baseSha: string, signal?: AbortSignal): Promise<WorkerChangedFile[]> {
  await runGit(['add', '--all'], cloneDir, signal);
  const staged = await runGit(['diff', '--cached', '--name-only'], cloneDir, signal);
  if (staged.stdout.trim()) {
    await runGit([
      '-c', 'user.name=o8 worker',
      '-c', 'user.email=worker@o8.invalid',
      'commit', '-m', 'feat: complete remote worker task',
    ], cloneDir, signal);
  }
  const status = await runGit(['diff', '--name-status', '-z', '--no-renames', baseSha, 'HEAD'], cloneDir, signal);
  const counts = await runGit(['diff', '--numstat', '-z', '--no-renames', baseSha, 'HEAD'], cloneDir, signal);
  const byPath = new Map<string, { additions: number; deletions: number }>();
  for (const entry of counts.stdout.split('\0').filter(Boolean)) {
    const [added, deleted, filePath] = entry.split('\t');
    if (!filePath) continue;
    byPath.set(filePath, { additions: Number(added) || 0, deletions: Number(deleted) || 0 });
  }
  const fields = status.stdout.split('\0').filter(Boolean);
  const files: WorkerChangedFile[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const marker = fields[i];
    const filePath = fields[i + 1];
    files.push({
      path: filePath,
      status: marker === 'A' ? 'added' : marker === 'D' ? 'deleted' : 'modified',
      ...(byPath.get(filePath) ?? { additions: 0, deletions: 0 }),
    });
  }
  return files;
}
