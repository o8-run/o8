# CLI and agent-documentation audit

Tracked by #4511. Base: `d73cca9a2d6ed88f4c6804f642265ce75833c57a`.
The baseline executable was built from this base. Every distinct command entry
in its root help was invoked with --help; these calls require no live server.
The table below records the returned exit code and the presence of literal
Required:, Defaults:, and Example: sections. Inline usage and hints can provide
some of this information without these labels. The ten repaired commands also
received a semantic review against their parsers; remaining commands need that review.

## Findings and changes

| Surface | Agent obstacle | Change |
| --- | --- | --- |
| Ten common operator commands | Command-level help returned only the group menu, hiding required flags and defaults. | Specific usage, required arguments, defaults, allowed values and one complete example. |
| Dispatch help | Launch waiting and attention watching have different timeout semantics. | Document that timeout/poll apply to --watch; its defaults are 2h and 5000ms. |
| Resource lease recipe | The reference advertised an unsupported TTL flag for the separate team lease store. | Use server resource leases for duration/FIFO behavior; state millisecond units and limits. |
| External-agent setup | Claimed unauthenticated localhost access and a stale fixed fallback port. | Require the operator bearer on loopback; use live connection discovery. |
| External-agent examples | Numeric issue examples contradicted schema; review omitted finding status; spec validation used a nonexistent CLI subcommand. | String issue references, complete review examples, and executable spec check syntax. |
| Merge authority | Review approval can unlock merge; old prose taught an unconditional merge loop. | Explain holds and require current authorization for approval/merge. |
| Root task dispatch summary | Described a single fixed runtime despite current runtime selection. | Describe selected-runtime routing. |

The ten command-help checks changed from 0/10 passing to 10/10 passing.
The external-documentation check also failed before the rewrite and passed after it.
Deterministic checks are reported separately from operator-task measurements.

## Evaluation-agent trial

The model-backed evaluator could not reach its model endpoint because outbound
policy returned HTTP 403 before the first operator call. Before first-try success:
**not measured (0/10 tasks attempted)**. After first-try success:
**not measured (0/10 tasks attempted)**.

The ten trial tasks are prepare a mission, dispatch it, inspect mission status,
preview a merge, steer a session, record an authorized review, acquire a lease,
inspect the lease, queue a task, and block a task. Provide only help and the agent
reference, use isolated fixture state, and count a corrected or rejected first
operation as a first-try failure. Record environmental failures separately.

## Documentation scope

Reviewed AGENTS.md, its matching task skills, AGENT_REFERENCE.md,
docs/agents/EXTERNAL_AGENTS.md, docs/internals/agent-instructions.md,
docs/operations/agent-setup.md, and docs/user/operator-mcp-bridge.md.
The canonical command recipes and external-agent quickstart were updated.
The baseline inventory retains unresolved help gaps outside the ten repaired commands.
Live native actions and destructive commands were not exercised.

## Baseline command inventory

