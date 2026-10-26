# Driving o8 from an external agent

Use the running API or CLI to prepare work, dispatch workers, inspect evidence,
and record governed decisions. The app or a development server must be reachable.
Discover the current connection and tool definitions before making an action call.

## Connect and discover

- Run `o8 doctor` to inspect CLI connection readiness. `O8_API_PORT` and
  `O8_API_TOKEN` select a particular server. `O8_DATA_DIR` selects its data profile.
  Keep test and development profiles separate from the installed app's profile.
- Loopback API calls require a bearer token. Localhost is not an authentication
  bypass. Keep bearer values out of prompts, transcripts, and repository files.
- Use the client configuration produced by `o8 mcp install --print` or Settings.
  The usual stdio bridge forwards to the running HTTP host. The standalone server
  supports headless use; it does not start the application backend.
- List the live tools with `POST /api/mcp` and the JSON-RPC request below. Names,
  required fields, enum values, and defaults come from this response.

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
```

A tool call uses `method:"tools/call"` and
`params:{name:"exact_discovered_name",arguments:{...}}`. Send an object for
arguments, including `{}` when no fields are required. CLI command help is
`o8 <group> <command> --help`; group help lists related commands.

## Prepare, then dispatch

MCP `create_mission` dispatches by default. Pass `dispatch:false` to stage work.
CLI `o8 mission create` stages work by default; `--dispatch` starts it.
Select a runtime from live discovery and availability instead of guessing an id.

```text
create_mission({repoPath:"/path/to/repo", issues: ["495"], dispatch:false, holdMerges:true})
create_mission({repoPath:"/path/to/repo", issues_inline:[{title:"Check empty input", body:"Inspect behavior and report evidence"}], dispatch:false, holdMerges:true})
dispatch_mission({missionId:"mission-id-returned-by-create"})
get_mission_status({missionId:"mission-id-returned-by-create"})
```

Use string issue references or inline objects with a non-empty title. Keep the
returned mission and packet identifiers; do not infer identifiers from titles.
Do not dispatch again after a timeout until status establishes what happened.
For supported mutations, keep the same idempotency key after an uncertain response.

## Inspect, steer, and review

```text
get_packet_scope({packetId:"packet-id-from-status"})
o8_packet_diff({packetId:"packet-id-from-status"})
o8_merge_preview({packetId:"packet-id-from-status"})
steer_packet({packetId:"packet-id-from-status", message:"Also check empty input"})
submit_review({packetId:"packet-id-from-status", approved:false, findings:[{file:"src/example.ts", severity:"bug", description:"Empty input is not handled", status: "deferred"}]})
```

Each finding needs file, severity, description, and status. Canonical severity
values are `bug`, `rule_violation`, and `note`; status values are `fixed`,
`accepted`, and `deferred`. Put explanatory text in description or fixSuggestion.
An empty findings array is valid when the review has no findings.

An approved review can unlock automatic merge. Set `holdMerges:true` when merges
must wait for the operator. Run `approve_and_merge` or `o8 packet review --approve`
only when the current task authorizes approval and merge. A merge preview is
read-only and never supplies that authorization by itself.

Use packet transcripts and terminal reasons to diagnose a failed launch. A warm
existing session can be steered; a missing session needs a recovery decision.
`wait_for_mission_ready` wakes for attention or state changes as well as timeouts;
inspect its returned status and wakeReason before deciding to wait again.
Never reset a worktree merely to repair an argument error.

## Ten operator recipes

| Task | Typical CLI call |
| --- | --- |
| Prepare work | `o8 mission create --title "Inspect behavior" --repo /path/to/repo` |
| Dispatch prepared work | `o8 mission dispatch --mission mission-audit --wait` |
| Read mission state | `o8 mission status --mission mission-audit` |
| Preview merge gates | `o8 packet merge-preview --packet pkt-audit` |
| Steer an existing session | `o8 packet steer --packet pkt-audit --message "Also check empty input"` |
| Record approval and attempt merge, when authorized | `o8 packet review --packet pkt-audit --approve --expected-sha <full-sha> --coverage R1=src/example.ts` |
| Acquire a server resource | `o8 lease acquire audit --ttl 2m` |
| Inspect that resource | `o8 lease status audit` |
| Queue a project task | `o8 task create --title "Inspect behavior" --repo /path/to/repo --project project-audit` |
| Block a task | `o8 task block pkt-audit --reason "Waiting for dependency" --code dependency_blocked` |

For server leases, bare TTL values are milliseconds; suffixes are `ms`, `s`, `m`,
and `h`. Default TTL is 2h, allowed duration is 1s through 24h, and `--wait` queues
in FIFO order. Release with `o8 lease release audit` from the same agent process.
`o8 team lease` is a separate checkout-local coordination store.

## Repository notes and errors

```text
o8 spec read --repo /path/to/repo
o8 spec index --repo /path/to/repo
o8 spec pending --repo /path/to/repo
o8 spec check --repo /path/to/repo
```

Agents annotate the operator's o8.md through comment, reply, resolve, and suggest.
Use the returned review item ids for subsequent actions and preserve operator prose.

CLI output is JSON by default; `--human` selects formatted output. Exit codes are
0 success, 1 invalid arguments, 2 unreachable API, 3 unauthorized, 4 not found,
5 conflict, and 6 server timeout with an uncertain outcome. Follow the error's
message and corrective hint. For exit 6, inspect status before repeating a mutation.
For an unauthorized call, check the configured server/profile and token source.
For an unavailable tool, repeat discovery and use an exact exposed name.

Operator defaults persist globally within their profile. Read before changing
them, and restore the original values after a temporary change.
See the [agent reference](../../AGENT_REFERENCE.md#operator-call-recipes) for
additional command families and [agent setup](../operations/agent-setup.md) for connection setup.
