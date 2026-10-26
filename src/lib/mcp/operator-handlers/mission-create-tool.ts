import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import type { McpTool } from './shared';
import { MISSION_CONTRACT_INPUT_PROPERTIES, SEALED_TASK_CONTRACT_GUIDANCE } from './quality-search-input';
import { MISSION_WORKER_PIN_PROPERTIES, WORKER_PROVIDER_OPTIONS } from './mission-worker-input';

export const CREATE_MISSION_TOOL: McpTool = {
  name: 'create_mission',
  description:
    'Prepare or dispatch coding tasks. Required: repoPath and at least one non-empty issues or issues_inline list. Issue references in issues are strings; each inline task needs title, with optional body. dispatch defaults to true and starts workers immediately; set dispatch:false to prepare, then pass the returned missionId to dispatch_mission. Packets run in parallel unless sequential:true. Example: create_mission({repoPath: "/path/to/repo", issues: ["495", "496"], dispatch:false}). Example: create_mission({repoPath: "/path/to/repo", issues_inline: [{title: "Check empty input"}], dispatch:false}).' + SEALED_TASK_CONTRACT_GUIDANCE,
  inputSchema: {
    type: 'object',
    properties: {
      issues: {
        type: 'array',
        minItems: 1,
        items: { type: 'string' },
        description: 'Issue references as strings. Accepts any format: "495", "#495", or "https://github.com/org/repo/issues/495" (pass numbers as strings). Fetches the complete referenced issue.',
      },
      issues_inline: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Task summary / issue title.' },
            body: { type: 'string', description: 'Detailed description (optional).' },
          },
          required: ['title'],
        },
        description: 'Ad-hoc inline tasks; no remote issue required. Each becomes its own packet.',
      },
      idempotencyKey: { type: 'string', minLength: 1, description: 'Stable identity for one mission creation. Reuse the same key and arguments after an uncertain response; a replay returns the saved ids without starting dispatch again.' },
      repoPath: { type: 'string', description: 'Absolute local path to the repository.' },
      projectId: { type: 'string', description: 'Exact project identifier. Overrides the current project; omission captures the creation context once. Thread ids provide placement and rules, not project selection.' },
      origin: { type: 'string', enum: ['design-mode'], description: 'Set to design-mode when the mission comes from an element-edit payload so follow-up edits can reuse its warm packet lane.' },
      runtime: {
        type: 'string',
        enum: listDispatchableRuntimes(),
        description: 'Worker runtime for this mission. Omit to use the saved default worker; explicitly select another available dispatchable runtime for this task. Check current runtime availability before choosing.',
      },
      workerIntent: {
        type: 'string',
        enum: ['light_worker', 'heavy_worker', 'reviewer', 'diagnostic', 'orchestrator'],
        description: 'Desired worker role. Select its runtime independently with runtime.',
      },
      requestedProvider: {
        type: 'string',
        enum: WORKER_PROVIDER_OPTIONS,
        description: 'Provider hint recorded in routing metadata. Select the execution runtime explicitly with runtime.',
      },
      ...MISSION_WORKER_PIN_PROPERTIES,
      constraints: {
        type: 'string',
        description: 'Optional sprint-wide constraints that should be included in packet scope.',
      },
      sequential: {
        type: 'boolean',
        description: 'When true, packets run sequentially (P2 after P1, etc.). Default: false (all packets run in parallel).',
      },
      existingBranchPolicy: {
        type: 'string',
        enum: ['auto', 'reset', 'continue', 'error'],
        description: 'How to handle an existing issue/inline branch. Default auto resets stale or spec-changed attempts, and asks on ambiguous active attempts. Use reset to force fresh-from-main, continue to resume an active same-spec lane.',
      },
      dispatch: {
        type: 'boolean',
        default: true,
        description: 'When true (default), immediately dispatches all packets after creation. Set false to prepare without launching; then call dispatch_mission with the returned missionId when ready.',
      },
      useBrain: { type: 'boolean', description: 'Engineering Brain for the workers. true: every packet prompt teaches the worker `o8 ask` (instant cited repo answers — use for weaker models or knowledge-heavy tasks). false: suppress. Omit to inherit the operator "Workers use the Brain" setting (auto = on for non-frontier runtimes only).' },
      holdMerges: { type: 'boolean', description: 'Hold merges. When true, every packet stops at an approved review and waits for the operator: a merge from the reviewer or from you routes to an operator approval card instead of merging. Set it whenever the operator says not to merge, or wants to merge themselves. Omit (default off) to keep the usual merge after an approved review.' },
      huddle: {
        type: 'boolean',
        description: 'Huddle mode — a bidirectional alignment turn. When true, each worker reads the repo then posts its plan + any pushback (`o8 packet report --event huddle`) and STOPS before editing; you review it (the packet flips to awaiting_orchestrator) and steer it (steer_packet) to align before it implements. Arm it ONLY on packets worth aligning on first — ambiguous scope, risky/cross-cutting, or novel work. Omit (default off) for clear, well-specced packets so they don\'t pay the extra round-trip.',
      },
      ...MISSION_CONTRACT_INPUT_PROPERTIES,
      readOnly: { type: 'boolean', description: 'When true, the worker inspects and reports without editing. A clean zero-diff exit is recorded as a successful read-only completion.' },
      comparisonModels: {
        type: 'array',
        minItems: 1,
        items: { type: 'string' },
        description: 'Best-of-N — race the task across N candidates (one per model string), each in its own isolated worktree. The operator then compares the N diffs side-by-side and merges the winner through the review gate, archiving the losers. Same model repeated (["codex","codex","codex"]) runs N attempts of one runtime; mix runtimes (["codex","gemini"]) to compare them. Max 4. Omit for a single packet. Use when a task is worth a bake-off — risky, ambiguous, or when you want the best of several attempts.',
      },
      orchestratorThreadId: {
        type: 'string',
        description: 'Session-rule inheritance (#1329) — your active orchestrator thread id (e.g. "thoughts-…"). When set, every worker prompt carries the thread\'s active "Operator session rules (binding)" block and dispatch records a rules_applied lane event. Omit when dispatching outside a rule-bearing thread.',
      },
      orchestratorTurnId: {
        type: 'string',
        description: 'Exact assistant transcript message id for the current sent turn. Pass it with orchestratorThreadId so successful worker launches append to that turn receipt.',
      },
      parentWorkspaceId: { type: 'string', description: 'Optional durable workspace placement for the worker split.' },
      caller: { type: 'string', description: 'Optional short label for the outside agent or terminal that started this work. The o8 app shows it on the worker pane.' },
    },
    required: ['repoPath'],
  },
};
