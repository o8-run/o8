import { THINKING_EFFORTS } from '@/lib/orchestrator/thinking-effort';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';

/** Discovery and launch share one runtime/effort contract. */
export const CORTEX_WORKER_TOOLS = [
  {
    name: 'cortex_shared_team_status',
    description: 'Inspect this orchestrator chat’s Shared team: checkout, members, dirty and committed paths, outside-scope edits, and an exact review ID with HEAD, paths and fingerprints. Read the diff before committing or explicitly reconciling independent edits. Status alone does not approve changes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cortex_finish_shared_team',
    description: 'After all Shared workers settle, review and commit their combined scoped changes, run verification, then archive the team receipt and release checkout ownership. Refuses live workers, uncommitted team edits, and unreconciled independent changes. Preserves all source and reviewed independent edits.',
    inputSchema: {
      type: 'object',
      properties: {
        reviewSummary: { type: 'string', description: 'Concise summary of the combined diff and review findings.' },
        verification: { type: 'string', description: 'Commands and outcomes used to verify the combined result.' },
      },
      required: ['reviewSummary', 'verification'],
    },
  },
  {
    name: 'cortex_reconcile_shared_team',
    description: 'Explicitly acknowledge independently reviewed checkout changes before Finish. First inspect team status and review the actual diff. Submit its exact review ID, HEAD and every review path. Preserves original baseline, receipts and all source. Refuses active or unknown workers, stale review, incomplete acknowledgement and uncommitted worker edits. Does not release ownership or grant control over other agents.',
    inputSchema: {
      type: 'object',
      properties: {
        reviewId: { type: 'string', description: 'Exact review.id from cortex_shared_team_status after inspecting the current diff.' },
        reviewedHead: { type: 'string', description: 'Exact review.head from the same status.' },
        acknowledgedPaths: { type: 'array', items: { type: 'string' }, description: 'Every exact review.paths entry, including pre-existing edits, without omissions.' },
        reviewSummary: { type: 'string', description: 'What independent changes were reviewed and why preserving them is appropriate.' },
      },
      required: ['reviewId', 'reviewedHead', 'acknowledgedPaths', 'reviewSummary'],
    },
  },
  {
    name: 'cortex_correct_workers',
    description: 'Deliver an operator correction to exact owned workers of this conversation. First read eligible targets and run IDs by omitting targets. Then choose send (idle worker), pause-and-send (interrupt then resume the same worker), or stop (no resume). Set holdMerges only for an explicit no-merge instruction; it persists a binding session restriction before delivery. Delivered means runtime acceptance, not model acknowledgement. Unknown delivery must be inspected, never blindly repeated. Does not change runtime, model, permissions or workspace.',
    inputSchema: { type: 'object', properties: {
      targets: { type: 'array', maxItems: 8, items: { type: 'object', properties: { surfaceId: { type: 'string' }, runId: { type: 'string' } }, required: ['surfaceId', 'runId'], additionalProperties: false } },
      message: { type: 'string', maxLength: 2000 },
      mode: { type: 'string', enum: ['send', 'pause-and-send', 'stop'] },
      holdMerges: { type: 'boolean', description: 'Add an explicit no-merge restriction. False never removes an existing restriction.' },
      idempotencyKey: { type: 'string', description: 'Stable identity for this correction. Reuse only to inspect the identical request after an uncertain response.' },
    } },
  },
  {
    name: 'cortex_wait_workers',
    description: 'Read recorded workers belonging to this conversation and workspace. First call returns a snapshot and opaque cursor; pass afterCursor to wait for a relevant recorded change, for at most 30 seconds. Use surface IDs from launch or fleet relatedWorkers. Includes exact run/outcome and result-delivery receipts; absent evidence stays unknown. Observation never adopts control of a session.',
    inputSchema: {
      type: 'object',
      properties: {
        surfaceIds: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' }, description: 'One to eight exact recorded worker surface IDs belonging to this parent.' },
        afterCursor: { type: 'string', description: 'Opaque cursor from the previous response for the same workers. Omit for an immediate snapshot.' },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 30000, description: 'Bounded wait; defaults to 10000 ms. Zero reads immediately.' },
      },
      required: ['surfaceIds'],
    },
  },
  {
    name: 'cortex_worker_catalog',
    description: 'Read the configured worker pool and readiness. Pass a runtime to discover its model ids, supported effort and configured carrier. Use before choosing a worker for each task. Does not start a provider turn or change Settings. Unavailable choices must not be silently replaced.',
    inputSchema: { type: 'object', properties: { runtime: { type: 'string', enum: listDispatchableRuntimes(), description: 'Optional eligible runtime to inspect its model catalog.' } } },
  },
  {
    name: 'cortex_launch_agent',
    description:
      'Launch a worker session for a new task. To start an existing prepared mission, call the operator dispatch_mission tool with its missionId; do not launch a worker to dispatch it. Isolated workers use governed packets; Shared workers share this chat’s checkout and appear beside the orchestrator. ' +
      'Choose runtime/model per task from cortex_worker_catalog, honoring explicit choices in the conversation. Omitted choices use saved defaults; unavailable pins are refused. Returns the selected routing receipt ' +
      'plus a surfaceId you can use with cortex_steer_agent and cortex_read_transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task for the agent to complete. Be specific and actionable.' },
        repoPath: { type: 'string', description: 'Absolute repo path. Defaults to the current repo.' },
        taskName: { type: 'string', description: 'Short task name shown in the UI.' },
        isolate: { type: 'boolean', description: 'Legacy isolation flag. False is accepted only with checkoutMode: "shared" from an o8 orchestrator chat.' },
        checkoutMode: { type: 'string', enum: ['isolated', 'shared'], description: 'Use shared only when the operator selected Shared mode. Workers then edit the orchestrator checkout together; the orchestrator owns the final review and commit.' },
        assignedPaths: { type: 'array', items: { type: 'string' }, description: 'Required in Shared mode: exact non-overlapping relative files or directories this worker owns.' },
        runtime: {
          type: 'string',
          enum: listDispatchableRuntimes(),
          description: 'Optional worker runtime id; omit it to use the operator\'s saved dispatch default. '
            + '"pi-builtin" is the built-in Pi worker that ships with o8. "pi" is the operator\'s own Pi CLI and runs only when it is installed.',
        },
        instanceId: { type: 'string', minLength: 1, description: 'Saved provider instance id. Pins its configuration; unknown or disabled instances are refused.' },
        model: { type: 'string', description: 'Exact model id from cortex_worker_catalog. A supplied pin is never silently replaced.' },
        requestedEffort: { type: 'string', enum: THINKING_EFFORTS, description: 'Optional task effort. Use a tier listed for this runtime/model. Unsupported or coerced tiers are refused.' },
        thinkingEffort: { type: 'string', enum: THINKING_EFFORTS, description: 'Alias for requestedEffort; when both are present they must match.' },
        workerIntent: { type: 'string', enum: ['light_worker', 'heavy_worker', 'reviewer', 'diagnostic', 'orchestrator'], description: 'Optional routing intent.' },
        reviewPullRequest: { type: 'integer', minimum: 1, description: 'PR number in this repository for an isolated read-only review. Requires readOnly: true. The host fetches and pins its exact head before launch; the worker can run checks without fetching or switching branches.' },
        readOnly: {
          type: 'boolean',
          description: 'Set true for inspect, investigate, verify, or report tasks that must not change files. A clean zero-diff exit then completes as evidence.',
        },
      },
      required: ['prompt'],
    },
  },
];
