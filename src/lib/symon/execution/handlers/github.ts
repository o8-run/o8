import { gitRepo, gitRead, repoLabel } from './git';
import { run, bounded } from './process';
import { trim, type Args, type Json } from './transport';
import { observed, viewData } from './github-data';
import { triage } from './github-triage';
export const numberArg = (args: Args, tool: string): number => {
  if (typeof args.number !== 'number' || !Number.isSafeInteger(args.number) || args.number <= 0) throw new Error(`${tool} needs a positive issue or PR 'number'`);
  return args.number;
};
export function writeArgs(tool: string, args: Args) {
  if (tool === 'gh_issue_create') {
    const title = trim(args, 'title'); if (!title) throw new Error("gh_issue_create needs a 'title'");
    return { title, body: trim(args, 'body') || 'Filed by voice via Symon.' };
  }
  const kind = trim(args, 'kind'); if (!['issue', 'pr'].includes(kind)) throw new Error("gh_comment kind must be 'issue' or 'pr'");
  const number = numberArg(args, tool), body = trim(args, 'body');
  if (!body) throw new Error("gh_comment needs a non-empty 'body'");
  if (Buffer.byteLength(body) > 65536) throw new Error('gh_comment body is too long');
  return { kind, number, body };
}
export async function githubReview(tool: string, args: Args, signal: AbortSignal) {
  const repo = await gitRepo(args, signal), values = writeArgs(tool, args);
  return { summary: tool === 'gh_issue_create' ? `Create an issue in ${repoLabel(repo)} titled “${values.title}”.` : `Comment on ${values.kind === 'pr' ? 'pull request' : 'issue'} #${values.number} in ${repoLabel(repo)} with opening text “${bounded(values.body, 160)[0]}”.`, target: {} };
}
export async function slug(path: string, signal: AbortSignal): Promise<string> {
  const value = await run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], path, signal);
  if (!/^[a-zA-Z0-9._-]{1,100}\/[a-zA-Z0-9._-]{1,100}$/.test(value)) throw new Error("The tracked repo's GitHub remote did not resolve to owner/name");
  return value;
}
export async function pages(path: string, endpoint: string, signal: AbortSignal): Promise<[Json[], boolean]> {
  const values: Json[] = [];
  for (let page = 1; page <= 3; page++) {
    const text = await run('gh', ['api', '--method', 'GET', '--', `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`], path, signal);
    let out: unknown;
    try { out = JSON.parse(text); } catch { throw new Error('GitHub returned an invalid JSON response'); }
    if (!Array.isArray(out)) throw new Error('GitHub returned an invalid JSON response');
    values.push(...out); if (out.length < 100) return [values, false];
  }
  return [values, true];
}
export async function github(tool: string, args: Args, signal: AbortSignal): Promise<Json> {
  if (tool.startsWith('git_') || tool === 'repo_commit_diff') return gitRead(tool, args, signal);
  if (tool === 'gh_triage') return triage(args, signal);
  const repo = await gitRepo(args, signal), gh = (a: string[]) => run('gh', a, repo.path, signal);
  if (tool === 'gh_issue_create' || tool === 'gh_comment') {
    const v = writeArgs(tool, args);
    const out = await gh(tool === 'gh_issue_create' ? ['issue', 'create', '--title', v.title!, '--body', v.body] : [v.kind!, 'comment', String(v.number), '--body', v.body]);
    const url = out.split('\n').reverse().find(l => l.includes('github.com'))?.trim() ?? '';
    return tool === 'gh_issue_create' ? { created: true, title: v.title, url } : { commented: true, kind: v.kind, number: v.number, url: bounded(url, 500)[0] };
  }
  const kind = tool.startsWith('gh_pr') ? 'pr' : 'issue';
  if (tool.endsWith('_list')) {
    const out = await gh([kind, 'list', '--limit', '15', '--json', kind === 'pr' ? 'number,title,state,author' : 'number,title,state']);
    let values: unknown; try { values = JSON.parse(out); } catch { values = []; }
    const count = Array.isArray(values) ? values.length : 0;
    return observed('github_cli', { count, [kind === 'pr' ? 'prs' : 'issues']: values }, count === 15);
  }
  const number = numberArg(args, tool);
  const out = await gh([kind, 'view', String(number), '--json', kind === 'pr' ? 'title,state,author,baseRefName,headRefName,body,changedFiles,additions,deletions,reviews,comments,statusCheckRollup' : 'title,state,author,labels,body,comments']);
  let raw: Json; try { const parsed: unknown = JSON.parse(out); raw = parsed && typeof parsed === 'object' ? parsed as Json : {}; } catch { throw new Error(`GitHub returned an invalid ${kind === 'pr' ? 'pull request' : 'issue'} response`); }
  if (kind === 'issue') return viewData(raw, number);
  const remote = await slug(repo.path, signal), [inline, truncated] = await pages(repo.path, `repos/${remote}/pulls/${number}/comments`, signal);
  return viewData(raw, number, inline, truncated);
}
