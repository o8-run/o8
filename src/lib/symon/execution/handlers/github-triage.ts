import { scope, repos, type Repo } from './scope';
import { pages, slug } from './github';
import { observed, age, login } from './github-data';
import { bounded } from './process';
import { str, trim, type Args, type Json } from './transport';
export async function triage(args: Args, signal: AbortSignal): Promise<Json> {
  const hours = args.since_hours ?? 24;
  if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > 720) throw new Error('gh_triage since_hours must be an integer from 1 to 720');
  const sinceTime = Date.now() - hours * 3600000, since = new Date(sinceTime).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const scoped = Boolean(trim(args, 'repo') || trim(args, 'repoId') || trim(args, 'repoPath'));
  const paths: Repo[] = scoped ? [(await scope(args, signal, true))!] : await repos(signal);
  if (!paths.length) throw new Error('No tracked repositories are available for GitHub triage');
  const seen = new Set<string>(), groups: { repo: string; counts: Json; items: Json[] }[] = [];
  let skippedRepoCount = 0, sourceTruncated = false, contentTruncated = false;
  const field = (value: string, cap: number) => { const [text, cut] = bounded(value, cap); contentTruncated ||= cut; return text; };
  for (const repo of paths) {
    try {
      const remote = await slug(repo.path, signal);
      if (seen.has(remote)) continue;
      seen.add(remote);
      const [issues, cut1] = await pages(repo.path, `repos/${remote}/issues?state=all&since=${since}`, signal);
      const [comments, cut2] = await pages(repo.path, `repos/${remote}/issues/comments?since=${since}`, signal);
      const [reviews, cut3] = await pages(repo.path, `repos/${remote}/pulls/comments?since=${since}`, signal);
      sourceTruncated ||= cut1 || cut2 || cut3;
      const titles = new Map(issues.filter(i => typeof i.number === 'number' && i.number >= 0).map(i => [i.number, { title: field(str(i, 'title'), 300), pr: Object.hasOwn(i, 'pull_request') }]));
      const items: Json[] = []; let newIssues = 0, newPrs = 0, newComments = 0;
      for (const [kind, entries] of [['item', issues], ['comment', comments], ['review_comment', reviews]] as const) {
        for (const entry of entries) {
          if (!(Date.parse(str(entry, 'created_at')) >= sinceTime)) continue;
          const number = kind === 'item' ? entry.number ?? 0 : Number(str(entry, kind === 'review_comment' ? 'pull_request_url' : 'issue_url').split('/').pop()) || 0;
          const title = titles.get(number), pr = kind === 'item' ? Object.hasOwn(entry, 'pull_request') : title?.pr ?? str(entry, 'html_url').includes('/pull/');
          const value: Json = { kind: kind === 'item' ? pr ? 'pr' : 'issue' : kind === 'review_comment' ? kind : pr ? 'pr_comment' : 'issue_comment', number, title: kind === 'item' ? field(str(entry, 'title'), 300) : title?.title ?? '', author: field(login(entry), 100), createdAt: str(entry, 'created_at'), age: age(str(entry, 'created_at')), url: field(str(entry, 'html_url'), 500) };
          if (kind === 'item') { if (pr) newPrs++; else newIssues++; }
          else { newComments++; const [body, bodyTruncated] = bounded(str(entry, 'body'), 800); Object.assign(value, { body, bodyTruncated }); contentTruncated ||= bodyTruncated; }
          items.push(value);
        }
      }
      items.sort((a, b) => str(b, 'createdAt').localeCompare(str(a, 'createdAt')));
      groups.push({ repo: remote, counts: { newIssues, newPrs, newComments, total: items.length }, items });
    } catch (error) { signal.throwIfAborted(); if (scoped) throw error; skippedRepoCount++; }
  }
  if (!groups.length) throw new Error('None of the tracked repositories resolved to an accessible GitHub remote');
  groups.sort((a, b) => str(b.items[0] ?? {}, 'createdAt').localeCompare(str(a.items[0] ?? {}, 'createdAt')));
  const all = groups.flatMap(g => g.items.map(item => ({ repo: g.repo, item }))).sort((a, b) => str(b.item, 'createdAt').localeCompare(str(a.item, 'createdAt'))), selected = all.slice(0, 30);
  const counts = { newIssues: 0, newPrs: 0, newComments: 0, total: all.length, sourceCountTruncated: sourceTruncated };
  for (const g of groups) { counts.newIssues += Number(g.counts.newIssues); counts.newPrs += Number(g.counts.newPrs); counts.newComments += Number(g.counts.newComments); }
  return observed('github_rest_api_via_gh_cli', { mechanism: 'gh api REST issue and comment endpoints with exact since timestamps', sinceHours: hours, since, counts, itemsReturned: selected.length, groups: groups.map(g => { const items = selected.filter(i => i.repo === g.repo).map(i => i.item); return { repo: g.repo, counts: g.counts, itemsReturned: items.length, items }; }), skippedRepoCount }, sourceTruncated || contentTruncated || all.length > 30);
}