| Command help | Exit | Required: section | Defaults: section | Example: section |
| --- | --- | --- | --- | --- |
| `o8 chat --help` | 0 | missing | missing | missing |
| `o8 version --help` | 0 | missing | missing | missing |
| `o8 doctor --help` | 0 | missing | missing | missing |
| `o8 status --help` | 0 | missing | missing | missing |
| `o8 conversation-prs --help` | 0 | missing | missing | missing |
| `o8 history --help` | 0 | missing | missing | missing |
| `o8 lead start --help` | 0 | missing | missing | missing |
| `o8 lead send --help` | 0 | missing | missing | missing |
| `o8 lead report --help` | 0 | missing | missing | missing |
| `o8 lead status --help` | 0 | missing | missing | missing |
| `o8 lead wait --help` | 0 | missing | missing | missing |
| `o8 lead stop --help` | 0 | missing | missing | missing |
| `o8 connect --help` | 0 | missing | missing | missing |
| `o8 disconnect --help` | 0 | missing | missing | missing |
| `o8 run --help` | 1 | missing | missing | missing |
| `o8 run stop --help` | 2 | missing | missing | missing |
| `o8 terminal list --help` | 0 | missing | missing | missing |
| `o8 terminal show --help` | 0 | missing | missing | missing |
| `o8 terminal observe --help` | 0 | missing | missing | missing |
| `o8 terminal control --help` | 0 | missing | missing | missing |
| `o8 terminal wait --help` | 0 | missing | missing | missing |
| `o8 terminal --help` | 0 | missing | missing | missing |
| `o8 machine add --help` | 0 | missing | missing | missing |
| `o8 machine --help` | 0 | missing | missing | missing |
| `o8 serve --help` | 0 | missing | missing | missing |
| `o8 serve status --help` | 0 | missing | missing | missing |
| `o8 serve stop --help` | 0 | missing | missing | missing |
| `o8 serve renew-token --help` | 0 | missing | missing | missing |
| `o8 serve restart --help` | 0 | missing | missing | missing |
| `o8 serve agent --help` | 0 | missing | missing | missing |
| `o8 ask --help` | 0 | missing | missing | missing |
| `o8 feature --help` | 0 | missing | missing | missing |
| `o8 ground --help` | 0 | missing | missing | missing |
| `o8 boot --help` | 0 | missing | missing | missing |
| `o8 contract --help` | 0 | missing | missing | missing |
| `o8 sprint --help` | 0 | missing | missing | missing |
| `o8 verify --help` | 0 | missing | missing | missing |
| `o8 truth --help` | 0 | missing | missing | missing |
| `o8 harness verify --help` | 0 | missing | missing | missing |
| `o8 harness --help` | 0 | missing | missing | missing |
| `o8 capabilities --help` | 0 | missing | missing | missing |
| `o8 evaluate-diff --help` | 0 | missing | missing | missing |
| `o8 ci --help` | 0 | missing | missing | missing |
| `o8 app restart --help` | 0 | missing | missing | missing |
| `o8 update check --help` | 0 | missing | missing | missing |
| `o8 update apply --help` | 0 | missing | missing | missing |
| `o8 browser open --help` | 0 | missing | missing | missing |
| `o8 browser read --help` | 0 | missing | missing | missing |
| `o8 browser click --help` | 0 | missing | missing | missing |
| `o8 browser type --help` | 0 | missing | missing | missing |
| `o8 browser wait --help` | 0 | missing | missing | missing |
| `o8 browser close --help` | 0 | missing | missing | missing |
| `o8 broadcast --help` | 0 | missing | missing | missing |
| `o8 msg --help` | 0 | missing | missing | missing |
| `o8 presence --help` | 0 | missing | missing | missing |
| `o8 brain sources --help` | 0 | missing | missing | missing |
| `o8 cortex observe --help` | 0 | missing | missing | missing |
| `o8 lane touches --help` | 0 | missing | missing | missing |
| `o8 artifact create --help` | 0 | missing | missing | missing |
| `o8 artifact --help` | 0 | missing | missing | missing |
| `o8 lease acquire --help` | 0 | missing | missing | missing |
| `o8 lease release --help` | 0 | missing | missing | missing |
| `o8 lease status --help` | 0 | missing | missing | missing |
| `o8 lease list --help` | 0 | missing | missing | missing |
| `o8 worker spawn --help` | 0 | missing | missing | missing |
| `o8 worker login --help` | 0 | missing | missing | missing |
| `o8 mission create --help` | 0 | missing | missing | missing |
| `o8 mission dispatch --help` | 0 | missing | missing | missing |
| `o8 mission status --help` | 0 | missing | missing | missing |
| `o8 mission stop --help` | 0 | missing | missing | missing |
| `o8 mission wait --help` | 0 | missing | missing | missing |
| `o8 mission tail --help` | 0 | missing | missing | missing |
| `o8 mcp install --help` | 0 | missing | missing | missing |
| `o8 setup status --help` | 0 | missing | missing | missing |
| `o8 setup configure --help` | 0 | missing | missing | missing |
| `o8 setup open --help` | 0 | missing | missing | missing |
| `o8 setup cancel --help` | 0 | missing | missing | missing |
| `o8 repo list --help` | 0 | missing | missing | missing |
| `o8 repo add --help` | 0 | missing | missing | missing |
| `o8 repo remove --help` | 0 | missing | missing | missing |
| `o8 project list --help` | 0 | missing | missing | missing |
| `o8 project create --help` | 0 | missing | missing | missing |
| `o8 project use --help` | 0 | missing | missing | missing |
| `o8 project add-repo --help` | 0 | missing | missing | missing |
| `o8 project remove-repo --help` | 0 | missing | missing | missing |
| `o8 project delete --help` | 0 | missing | missing | missing |
| `o8 pr-stack --help` | 0 | missing | missing | missing |
| `o8 threads list --help` | 0 | missing | missing | missing |
| `o8 threads show --help` | 0 | missing | missing | missing |
| `o8 problem list --help` | 0 | missing | missing | missing |
| `o8 problem show --help` | 0 | missing | missing | missing |
| `o8 plugin list --help` | 0 | missing | missing | missing |
| `o8 plugin source --help` | 0 | missing | missing | missing |
| `o8 plugin state --help` | 0 | missing | missing | missing |
| `o8 plugin action --help` | 0 | missing | missing | missing |
| `o8 plugin log --help` | 0 | missing | missing | missing |
| `o8 plugin terminal --help` | 0 | missing | missing | missing |
| `o8 inbox list --help` | 0 | missing | missing | missing |
| `o8 inbox approve --help` | 0 | missing | missing | missing |
| `o8 inbox reject --help` | 0 | missing | missing | missing |
| `o8 packet retain --help` | 0 | missing | missing | missing |
| `o8 packet release-retention --help` | 0 | missing | missing | missing |
| `o8 packet restore-artifacts --help` | 0 | missing | missing | missing |
| `o8 packet receipt --help` | 0 | missing | missing | missing |
| `o8 packet receipts --help` | 0 | missing | missing | missing |
| `o8 next --help` | 0 | missing | missing | missing |
| `o8 session show --help` | 0 | missing | missing | missing |
| `o8 session import --help` | 0 | missing | missing | missing |
| `o8 session checkpoint --help` | 0 | missing | missing | missing |
| `o8 session fork --help` | 0 | missing | missing | missing |
| `o8 session rewind --help` | 0 | missing | missing | missing |
| `o8 session resume --help` | 0 | missing | missing | missing |
| `o8 session dismiss-pending --help` | 0 | missing | missing | missing |
| `o8 task list --help` | 0 | missing | missing | missing |
| `o8 task create --help` | 0 | missing | missing | missing |
| `o8 task brief --help` | 0 | missing | missing | missing |
| `o8 task claim --help` | 0 | missing | missing | missing |
| `o8 task dispatch --help` | 0 | missing | missing | missing |
| `o8 task block --help` | 0 | missing | missing | missing |
| `o8 task report --help` | 0 | missing | missing | missing |
| `o8 task archive --help` | 0 | missing | missing | missing |
| `o8 task prune --help` | 0 | missing | missing | missing |
| `o8 packet info --help` | 0 | missing | missing | missing |
| `o8 packet scope --help` | 0 | missing | missing | missing |
| `o8 packet expand-scope --help` | 0 | missing | missing | missing |
| `o8 packet diff --help` | 0 | missing | missing | missing |
| `o8 packet commit --help` | 0 | missing | missing | missing |
| `o8 packet heartbeat --help` | 0 | missing | missing | missing |
| `o8 packet review --help` | 0 | missing | missing | missing |
| `o8 packet park --help` | 0 | missing | missing | missing |
| `o8 packet restore --help` | 0 | missing | missing | missing |
| `o8 packet close --help` | 0 | missing | missing | missing |
| `o8 packet discard --help` | 0 | missing | missing | missing |
| `o8 packet reset --help` | 0 | missing | missing | missing |
| `o8 packet stop --help` | 0 | missing | missing | missing |
| `o8 packet cancel --help` | 0 | missing | missing | missing |
| `o8 packet retry --help` | 0 | missing | missing | missing |
| `o8 packet rerun --help` | 0 | missing | missing | missing |
| `o8 packet steer --help` | 0 | missing | missing | missing |
| `o8 packet approve-merge --help` | 0 | missing | missing | missing |
| `o8 packet merge-preview --help` | 0 | missing | missing | missing |
| `o8 packet report --help` | 0 | missing | missing | missing |
| `o8 packet capture --help` | 0 | missing | missing | missing |
| `o8 packet mirror-proof --help` | 0 | missing | missing | missing |
| `o8 packet log --help` | 0 | missing | missing | missing |
| `o8 packet runtime-drift --help` | 0 | missing | missing | missing |
