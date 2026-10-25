import { runPrStack } from './commands/pr-stack.js';
import { runBrainSources } from './commands/brain-sources.js';
import { runThreads } from './commands/threads.js';
import { runNext } from './commands/next.js';
import { runSetup } from './commands/setup.js';
/**
 * o8 CLI — agent-first wrapper over the local HTTP API.
 *
 * Design principles (epic #926):
 *   - Agent-first I/O: JSON to stdout by default, --human for pretty fallback.
 *   - Exit codes that mean things: 0 ok, 1 invalid args, 2 connection refused,
 *     3 unauthorized, 4 not found, 5 conflict. Agents branch on these without
 *     parsing strings.
 *   - Stable, schema-versioned output. Every payload carries `schema: o8/cli/<cmd>/v1`.
 *   - Command mode has no telemetry, auto-update, or prompts. Failures loud (stderr),
 *     successes silent unless --verbose.
 *   - Interactive `chat` presents the existing orchestrator transport.
 *   - DRY with MCP: command actions use shared APIs, not duplicate business logic.
 *   - Auto-discovery: env first (O8_API_PORT / O8_API_TOKEN), then ~/.o8/,
 *     then legacy ~/.cortex-ide/, then fallback 3001.
 *
 * Handrolled dispatcher; deliberately no commander/yargs/oclif dependency.
 */

import { CHAT_HELP, runChat } from './commands/chat.js';
import { runAsk } from './commands/ask.js';
import { runMsg, runPresence } from './commands/agents.js';
import { runApp } from './commands/app.js';
import { runBrowser } from './commands/browser.js';
import { runBroadcast } from './commands/broadcast.js';
import { runConnect } from './commands/connect.js';
import { runDoctor } from './commands/doctor.js';
import { runCortexObserve } from './commands/cortex.js';
import { runCi } from './commands/ci.js';
import {
  runBoot,
  runCapabilities,
  runContract,
  runEvaluateDiff,
  runFeature,
  runGround,
  runHarness,
  runSprint,
  runVerify,
} from './commands/harness.js';
import { runInbox } from './commands/inbox.js';
import { runConversationPrs } from './commands/conversation-prs.js';
import { runHistory } from './commands/history.js';
import { runLead } from './commands/lead.js';
import { runLaneTouches } from './commands/lane.js';
import { runArtifact } from './commands/artifact.js';
import { runLease } from './commands/lease.js';
import { isReceiptVerifyInvocation, runVerifyReceipt } from './commands/verify-receipt.js';
import { runTruth } from './commands/truth.js';
import { runMission } from './commands/mission.js';
import { runMcp } from './commands/mcp.js';
import { runProject, runRepo } from './commands/resources.js';
import { runProblem } from './commands/problem.js';
import { runPlugin } from './commands/plugin.js';
import { runStatus } from './commands/status.js';
import { runSession } from './commands/session.js';
import { runRun } from './commands/run.js';
import { runTerminal } from './commands/terminal.js';
import { runMachine } from './commands/machine.js';
import { runServe } from './commands/serve.js';
import { runVersion } from './commands/version.js';
import { runWorkerLogin } from './commands/worker-login.js';
import { runPacketInfo } from './commands/packet/info.js';
import { runPacketHeartbeat } from './commands/packet/heartbeat.js';
import { runPacketLog } from './commands/packet/log.js';
import { runPacketReport } from './commands/packet/report.js';
import { runPacketCapture } from './commands/packet/capture.js';
import { runPacketMirrorProof } from './commands/packet/mirror-proof.js';
import { runPacketReceipt, runPacketReceipts } from './commands/packet/receipt.js';
import { runPacketReview } from './commands/packet/review.js';
import { runPacketScope } from './commands/packet/scope.js';
import { runPacketExpandScope } from './commands/packet/expand-scope.js';
import { runPacketRuntimeDrift } from './commands/packet/runtime-drift.js';
import { runPacketDiff } from './commands/packet/diff.js';
import { runPacketCommit } from './commands/packet/commit.js';
import { runPacketClose } from './commands/packet/close.js';
import { runPacketWorkspace } from './commands/packet/workspace.js';
import { runPacketRetention } from './commands/packet/retention.js';
import { runPacketArtifactRecovery } from './commands/packet/artifact-recovery.js';
import { runPacketStop } from './commands/packet/stop.js';
import {
  OPERATOR_PACKET_COMMAND_LINES,
  PACKET_COMMAND_LINES,
  packetGroupUsage,
  packetSubcommandHint,
} from './commands/packet/help.js';
import {
  runPacketMergePreview,
  runPacketRerun,
  runPacketApproveMerge,
  runPacketReset,
  runPacketRetry,
  runPacketSteer,
} from './commands/packet/recover.js';
import { runSpec } from './commands/spec.js';
import { runTeam } from './commands/team.js';
import {
  runTaskArchive,
  runTaskBlock,
  runTaskBrief,
  runTaskClaim,
  runTaskCreate,
  runTaskDispatch,
  runTaskList,
  runTaskPrune,
  runTaskReport,
} from './commands/task.js';
import { runUpdate } from './commands/update.js';
import { printError, type OutputMode } from './output.js';
import { exitAfterFlush } from './exit.js';
import { CliError, EXIT } from './api.js';

