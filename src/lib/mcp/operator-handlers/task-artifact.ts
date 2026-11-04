//! Interactive task artifacts (#1699) — lets an orchestrator hand the operator
//! a small purpose-built form inside the thread whose structured edits return
//! to this exact session. Thin wrapper over the gated /api/task-artifacts
//! routes; the server owns identity, liveness, bounds, and receipts.

import { apiFetch, errorText, jsonResult, requiredString, textResult, type McpTool, type McpToolResult } from './shared';

export const TASK_ARTIFACT_TOOLS: McpTool[] = [
  {
    name: 'o8_task_artifact',
    description:
      'Attach an interactive task artifact to the current orchestrator thread or a packet, or read one back. '
      + 'verb=create: { title, html, actions, threadId+repoPath | packetId, headPolicy? }. The html renders in an opaque sandbox with no network, '
      + 'no o8 access, and exactly one capability: window.o8.submit(action, payload) / window.o8.onCollect(fn) returns a payload matching a declared action schema '
      + 'to the session that created the artifact. actions: [{ name, label?, schema: { fields: { <name>: { type: string|number|integer|boolean, required?, enum?, maxLength?, min?, max? } }, rows?: { fields, maxRows? } } }]. '
      + 'The operator edits the artifact and presses Send; the exact validated payload arrives as the next message on this thread (or as a steer on the packet) with a receipt id. '
      + 'A mission card replaces html and actions with card: { kind: approve|choose, body?, actions?: [{ id, label, style?: primary|danger|default, confirm?: "hold" }], entityIds?: ["packet:<id>", "approval:<id>"], expiresAt? }. '
      + 'An approve card defaults to a held Approve and a Deny; a choose card lists 2-8 options. The operator decides once inline; the decision arrives as a card.decision JSON block naming the action and entity ids. Treat it as context and re-check those entities before acting. '
      + 'verb=status: { artifactId } returns writability, last receipt, and accepted count. verb=receipts: { artifactId } lists every submission.',
    inputSchema: {
      type: 'object',
      properties: {
        verb: { type: 'string', description: 'create | status | receipts' },
        artifactId: { type: 'string', description: 'For status/receipts: the artifact id (tart-…).' },
        title: { type: 'string', description: 'For create: short title shown on the card (max 120 chars).' },
        html: { type: 'string', description: 'For create: the artifact document body. Inline styles/scripts only; no external resources load. Omit for a card.' },
        card: { type: 'object', description: 'For create: a native mission card instead of html and actions.' },
        actions: {
          type: 'array',
          description: 'For create: declared actions with payload schemas. The first is the card\'s Send action.',
          items: { type: 'object' },
        },
        threadId: { type: 'string', description: 'For create: the orchestrator thread (thoughts-…) to attach to. Pair with repoPath.' },
        repoPath: { type: 'string', description: 'For create with threadId: the repository the thread belongs to.' },
        packetId: { type: 'string', description: 'For create: attach to a dispatched packet instead of a thread.' },
        headPolicy: { type: 'string', description: 'For create: pinned (default, read-only once HEAD moves) or any.' },
      },
      required: ['verb'],
    },
  },
];

interface CreateResult { ok?: boolean; result?: { artifact?: Record<string, unknown> }; error?: { code?: string; message?: string } }

export async function handleTaskArtifact(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const verb = requiredString(args, 'verb');
    if (verb === 'create') {
      const title = requiredString(args, 'title');
      const card = args.card && typeof args.card === 'object' ? args.card : null;
      const html = card ? '' : requiredString(args, 'html');
      if (!card && (!Array.isArray(args.actions) || args.actions.length === 0)) {
        return textResult('o8_task_artifact create: actions must be a non-empty array of { name, schema }.', true);
      }
      const body: Record<string, unknown> = card ? { title, card } : { title, html, actions: args.actions };
      for (const key of ['threadId', 'repoPath', 'packetId', 'headPolicy'] as const) {
        if (typeof args[key] === 'string' && args[key]) body[key] = args[key];
      }
      if (!body.packetId && !(body.threadId && body.repoPath)) {
        return textResult('o8_task_artifact create: provide packetId, or threadId together with repoPath.', true);
      }
      const result = (await apiFetch('/api/task-artifacts', { method: 'POST', body: JSON.stringify(body) })) as CreateResult;
      if (!result?.ok || !result.result?.artifact) {
        return textResult(`o8_task_artifact create failed: ${result?.error?.message ?? 'the server did not accept the artifact'}`, true);
      }
      const artifact = result.result.artifact;
      return jsonResult({
        ok: true,
        artifactId: artifact.id,
        target: artifact.target,
        originHead: artifact.originHead,
        actions: artifact.actions,
        note: 'The operator sees the artifact in the thread now. Its submission arrives as your next message with a receipt id; do not poll for it.',
      });
    }
    const artifactId = requiredString(args, 'artifactId');
    if (verb === 'status') {
      const result = (await apiFetch(`/api/task-artifacts/${encodeURIComponent(artifactId)}`)) as { ok?: boolean; result?: Record<string, unknown>; error?: { message?: string } };
      if (!result?.ok || !result.result) return textResult(`o8_task_artifact status failed: ${result?.error?.message ?? 'not found'}`, true);
      const { artifact, ...rest } = result.result as { artifact?: Record<string, unknown> } & Record<string, unknown>;
      const { html: _html, ...summary } = artifact ?? {};
      return jsonResult({ ok: true, artifact: summary, ...rest });
    }
    if (verb === 'receipts') {
      const result = (await apiFetch(`/api/task-artifacts/${encodeURIComponent(artifactId)}/actions`)) as { ok?: boolean; result?: Record<string, unknown>; error?: { message?: string } };
      if (!result?.ok || !result.result) return textResult(`o8_task_artifact receipts failed: ${result?.error?.message ?? 'not found'}`, true);
      return jsonResult({ ok: true, ...result.result });
    }
    return textResult(`o8_task_artifact: unknown verb "${verb}" (create | status | receipts).`, true);
  } catch (error) {
    return textResult(`o8_task_artifact failed: ${errorText(error)}`, true);
  }
}
