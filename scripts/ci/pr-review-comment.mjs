import { setTimeout } from 'node:timers/promises';

async function writeSummary(core, body) {
  try {
    await core.summary.addRaw(body).write();
  } catch (error) {
    core.warning(`Could not write the PR review report to the job summary: ${error?.message ?? error}`);
  }
}

export async function postPrReviewComment({ github, context, core, body }) {
  const isFork = context.payload.pull_request.head.repo.full_name !==
    `${context.repo.owner}/${context.repo.repo}`;

  if (isFork) {
    await writeSummary(core, body);
    core.info('Fork pull request detected; wrote the report to the job summary.');
    return;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // Re-read on retry: GitHub may have created the comment before its
      // response failed, so another create could duplicate the report.
      const marker = '## 🔍 PR Review Bot';
      const existing = await github.paginate(github.rest.issues.listComments, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.issue.number,
        per_page: 100,
      });
      const mine = existing.find((c) =>
        c.user && c.user.type === 'Bot' && typeof c.body === 'string' && c.body.startsWith(marker));
      if (mine) {
        await github.rest.issues.updateComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          comment_id: mine.id,
          body,
        });
      } else {
        await github.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: context.issue.number,
          body,
        });
      }
      return;
    } catch (error) {
      const status = error?.status;
      const transient = status == null || status === 0 || (status >= 500 && status < 600);
      if (attempt === 0 && transient) {
        await setTimeout(1000);
        continue;
      }
      core.warning(`Could not post the PR review comment: ${error?.message ?? error}`);
      await writeSummary(core, body);
      return;
    }
  }
}