function unknownSubcommandError(group: string, sub: string | undefined): CliError {
  return new CliError(
    `unknown_${group}_subcommand`,
    `Unknown ${group} subcommand: ${sub ?? '(none)'}`,
    EXIT.INVALID_ARGS,
    group === 'packet'
      ? packetSubcommandHint()
      : `Run \`o8 ${group} --help\` to list available subcommands.`,
  );
}

interface ParsedArgs {
  command: string[];
  rest: string[];
  mode: OutputMode;
  jsonExplicit: boolean;
  help: boolean;
  version: boolean;
  secondaryBeforeRest: boolean;
}

const SINGLE_LEVEL_BOOLEAN_FLAGS = new Set([
  '--blocked',
  '--failed',
  '--failing',
  '--passed',
  '--passing',
  '--skipped',
  '--terse',
]);

/**
 * The shared parser reserves the first two bare tokens for command groups. For
 * a one-level command whose first argument is a valued flag, that flag's value
 * lands in `secondary`; put it back after the flag before command-level parsing.
 */
function singleLevelArgs(
  secondary: string | undefined,
  rest: string[],
  secondaryBeforeRest: boolean,
): string[] {
  if (!secondary) return rest;
  const first = rest[0];
  if (first?.startsWith('--') && !first.includes('=') && !SINGLE_LEVEL_BOOLEAN_FLAGS.has(first)) {
    // A valued flag before the positional argument puts its value in
    // `secondary` (`o8 ask --repo /path "question"`). When the positional
    // argument came first, the flag's real value is already next in `rest`
    // (`o8 ask "question" --repo /path`) and must stay there.
    return secondaryBeforeRest
      ? [secondary, ...rest]
      : [first, secondary, ...rest.slice(1)];
  }
  return [secondary, ...rest];
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const rest: string[] = [];
  let human = false;
  let jsonExplicit = false;
  let verbose = false;
  let help = false;
  let version = false;
  let secondaryIndex: number | null = null;
  let firstRestIndex: number | null = null;
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === '--') {
      // End-of-options: everything after `--` is positional (used by `o8 run`
      // to pass a command containing its own flags). Stop interpreting flags.
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (tok === '--human') human = true;
    else if (tok === '--json') jsonExplicit = true;
    else if (tok === '--verbose' || tok === '-v') verbose = true;
    else if (tok === '--help' || tok === '-h') help = true;
    else if (tok === '--version' && command.length === 0) version = true;
    else if (tok.startsWith('-')) {
      if (firstRestIndex === null) firstRestIndex = i;
      rest.push(tok);
    } else if (command.length < 2 && !tok.startsWith('-')) {
      command.push(tok);
      if (command.length === 2) secondaryIndex = i;
    } else {
      if (firstRestIndex === null) firstRestIndex = i;
      rest.push(tok);
    }
    i++;
  }
  return {
    command,
    rest,
    mode: { human, verbose },
    jsonExplicit,
    help,
    version,
    secondaryBeforeRest: secondaryIndex !== null
      && (firstRestIndex === null || secondaryIndex < firstRestIndex),
  };
}

