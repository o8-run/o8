# Project threads

`GET /api/panel/threads`, `o8 threads list|show`, and the full-profile
`o8_threads_list` MCP tool share `readProjectThreads`. Reads project persisted
missions, current packets, lanes, inbox incidents, pending approvals, saved
conversations, discovered sessions and recorded handoffs. They do not dispatch,
merge, resolve approvals, reconcile incidents or refresh GitHub.

Project identities use the same explicit panel mapping as the UI. Mission
containers retain child packet IDs; discovered workers already owned by a lane
are not repeated as standalone sessions. Synthetic records cannot enter task
mutation routes. Chat-card navigation uses the registered workspace, exact repo
and task identity, viewport checks and a mounted-detail receipt.

Lists have a maximum page size of 250. Pass the first page's `revision` with
subsequent offsets; a changed ordering returns 409. The UI publishes a new list
only after every page succeeds. A failed refresh retains the current list and
shows an error. Hidden views do not poll.

Evidence is attributable to an exact packet, lane, session and repository.
Requirements become checked only when the latest current-HEAD review supplies
valid contract coverage, with a final HEAD fence. PR links join immutable
repository and pull-request identities. Unknown checks and missing usage stay
unknown. Tool counts are local transcript reads, bounded to 5,000 entries and
two seconds, on selected details or an explicit Agents request. They never
start a provider turn. Usage comes from the existing ledger, without new
accounting. HTML artifacts use a script-disabled sandbox; file cards label
current working-copy previews instead of claiming immutable completion bytes.

Grouping candidates A (missions), B (missions and owned conversations), and C
(all recorded work) share `groupThreads`. C remains the loss-avoiding default;
A/B are comparison views available with `--model` or the equivalent API/MCP
argument. Run an offline comparison with:

```
npx tsx scripts/bench/interactions/thread-model-replay.ts snapshots.json
```

Each input snapshot contains `at`, canonical `tasks`, and independently recorded
`attentionIds`. The report counts missing attention observations, duplicate
session rows, rows per day and rows without recorded context. The synthetic
14-day regression demonstrates why standalone discovered attention must not be
omitted. It is not a replay of an operator's complete historical inventory.
Choosing a less inclusive model still requires the issue's real-history replay
and operator comparison; historical runtime discovery snapshots cannot be
reconstructed from the current session list.
