# MCP agent experience audit

Tracked by #4511. Base: `d73cca9a2d6ed88f4c6804f642265ce75833c57a`.
Discovery was captured from a development server started from that base with a
disposable data profile and a separate loopback port, using `POST /api/mcp`
with `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`.
The full profile exposed 133 unique tool names. All top-level input schemas
are objects. Names are valid protocol identifiers; callers must use the exact discovered name.

## Findings and changes

| Task or seam | Before | Change |
| --- | --- | --- |
| Record review findings | The handler requires status or resolution, but the alternatives and severity aliases were not clearly named. | Name status-or-resolution requirements in discovery, list canonical severity values and legacy aliases, and give corrective severity errors. The schema retains the original accepted inputs. |
| Prepare a mission | A numeric issue example contradicted string-only item schemas; dispatch default was prose-only. | Use string references in examples, state the task-list requirement, and publish the dispatch default while allowing empty optional arrays. |
| Acquire a lease | No field descriptions, TTL default, or complete example; a string wait flag was silently treated as false. | Publish units and defaults; reject a non-boolean wait before acquiring a claim. |
| Repair a missing field | Errors only said the field was required. | Name the field and request a non-empty string. |
| Repair a wrong tool name | Profile rejection offered no next step. | Direct the caller to tools/list and an exact available name. |
| Repair malformed arguments | Arrays could reach handlers and trigger API reads. | Reject non-object arguments at dispatch with an example. |

The route-level regression set changed from 0/7 passing to 7/7 passing;
these are deterministic contract checks. They cover discovery and actual POST calls.
The focused lease and review-input checks also pass.

## Schema compatibility replay

A review of the first audit head found client-validation regressions introduced
by narrowing severity, requiring status despite the resolution alias, and adding
minimum lengths to optional mission arrays. These schema restrictions are removed;
the required-field guidance, allowed-value descriptions, defaults, examples, and
corrective errors remain.

The same 22 calls run against the production MCP POST entrypoint on main
`a12ba06ce453961a57472a81fa2bd52f8edffd70` and this branch. They create prepared
missions through the production service and submit authenticated rejected reviews
through the production review route, checking persisted state. Dispatch is disabled
and merges are held. Strict keyword/default schema checks compile the live
tools/list definitions with coercion, default injection, and property removal disabled.

Coverage includes all eleven severity spellings, mixed case and surrounding
whitespace, three resolution-only verdicts, status precedence, empty findings,
inline missions with omitted or empty issues, and an empty comparison list.

| Replay result | Calls |
| --- | ---: |
| Successful on main | 22/22 |
| Valid against first-head schemas | 5/22 |
| Valid against corrected schemas and successful at runtime | 22/22 |

Red tail, recorded before the correction:

```text
Test Files  1 failed (1)
     Tests  17 failed | 5 passed (22)
```

Green tail, including the existing guidance, lease, and review checks:

```text
Test Files  4 passed (4)
     Tests  36 passed (36)
```

## Evaluation-agent trial

The model-backed trial is blocked before its first operator call: outbound policy
refuses the evaluation agent's model endpoint with HTTP 403. The agent executable
and login were verified, and a disposable writable state directory was prepared.
First-try success before: **not measured (0/10 tasks attempted)**.
First-try success after: **not measured (0/10 tasks attempted)**.

A first-try success means the first action call uses the intended tool, valid
arguments, and completes the requested operation. Discovery reads are allowed;
argument corrections, unknown tools, rejected calls, and wrong operations count
as failures. Environmental failures must be recorded separately.

| Trial | Operator task | Intended surface | Current evidence |
| --- | --- | --- | --- |
| 1 | Prepare one inline task without launching | create_mission with dispatch:false | Pending model access |
| 2 | Dispatch a prepared fixture mission | dispatch_mission | Pending model access |
| 3 | Read exact mission status | get_mission_status | Pending model access |
| 4 | Read packet scope before editing | get_packet_scope | Pending model access |
| 5 | Preview a merge without approving | o8_merge_preview | Pending model access |
| 6 | Record a rejection with one finding | submit_review with approved:false | Pending model access |
| 7 | Steer an existing fixture session | steer_packet | Pending model access |
| 8 | Acquire a named resource for one minute | o8_lease_acquire | Pending model access |
| 9 | Inspect its holder and queue | o8_lease_status | Pending model access |
| 10 | Release the same resource | o8_lease_release | Pending model access |