const USAGE = `o8 — agent-first CLI for the local o8 control plane.

usage: o8 <command> [subcommand] [flags]

commands:
  chat                 interactive conversation (o8 chat --help)
  version              CLI version + connected server version
  doctor               verify port + token resolution, ping server; --repair reinstalls the o8 CLI symlink
  status               snapshot: running packets, lanes, merges, approvals
  conversation-prs list|add|remove|reverse  durable conversation PR provenance
  history <thread-id>  continuous orchestrator transcript + audited handoff seams
  lead start           create a persistent lead (--repo --backend --model --effort --brief --idempotency-key)
  lead send            send a replay-safe turn to the same lead
  lead report          record the active lead turn's structured outcome and evidence
  lead status          read a compact persisted receipt without calling the model
  lead wait            bounded wait for receipt updates or a terminal state
  lead stop            durably stop the lead; recovery cannot auto-resume it
  connect [--status]   register this signed-in machine, or list connected machines
  disconnect           remove this machine from the operator's connected devices
  run [--detach] <cmd> run a process in an o8-owned terminal the operator can watch
  run --list           list managed runs (running + recent, with exit codes)
  run --last           show the latest command, start, exit receipt, and retained log
  run stop <runId>     stop a managed run from o8 run --list
  terminal list        list live dashboard terminal session IDs, including detached shells
  terminal show <id> [--lines N]  bounded snapshot of an existing terminal
  terminal observe <id>  read-only live stream from an existing terminal
  terminal control <id>  exclusive input/output to an existing terminal; --human for interactive mode
  terminal wait <id> --match <text> [--timeout ms]  wait read-only for output already present or arriving later
  terminal ... --machine <label-or-id>  run terminal commands on a saved SSH machine
  machine add <target> --label <name>  save a verified SSH terminal machine; optional --port, --ssh-config
  machine list|check|rename|disable|enable|remove  manage saved SSH machines
  serve                start the headless API, WebSocket layer, and supervisor daemon
  O8_REVIEW_MODE=manual o8 serve  hold background reviews and continuations for this run
  serve status         report the daemon pid, ports, health, and launch mode
  serve stop           stop the daemon and reap its server children
  serve renew-token    renew a stopped private profile credential without printing it
  serve restart        stop and restart the daemon with the invoking CLI version
  serve agent install  install and load the per-user headless service
  serve agent uninstall  unload and remove the per-user headless service
  serve agent status   report whether the per-user headless service is loaded
  ask [--terse] "<question>"  ask the Engineering Brain about this repo (answer + cited sources)
  feature list|next|add|verify  durable repo-scoped feature ledger
  ground "<task>"      persist a real-path impact map before execution
  boot [--task "..."]  session boot envelope: git, instructions, ledger, contract, grounding
  contract ...         propose and accept generator/evaluator contracts
  sprint ...           start or tick a one-feature-at-a-time sprint
  verify <receipt.json> verify a signed packet receipt locally (--key, --repo, --show-key)
  truth merged|packet|approvals  query signed receipt-backed project history
  harness verify <feature-id> record computational evidence and optionally tick a sprint
  harness ...          model-keyed lift, lifecycle, and HarnessBundle operations
  capabilities         discover harness artifacts and recommended call order
  evaluate-diff        independent skeptic review of a supplied or git diff
  ci [--config path]   run the versioned o8/ci/v1 local check contract
  app restart [--if-update-pending]  request an app restart; optionally no-op unless an update is pending
  update check          request a fresh native update check without installing
  update apply [--check] [--force]  apply an available update; --check checks first, --force overrides live-work refusal
  browser open [url]   open a page — localhost rides o8's embedded browser, external URLs auto-route to headless Chrome (engine)
  browser read         page text + interactive elements (selectors)
  browser click <sel>  click an element (ghost cursor paints in the o8 UI)
  browser type <sel> <text…>  type into an input (--submit presses Enter)
  browser wait <sel>   poll until a selector resolves (--text, --timeout)
  browser close        end this scope's engine (headless Chrome) session
  broadcast say|automation-say|focus|post|token   speak on demand or from an automation, set focus, post narration, or manage spectator bearers
  msg send|inbox       send a bounded agent message (--reply-to ID, --close) or read this session's inbox
  presence list|join   list live sessions or register an explicit external name
  brain sources        manage read-only markdown knowledge folders
  cortex observe       propose a worker observation for the orchestrator
  lane touches         active lanes touching a path or packet diff
  artifact create      attach an interactive task artifact to this packet or a thread (--title --html <file> --actions <file.json>)
  artifact status|receipts <id>  writability + last receipt, or every submission
  lease acquire <resource> [--ttl 2h] [--wait]  acquire or queue for a named resource
  lease release <resource>  release a resource held by this agent process
  lease status <resource>   read the holder and FIFO queue for one resource
  lease list           list active named resources
  worker spawn         create + dispatch one governed worker from any Git repo (--title --body [--repo path] [--runtime id] [--model m] [--effort adaptive|low|medium|high|max|xhigh|ultra] [--caller label] [--read-only])
  worker login         connect an encrypted native worker token from an operator terminal (macOS; no source checkout needed)
  mission create       stage a mission from an inline task; --dispatch launches it (--title --body [--dispatch] [--model m] [--effort adaptive|low|medium|high|max|xhigh|ultra] [--carrier native|openrouter|codex-subscription] [--caller label] [--read-only] [--existingBranchPolicy auto|reset|continue|error] [--compare m1,m2] [--quality-search-contract file])
  mission dispatch     dispatch packets to workers (async; --wait blocks for launch; --watch blocks until review/terminal — the spawner's notification) [--mission <id>]
  mission status       mission + packet state [--mission <id>] [--cost]
  mission stop         interrupt and hold every packet in a mission [--mission <id>]
  mission wait         block until a packet hits a review/terminal state [--timeout <milliseconds|5m|90s> --poll]
  mission tail         stream packet status transitions until terminal [--timeout <milliseconds|5m|90s> --poll]
  mcp install          install/print the o8 MCP config (--claude-code | --cursor | --opencode | --print)
  setup status         inspect first-run choices, readiness, and app handoffs
  setup configure      --lead <runtime> --workers <list> [--lead-model <id>] [--worker-model <id>]
  setup open <path>    open a project through visible onboarding without a folder dialog
  setup cancel <id>    cancel a pending setup request; keep projects and settings
  repo list            list repositories registered in the running o8 app
  repo add <path>      register an existing local Git repository
  repo remove <target> unregister by id, name, or path; the local folder is preserved
  project list         list projects, active state, and registered repo membership
  project create <name> [--repo <target>...]  create a project from registered repos
  project use <target> switch the active project by id or name
  project add-repo <project> <repo>     attach a registered repo to a project
  project remove-repo <project> <repo>  detach it while preserving registration and disk
  project delete <target>               remove a project and exclusive repo registrations; disk is preserved
  pr-stack --repo owner/repo --number N  read native PR layers, revisions and provenance
  threads list         project work grouped by waiting/review/working/resolved (--repo path, --state, --offset, --limit)
  threads show <id>    exact recorded thread evidence (--repo path)
  problem list         recurring problems detected across independent work (--all includes suppressed)
  problem show <id>    full evidence, remedy, and closure state for one problem dossier
  plugin list          list reviewed executable actions [--plugin ID]
  plugin source review --directory <local-folder> [--repo <registered-path>]
  plugin source review --github <owner/repository> --commit <40-character-sha> [--path <package-directory>] [--repo <registered-path>]
  plugin source link   --directory <reviewed-folder> --revision <sha256> [--repo <registered-path>]
  plugin state clear   <plugin-id> --revision <sha256> --confirm (clear saved data)
  plugin action list   list action IDs, revisions, and project bindings [--plugin ID]
  plugin action invoke <plugin-id> <action-id> --revision <sha256> [--repo <registered-path>]
  plugin log list      read persisted, bounded action receipts [--plugin ID] [--limit N]
  plugin terminal list list persistent plugin terminals [--plugin ID]
  plugin terminal launch <plugin-id> <entry-id> --revision <sha256> [--repo <path>] [--request <uuid>]
  plugin terminal stop <receipt-id> (stop the process, retain its receipt)
  inbox list           pending governance approvals (--all includes resolved)
  inbox approve <id>   approve a card → runs the deferred action (e.g. a held merge)
  inbox reject <id>    reject a pending approval
${OPERATOR_PACKET_COMMAND_LINES}
  next --enable-next --binary PATH --server URL  opt-in native saved transcript
  session show <key>   provider-native transform capabilities, lineage, and checkpoints
  session import <key> add a discovered provider session without claiming packet ownership
  session checkpoint <key> save a durable provider position for later forks
  session fork <key>   create a new provider session from a checkpoint
  session rewind <key> create a new continuation while preserving the original
  session resume <key> --message <text> [--idempotency-key <key>]  admit a continuation turn
  session dismiss-pending <key> --confirm-no-continuation  clear an unresolved attempt after provider inspection
  task list            current task pool grouped by ready/running/review/etc.
  task create          add a project-backed task to the ready pool
  task brief <id>      project-backed task brief for a packet or lane
  task claim <id>      bind/reserve a task to a lane
  task dispatch <id>   launch the claimed task through Codex-only routing
  task block <id>      mark a task blocked with --reason
  task report <id>     append a structured task progress event
  task archive <id>    prune/archive stale task-pool rows
  task prune <id>      permanently remove done/archived task-pool rows
${PACKET_COMMAND_LINES}

flags:
  --json (default)     JSON output for agents
  --human              pretty ANSI output for humans
  -v, --verbose        extra detail
  -h, --help           show this help

env:
  O8_API_PORT          override port (set by dispatch for worker agents)
  O8_API_TOKEN         override bearer token (set by dispatch)
  O8_SPECTATOR_TOKEN   scoped spectator bearer preferred by o8 truth
  CORTEX_IDE_DATA_DIR  override data dir (default ~/.o8, legacy ~/.cortex-ide)

exit codes:
  0 ok   1 invalid args   2 connection refused
  3 unauthorized   4 not found   5 conflict
  6 server timeout (ambiguous: the operation may have landed)

error JSON:
  error.ambiguous is true when retry safety cannot be inferred from the result
`;

