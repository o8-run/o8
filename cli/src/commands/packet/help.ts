export const PACKET_SUBCOMMANDS = [
  'info',
  'scope',
  'expand-scope',
  'diff',
  'commit',
  'heartbeat',
  'review',
  'park',
  'restore',
  'close',
  'discard',
  'reset',
  'stop',
  'cancel',
  'retry',
  'rerun',
  'steer',
  'approve-merge',
  'merge-preview',
  'report',
  'capture',
  'mirror-proof',
  'log',
  'runtime-drift',
] as const;

export const OPERATOR_PACKET_SUBCOMMANDS = [
  'retain',
  'release-retention',
  'restore-artifacts',
  'receipt',
  'receipts',
] as const;

export const PACKET_COMMAND_LINES = `  packet info [id]     packet metadata; explicit packet/lane id overrides cwd
  packet scope [id]    bounded worker context (--include-directives for bodies)
  packet expand-scope [id] request bounded paths (--paths <path[,path]> --reason <text>)
  packet diff [id]     the packet's code diff vs base (committed + uncommitted)
  packet commit -m ".." stage + commit the current worktree with an explicit pathspec
  packet heartbeat [id] update a packet lane heartbeat
  packet review [id]   approve + merge; cite --coverage for files, --requirement-evidence for non-file requirements, and --process-evidence for process constraints; --supplement-process-evidence completes an existing clean review; --waive-missing-contract <reason> covers an uncaptured default contract
    --run-evidence <JSON-file> records execution at --expected-sha; --not-run <reason> records a read-only review
  packet park [id]     remove a verified review-ready workspace while preserving immutable review
  packet restore [id]  restore a parked workspace to its exact reviewed state
  packet close [id]    close without merging (--reason adopted_elsewhere|superseded|spec_changed|wontfix)
  packet discard [id]  discard without merging (--acknowledge-missing-worktree when the path is gone)
  packet reset [id]    wipe a stuck packet's worktree + lane (then mission dispatch)
  packet stop [id]     interrupt the worker and hold the packet (resume with packet reset/rerun)
  packet cancel [id]   alias for packet stop; interrupt and hold the packet
  packet retry [id]    reset but KEEP the worktree (resume work; then mission dispatch)
  packet rerun [id]    fresh worker with --feedback (relaunches immediately)
  packet steer [id]    nudge a packet's warm session with --message (layer-3 escalation)
  packet approve-merge [id] merge through the gate (operator) — worker-context raises an approval card
  packet merge-preview [id] dry-run the 5-layer merge gate (wouldMerge + blockers)
  packet report [id]   append an agent_report event for this packet
  packet capture [id]  screenshot the agent's app as visual proof (--url --label --before/--after --clip/--full-page --wait-for --hover/--click)
  packet mirror-proof [id] mirror the packet's before/after proof onto a GitHub PR (--pr <n> [--repo owner/repo])
  packet log [id]      read or follow packet lane events (--follow, --since)
  packet runtime-drift [id] detect and warn when a lane's bound runtime drifted`;

export const OPERATOR_PACKET_COMMAND_LINES = `  packet retain [id]   hold automatic workspace retirement (--reason <text>)
  packet release-retention [id] release the exact hold (--hold-id <id>)
  packet restore-artifacts [id] restore selected retained files into an idle successor (--to <id> --paths-json <array>)
  packet receipt [id]  operator only: write a signed receipt JSON for a closed packet (--out <path>)
  packet receipts [id] operator only: list stored signed receipts for a packet`;

export function packetGroupUsage(): string {
  return `usage: o8 packet <subcommand> [flags]\n\n${PACKET_COMMAND_LINES}\n\nRun \`o8 --help\` for the full command surface.\n`;
}

export function packetSubcommandHint(): string {
  return `Valid worker packet subcommands: ${PACKET_SUBCOMMANDS.join(', ')}. Operator-only packet subcommands: ${OPERATOR_PACKET_SUBCOMMANDS.join(', ')}.`;
}