## Complete discovery inventory

Each row checks the published name, required fields, enum-bearing fields,
documented defaults, field descriptions, and presence of a typical example.
105 descriptions lacked a recognizable example in the baseline.
An enum-bearing field has its allowed values in the schema. `none` does not
establish that the underlying handler accepts arbitrary strings. Defaults may
be inherited from operator settings; those require a live settings read.
Conditional requirements remain in handler validation so top-level schemas stay plain objects.

Error behavior was checked through the real entry point for the repaired cases.
Native-only actions, external model calls, and destructive operations were not
executed. Their live errors and task success remain unverified; this inventory
records discovery coverage, not a successful execution of every action.

| Tool | Required fields | Fields listing allowed values | Explicit defaults or default prose | Fields missing descriptions | Typical example |
| --- | --- | --- | --- | --- | --- |
| `o8_threads_list` | none declared | model, state | none explicit | model, repoPath, projectId, state, taskId, revision, offset, limit | missing |
| `o8_conversation_prs` | action | action, kind | none explicit | action, threadId, number, repositoryId, pullRequestId, kind, after, limit | missing |
| `o8_send` | message | none | none explicit | none | yes |
| `o8_status` | none declared | none | includeEvidence | none | yes |
| `o8_user_context` | none declared | none | none explicit | none | missing |
| `o8_list_repos` | none declared | none | none explicit | none | missing |
| `o8_register_repo` | none declared | none | none explicit | none | yes |
| `o8_remove_repo` | none declared | none | none explicit | none | missing |
| `o8_init_repo` | none declared | none | none explicit | none | yes |
| `o8_list_projects` | none declared | none | none explicit | none | missing |
| `o8_create_project` | name | none | none explicit | none | yes |
| `o8_set_active_project` | projectId | none | none explicit | none | missing |
| `o8_set_project_repos` | projectId, repoPaths | none | none explicit | none | missing |
| `o8_delete_project` | projectId | none | none explicit | none | missing |
| `o8_scaffold` | kind | kind | none explicit | none | yes |
| `o8_setup` | action | action | workerRuntimes, workerModel | action | missing |
| `o8_approve` | id | none | none explicit | none | yes |
| `o8_reject` | id | none | none explicit | none | yes |
| `o8_history` | sessionKey | none | limit | none | yes |
| `o8_lane_events` | none declared | none | timeoutMs | none | yes |
| `o8_packet_transcript` | packetId | none | limit | none | yes |
| `steer_packet` | packetId, message | none | none explicit | none | missing |
| `o8_operator_defaults` | none declared | 18 enum-bearing settings | includeReceipts, includeAuth, includeDetails, broadcastCommentaryIntervalMinutes, broadcastCommentaryMinNewEvents, broadcastCommentaryMaxPerHour, broadcastVoice, broadcastVoiceLullMinutes, meteredPacketCostCapUsd, meteredPacketInputTokenCap, uiLoopMaxIterations, uiLoopMaxMinutes, uiLoopMaxDiffBytes, uiLoopMaxDiffFiles, uiLoopPreviewTimeoutMs, defaultDispatchRuntime, defaultDispatchModel, requireApproval | none | yes |
| `cortex_knowledge_sources` | action | action | none explicit | action, path, name, id, include, exclude | missing |
| `cortex_propose_observation` | packetId, kind, text | kind, scope | scope | none | missing |
| `cortex_ask` | question | none | projectId, bypassCache, terse | none | missing |
| `o8_feature_list` | repoPath | status | none explicit | status, limit | missing |
| `o8_feature_next` | repoPath | none | none explicit | none | missing |
| `o8_feature_add` | repoPath, title | none | none explicit | title, description, priority, verificationCommand, metadata | missing |
| `o8_feature_verify` | repoPath, featureId, status | status | none explicit | featureId, status, evidence, command, exitCode, modelId, packetId | missing |
| `o8_ground_task` | repoPath, task | none | none explicit | task, featureId, packetId | missing |
| `o8_session_boot` | repoPath | none | none explicit | task, featureId, packetId, modelId | missing |
| `o8_negotiate_contract` | mode, repoPath | mode | none explicit | mode, contractId, featureId, groundingId, generatorTerms, evaluatorTerms | missing |
| `o8_sprint` | mode, repoPath | mode | none explicit | mode, contractId, sprintId, packetId, note | missing |
| `o8_verify` | repoPath, results | none | none explicit | sprintId, note, results | missing |
| `o8_harness_lift_status` | repoPath | none | none explicit | componentKey, modelId, limit | missing |
| `o8_harness_measure` | repoPath, componentKey, modelId, baselineScore, enabledScore, sampleCount | none | none explicit | componentKey, modelId, baselineScore, enabledScore, sampleCount, evidence | missing |
| `o8_harness_transition` | repoPath, componentKey, modelId, lifecycle, reason | lifecycle | none explicit | componentKey, modelId, lifecycle, reason | missing |
| `o8_capabilities` | none declared | none | none explicit | modelId | missing |
| `o8_evaluate_diff` | repoPath, task, diff | none | none explicit | task, diff | missing |
| `o8_harness_bundle` | mode, repoPath | mode | none explicit | mode, bundle | missing |
| `digest` | text, repoPath | none | none explicit | none | yes |
| `fetch_raw` | packetId | none | limit | none | yes |
| `o8_spec_read` | repoPath | none | none explicit | none | missing |
| `o8_spec_review_index` | repoPath | none | none explicit | none | missing |
| `o8_spec_pending_feedback` | repoPath | none | none explicit | none | missing |
| `o8_spec_validate` | repoPath | none | none explicit | none | missing |
| `o8_spec_comment` | repoPath, body | none | by | none | missing |
| `o8_spec_reply` | repoPath, parentId, message | none | author | none | missing |
| `o8_spec_resolve` | repoPath, targetId | none | none explicit | none | missing |
| `o8_spec_suggest` | repoPath, kind | kind | by | none | missing |
| `o8_targets` | repoPath | none | limit, rationales | none | missing |
| `o8_lease_acquire` | resource | none | none explicit | resource, ttlMs, wait | missing |
| `o8_lease_release` | resource | none | none explicit | resource | missing |
| `o8_lease_status` | resource | none | none explicit | resource | missing |
| `o8_lease_list` | none declared | none | none explicit | none | missing |
| `o8_packet_receipt` | packetId | none | none explicit | packetId | missing |
| `o8_verify_receipt` | receiptPath | none | none explicit | receiptPath, showKey | missing |
| `o8_truth_query` | kind | kind | none explicit | kind, packetId, issueNumber, limit | missing |
| `o8_msg_agents` | repo | none | none explicit | repo | missing |
| `o8_msg_send` | to, text | none | none explicit | to, text, from, fromAgentId, repo, laneId, packetId, replyToId, requestId, close | missing |
| `o8_msg_inbox` | agent | none | none explicit | agent, cursor, limit | missing |
| `o8_broadcast_say` | text | none | none explicit | text | missing |
| `o8_broadcast_post` | kind | kind | none explicit | kind, actor, audience, text, title, goal, issue, clear, laneId, packetId | missing |
| `o8_broadcast_token` | action | action | none explicit | action | missing |
| `o8_update_apply` | none declared | none | none explicit | none | missing |
| `o8_view_new_orchestrator_session` | none declared | none | none explicit | none | missing |
| `o8_view_pick_menu_option` | menuLabel, optionLabel | none | none explicit | none | missing |
| `o8_view_surface_state` | none declared | none | none explicit | none | missing |
| `o8_browser_read` | none declared | surface | maxChars | none | missing |
| `o8_browser_rect` | selector | surface | none explicit | none | missing |
| `o8_browser_click` | selector | surface | none explicit | none | missing |
| `o8_browser_type` | selector, text | surface | none explicit | none | missing |
| `o8_browser_grab` | selector | surface | none explicit | none | missing |
| `o8_browser_wait` | selector | surface | timeoutMs | none | missing |
| `o8_view_screenshot` | none declared | none | none explicit | none | missing |
| `o8_view_snapshot` | none declared | none | none explicit | none | missing |
| `o8_view_click` | none declared | none | none explicit | none | missing |
| `o8_view_type` | text | none | none explicit | none | missing |
| `o8_view_read` | none declared | none | none explicit | none | missing |
| `o8_view_eval` | code | none | none explicit | none | missing |
| `o8_view_navigate` | path | none | none explicit | none | missing |
| `o8_view_open_browser` | none declared | none | timeoutMs | none | missing |
| `o8_view_scroll` | none declared | direction | none explicit | none | missing |
| `o8_view_press_key` | key | none | none explicit | none | missing |
| `o8_view_wait_for` | selector | none | timeoutMs | none | missing |
| `o8_view_windows` | none declared | none | none explicit | none | missing |
| `o8_view_manage_window` | operation | operation | windowLabel | none | missing |
| `o8_view_inspect_directory_dialog` | none declared | none | none explicit | none | missing |
| `o8_view_resolve_directory_dialog` | dialog_id, operation, path | operation | none explicit | operation | missing |
| `o8_view_inspect_composer` | none declared | none | none explicit | none | missing |
| `o8_view_attach_image` | composer_id, request_id, filename, media_type, data_base64 | media_type | none explicit | composer_id, media_type, data_base64 | missing |
| `o8_view_image_attachment_status` | request_id | none | none explicit | request_id | missing |
| `o8_view_open_thread` | workspaceId, repoPath, taskId | none | none explicit | none | missing |
| `o8_view_saved_image` | thread_id, message_id, image_id | none | none explicit | thread_id, message_id, image_id | missing |
| `o8_view_hard_reload` | operation | operation | none explicit | operation, document_id | missing |
| `o8_device` | action | action, direction | none explicit | action, deviceId, targetSession, x, y, toX, toY, direction, text | missing |
| `o8_canvas` | verb | none | none explicit | none | missing |
| `o8_render` | markdown | none | none explicit | none | missing |
| `o8_task_artifact` | verb | none | headPolicy | none | missing |
| `o8_html_preview` | none declared | appearance | threadId, repoPath | html, layout, width, appearance | yes |
| `o8_html_render` | title | none | threadId, repoPath | html, title, layout | yes |
| `o8_visualization_read` | id | none | limit | none | missing |
| `o8_view_console_errors` | none declared | none | none explicit | none | missing |
| `o8_view_active_route` | none declared | none | none explicit | none | missing |
| `create_mission` | repoPath | origin, runtime, workerIntent, requestedProvider, carrier, requestedEffort, thinkingEffort, existingBranchPolicy, taskContract | runtime, requestedEffort, sequential, existingBranchPolicy, dispatch, holdMerges, huddle, taskContract | none | yes |
| `dispatch_mission` | none declared | runtime | none explicit | none | yes |
| `get_mission_status` | none declared | none | none explicit | none | missing |
| `mission_tail` | packetId | none | timeoutMs | none | yes |
| `get_packet_scope` | none declared | none | includeDirectives | none | missing |
| `o8_packet_diff` | none declared | none | maxBytes | none | missing |
| `o8_task_list` | none declared | none | includeDone, includeBrief, includeDetails | none | missing |
| `o8_task_create` | title | workerIntent, requestedProvider, requestedRuntime | requestedRuntime | none | missing |
| `o8_task_brief` | taskId | none | none explicit | none | missing |
| `o8_task_claim` | taskId | none | none explicit | none | missing |
| `o8_task_dispatch` | taskId | workerIntent, requestedProvider, requestedRuntime | requestedRuntime | none | missing |
| `o8_task_block` | taskId, reason | code | none explicit | none | missing |
| `o8_task_report` | taskId | reason | none explicit | none | missing |
| `o8_task_archive` | taskId | none | none explicit | none | missing |
| `o8_task_prune` | taskId | none | none explicit | none | missing |
| `o8_problem_list` | none declared | none | none explicit | none | missing |
| `o8_problem_get` | dossierId | none | none explicit | none | missing |
| `o8_pr_stack` | repo, number | none | none explicit | none | missing |
| `wait_for_mission_ready` | none declared | none | timeoutMs, pollIntervalMs | none | missing |
| `submit_review` | packetId, findings, approved | none | none explicit | none | yes |
| `close_packet_unmerged` | packetId, disposition | disposition | none explicit | none | yes |
| `approve_and_merge` | packetId | none | none explicit | none | yes |
| `o8_merge_preview` | packetId | none | none explicit | none | yes |
| `reset_packet` | packetId | none | none explicit | none | yes |
| `retry_packet` | packetId | none | none explicit | none | yes |
| `rerun_with_feedback` | packetId, feedback | none | none explicit | none | yes |
| `o8_review_state` | packetId | none | none explicit | none | yes |
| `report_packet_event` | packetId, event | reason | none explicit | none | yes |
