import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from '@/lib/providers/child-process';
import { listRepos } from '@/lib/repos/registry';
import { normalizeRepoSlug } from '@/lib/github-broker/repo';
import { NextResponse } from 'next/server';
import { githubInstallationFetch } from '@/lib/github-broker/auth';

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';

/** Read-only timing and nullable mergeability omitted by the compact PR mirror. */
export async function GET(request: Request, { params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  const repo = new URL(request.url).searchParams.get('repo') ?? '';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) {
    return NextResponse.json({ error: 'Invalid pull request address.' }, { status: 400 });
  }
  try {
    const options = { signal: AbortSignal.timeout(18_000) };
    const metadata = await githubInstallationFetch(repo, `/repos/${repo}/pulls/${number}`, options, { priority: 'background' });
    if (!metadata.response.ok) throw new Error('PR unavailable');
    const pr = await metadata.response.json() as { head?: { sha?: string }; mergeable?: boolean | null; base?: { sha?: string } };
    if (!pr.head?.sha || !/^[a-f0-9]{40,64}$/i.test(pr.head.sha)) throw new Error('Head unavailable');
    const runs = await githubInstallationFetch(repo, `/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`, options, { priority: 'background' });
    if (!runs.response.ok || runs.scope !== metadata.scope) throw new Error('Checks unavailable');
    const body = await runs.response.json() as { check_runs?: Array<{ name?: string; started_at?: string | null; completed_at?: string | null }> };
    if (!Array.isArray(body.check_runs)) throw new Error('Checks unavailable');
    return NextResponse.json({ headSha: pr.head.sha, mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null,
      conflictingFiles: pr.mergeable === false ? await conflictingFiles(repo, pr.base?.sha, pr.head.sha) : null,
      timings: body.check_runs.filter(check => typeof check.name === 'string').map(check => {
        const start = Date.parse(check.started_at ?? '');
        const end = check.completed_at ? Date.parse(check.completed_at) : Date.now();
        return { name: check.name, durationMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null };
      }) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Pull request checks could not be read. Retry.' }, { status: 502 });
  }
}

/** Inspect exact mirrored commits without changing refs, index or the object store. */
async function conflictingFiles(repo: string, base: string | undefined, head: string): Promise<string[] | null> {
  if (!base || !/^[a-f0-9]{40,64}$/i.test(base)) return null;
  const local = (await listRepos()).find(entry => normalizeRepoSlug(entry.remoteUrl)?.toLowerCase() === repo.toLowerCase());
  if (!local?.localPath) return null;
  let scratch: string | undefined;
  try {
    const options = { cwd: local.localPath, encoding: 'utf-8' as const, timeout: 8_000, maxBuffer: 1024 * 1024, windowsHide: true };
    const { stdout: objects } = await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], options);
    scratch = await mkdtemp(join(tmpdir(), 'o8-pr-conflicts-'));
    const env = { ...process.env, GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects.trim() };
    let output: string;
    try {
      const result = await execFileAsync('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', base, head], { ...options, env });
      output = result.stdout;
    } catch (error) {
      const result = error as { code?: number; stdout?: string };
      if (result.code !== 1 || typeof result.stdout !== 'string') return null;
      output = result.stdout;
    }
    const [tree, ...paths] = output.split('\0');
    if (!/^[a-f0-9]{40,64}$/i.test(tree)) return null;
    return [...new Set(paths.filter(Boolean))];
  } catch { return null; }
  finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
}
