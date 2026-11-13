import { readJsonObject } from '@/lib/panel/read-json-object';
import { NextResponse } from 'next/server';
import { addLabelsToGitHubIssue, commentOnGitHubIssue, resolveRepoSlug } from '@/lib/github-broker';

/**
 * POST /api/panel/assign-issue
 * Body: { issue: number, agent: string }
 *
 * Assigns a GitHub issue to an agent by adding a comment and label.
 * Future: will actually spawn an agent session to work on the issue.
 */

export async function POST(request: Request) {
  try {
    const body = await readJsonObject<{ issue: number; agent: string; repo?: string }>(request);
    if (!body) {
      return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 });
    }
    const { issue, agent, repo } = body;

    if (!issue || !agent) {
      return NextResponse.json({ error: 'Missing issue or agent' }, { status: 400 });
    }

    const repoSlug = await resolveRepoSlug(repo ?? null, '');
    if (!repoSlug) {
      return NextResponse.json({ error: 'Missing or invalid repo' }, { status: 400 });
    }

    // Add a comment noting the assignment
    const comment = `🤖 Assigned to **${agent}** via o8 timeline drill-down.`;
    try {
      await commentOnGitHubIssue(repoSlug, issue, comment);
    } catch { /* comment failed, continue anyway */ }

    // Add label
    try {
      await addLabelsToGitHubIssue(repoSlug, issue, [`agent:${String(agent).toLowerCase()}`]);
    } catch { /* label may not exist, that's ok */ }

    return NextResponse.json({
      ok: true,
      issue,
      agent,
      message: `Issue #${issue} assigned to ${agent}`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