/**
 * Group-scoped help (#1576): `o8 packet --help` used to print the GLOBAL usage
 * while unknownSubcommandError's hint pointed right back at it — a circle.
 * Extract the group's own lines from USAGE; null when the group has none
 * (caller falls back to the full USAGE).
 */
function groupUsage(group: string): string | null {
  if (group === 'chat') return CHAT_HELP;
  if (group === 'packet') return packetGroupUsage();
  const lines = USAGE.split('\n').filter((line) => new RegExp(`^  ${group}( |$)`).test(line));
  if (lines.length === 0) return null;
  return `usage: o8 ${group} <subcommand> [flags]\n\n${lines.join('\n')}\n\nRun \`o8 --help\` for the full command surface.\n`;
}

async function dispatch(args: ParsedArgs): Promise<number> {
  // The o8 CLI runs INSIDE an agent's packet worktree by design, and spawns
  // bare `git` / `gh`. Windows resolves a bare command name against the current
  // directory before PATH, so without this a repo shipping its own `git.cmd`
  // would be executed here — with whatever the CLI was invoked with. The server
  // processes set the same guard; this is the surface that actually runs in
  // untrusted trees.
  if (process.platform === 'win32') process.env.NoDefaultCurrentDirectoryInExePath = '1';
  const [primary, secondary] = args.command;
  if (args.version && !primary) return runVersion(args.mode);
  // `run` owns all flag parsing for its wrapped command (extractRunCommand reads
  // raw argv), so a `--help`/`-h` meant for the wrapped tool must NOT trigger o8's
  // global help here — otherwise `o8 run node --help` prints o8 USAGE + exit 0.
  if (args.help && primary !== 'run') {
    process.stdout.write((primary && groupUsage(primary)) || USAGE);
    return 0;
  }
  if (!primary) {
    if (!args.jsonExplicit && process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb') return runChat(args.rest);
    process.stdout.write(USAGE);
    return 1;
  }
  switch (primary) {
    case 'next':
      return runNext(process.argv.slice(process.argv.indexOf('next') + 1).filter(arg => !['--human', '--verbose', '-v'].includes(arg)));
    case 'chat':
      if (args.jsonExplicit) throw new CliError('invalid_args', 'o8 chat is interactive. Use o8 lead or o8 history for JSON.', EXIT.INVALID_ARGS);
      return runChat(process.argv.slice(2).filter((arg) => !['--human', '--verbose', '-v'].includes(arg)).slice(1));
    case 'version':
      return runVersion(args.mode);
    case 'doctor':
      return runDoctor(args.mode, args.rest);
    case 'status':
      return runStatus(args.mode);
    case 'conversation-prs':
      return runConversationPrs(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
    case 'history':
      return runHistory(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
    case 'lead':
      return runLead(args.mode, secondary, args.rest);
    case 'connect':
      return runConnect(args.mode, 'connect', secondary ? [secondary, ...args.rest] : args.rest);
    case 'disconnect':
      return runConnect(args.mode, 'disconnect', secondary ? [secondary, ...args.rest] : args.rest);
    case 'run':
      return runRun(args.mode, args.rest);
    case 'terminal':
      return runTerminal(args.mode, secondary, args.rest);
    case 'machine':
      return runMachine(args.mode, secondary, args.rest);
    case 'serve':
      return runServe(args.mode, secondary, args.rest);
    case 'ask':
      // The question lands in `secondary` (first positional) when quoted, or
      // spreads across secondary + rest when unquoted — hand both to the parser.
      return runAsk(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
    case 'feature':
      return runFeature(args.mode, secondary, args.rest);
    case 'ground':
      return runGround(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
    case 'boot':
      return runBoot(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
    case 'contract':
      return runContract(args.mode, secondary, args.rest);
    case 'sprint':
      return runSprint(args.mode, secondary, args.rest);
    case 'verify':
      return isReceiptVerifyInvocation(singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest))
        ? runVerifyReceipt(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest))
        : runVerify(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
    case 'truth':
      return runTruth(args.mode, secondary, args.rest);
    case 'harness':
      return runHarness(args.mode, secondary, args.rest);
    case 'capabilities':
      return runCapabilities(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
    case 'evaluate-diff':
      return runEvaluateDiff(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
    case 'ci':
      return runCi(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
    case 'app':
      return runApp(args.mode, secondary, args.rest);
    case 'update':
      return runUpdate(args.mode, secondary, args.rest);
    case 'browser':
      return runBrowser(args.mode, secondary, args.rest);
    case 'broadcast':
      return runBroadcast(args.mode, secondary, args.rest);
    case 'msg':
      return runMsg(args.mode, secondary, args.rest);
    case 'presence':
      return runPresence(args.mode, secondary, args.rest);
    case 'brain':
      if (secondary === 'sources') return runBrainSources(args.mode, args.rest);
      throw unknownSubcommandError('brain', secondary);
    case 'cortex': {
      if (secondary === 'observe') return runCortexObserve(args.mode, args.rest);
      throw unknownSubcommandError('cortex', secondary);
    }
    case 'artifact':
      return runArtifact(args.mode, secondary, args.rest);
    case 'lane': {
      if (secondary === 'touches') return runLaneTouches(args.mode, args.rest);
      throw unknownSubcommandError('lane', secondary);
    }
    case 'lease':
      return runLease(args.mode, secondary, args.rest);
    case 'mission':
      return runMission(args.mode, secondary, args.rest);
    case 'worker': {
      if (secondary === 'login') return runWorkerLogin(args.mode, args.rest);
      if (secondary === 'spawn') return runMission(args.mode, 'create', [...args.rest, '--dispatch']);
      throw unknownSubcommandError('worker', secondary);
    }
    case 'mcp':
      return runMcp(args.mode, secondary, args.rest);
    case 'setup': return runSetup(args.mode, secondary, args.rest);
    case 'repo':
      return runRepo(args.mode, secondary, args.rest);
    case 'project':
      return runProject(args.mode, secondary, args.rest);
    case 'pr-stack':
      return runPrStack(args.mode, singleLevelArgs(secondary, args.rest, args.secondaryBeforeRest));
    case 'threads':
      return runThreads(args.mode, secondary, args.rest);
    case 'problem':
      return runProblem(args.mode, secondary, args.rest);
    case 'plugin':
      return runPlugin(args.mode, secondary, args.rest);
    case 'inbox':
      return runInbox(args.mode, secondary, args.rest);
    case 'session':
      return runSession(args.mode, secondary, args.rest);
    case 'task': {
      if (secondary === 'list') return runTaskList(args.mode, args.rest);
      if (secondary === 'create') return runTaskCreate(args.mode, args.rest);
      if (secondary === 'brief') return runTaskBrief(args.mode, args.rest);
      if (secondary === 'claim') return runTaskClaim(args.mode, args.rest);
      if (secondary === 'dispatch') return runTaskDispatch(args.mode, args.rest);
      if (secondary === 'block') return runTaskBlock(args.mode, args.rest);
      if (secondary === 'report') return runTaskReport(args.mode, args.rest);
      if (secondary === 'archive') return runTaskArchive(args.mode, args.rest);
      if (secondary === 'prune') return runTaskPrune(args.mode, args.rest);
      throw unknownSubcommandError('task', secondary);
    }
    case 'packet': {
      if (secondary === 'info') return runPacketInfo(args.mode, args.rest);
      if (secondary === 'scope') return runPacketScope(args.mode, args.rest);
      if (secondary === 'expand-scope') return runPacketExpandScope(args.mode, args.rest);
      if (secondary === 'diff') return runPacketDiff(args.mode, args.rest);
      if (secondary === 'commit') return runPacketCommit(args.mode, args.rest);
      if (secondary === 'heartbeat') return runPacketHeartbeat(args.mode, args.rest);
      if (secondary === 'review') return runPacketReview(args.mode, args.rest);
      if (secondary === 'park' || secondary === 'restore') {
        return runPacketWorkspace(args.mode, secondary, args.rest);
      }
      if (secondary === 'restore-artifacts') return runPacketArtifactRecovery(args.mode, args.rest);
      if (secondary === 'retain' || secondary === 'release-retention') {
        return runPacketRetention(args.mode, secondary === 'retain' ? 'hold' : 'release', args.rest);
      }
      if (secondary === 'close' || secondary === 'discard') {
        return runPacketClose(args.mode, args.rest, secondary);
      }
      if (secondary === 'reset') return runPacketReset(args.mode, args.rest);
      if (secondary === 'stop' || secondary === 'cancel') return runPacketStop(args.mode, args.rest);
      if (secondary === 'retry') return runPacketRetry(args.mode, args.rest);
      if (secondary === 'rerun') return runPacketRerun(args.mode, args.rest);
      if (secondary === 'steer') return runPacketSteer(args.mode, args.rest);
      if (secondary === 'approve-merge') return runPacketApproveMerge(args.mode, args.rest);
      if (secondary === 'merge-preview') return runPacketMergePreview(args.mode, args.rest);
      if (secondary === 'report') return runPacketReport(args.mode, args.rest);
      if (secondary === 'capture') return runPacketCapture(args.mode, args.rest);
      if (secondary === 'mirror-proof') return runPacketMirrorProof(args.mode, args.rest);
      if (secondary === 'receipt') return runPacketReceipt(args.mode, args.rest);
      if (secondary === 'receipts') return runPacketReceipts(args.mode, args.rest);
      if (secondary === 'log') return runPacketLog(args.mode, args.rest);
      if (secondary === 'runtime-drift') return runPacketRuntimeDrift(args.mode, args.rest);
      throw unknownSubcommandError('packet', secondary);
    }
    case 'spec':
      return runSpec(args.mode, secondary, args.rest);
    case 'team':
      return runTeam(args.mode, secondary, args.rest);
    default:
      throw new CliError(
        'unknown_command',
        `Unknown command: ${primary}`,
        EXIT.INVALID_ARGS,
        'Run `o8 --help` for the full command surface.',
      );
  }
}

const parsed = parseArgs(process.argv.slice(2));
try {
  const code = await dispatch(parsed);
  await exitAfterFlush(code);
} catch (err) {
  await exitAfterFlush(printError(err, parsed.mode));
}
