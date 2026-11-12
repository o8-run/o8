import { resolveDefaultDispatchRuntimeSync } from '@/lib/operator/defaults';
/**
 * LLM Tool definitions and execution.
 *
 * Tools the model can call during a conversation:
 * - search_web: Search the internet
 * - read_file: Read a file from the workspace
 * - list_files: List directory contents
 * - search_code: Search through codebase with grep
 */

import { execFileSync, execSync } from '@/lib/providers/child-process';
import { statSync } from 'node:fs';
import { lstat, unlink } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { createGithubIssue, readGithubIssueOrPr, createPullRequest } from '@/lib/github/tools';
import { safeJoin, safeJoinReal } from '@/lib/fs/safe-path';
import { openWorkspaceFile, readWorkspaceFile, writeWorkspaceFile } from '@/lib/fs/workspace-file';
import { terminalToolEnv } from '@/lib/llm/terminal-tool-env';
import { resolveTerminalWorkingDirectory } from '@/lib/llm/terminal-working-directory';
import { listDispatchableRuntimes } from '@/lib/orchestrator/runtime-capabilities';
import { resolveShell } from '@/lib/process/resolve-shell';
export { canonicalizeTerminalToolArgs, terminalApprovalSummary } from '@/lib/llm/terminal-working-directory';

const DEFAULT_REPO_ROOT = process.env.CORTEX_IDE_REVIEW_REPO_ROOT || process.cwd();
const MAX_FILE_SIZE = 50_000; // 50KB

// ── Tool Definitions (provider-agnostic) ──

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'search_web',
    description: 'Search the internet for current information. Use when you need up-to-date facts, documentation, or external context.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace. Use to examine code, configs, or documentation.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path from the repo root' },
        startLine: { type: 'number', description: 'Optional: start reading from this line (1-indexed)' },
        endLine: { type: 'number', description: 'Optional: stop reading at this line' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and directories in a path. Use to explore the project structure.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory path (default: root)' },
        pattern: { type: 'string', description: 'Optional: glob pattern filter (e.g. "*.tsx")' },
      },
      required: [],
    },
  },
  {
    name: 'search_code',
    description: 'Search through the codebase for text patterns. Use to find function definitions, imports, usages.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search pattern (supports regex)' },
        filePattern: { type: 'string', description: 'Optional: file type filter (e.g. "*.tsx")' },
        maxResults: { type: 'number', description: 'Max results to return (default: 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_github_issue',
    description: 'Create a new GitHub issue. REQUIRES USER APPROVAL. Use when the user asks to file a bug, feature request, or task.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/name format (e.g. o8-run/o8)' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body in markdown' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Optional labels' },
      },
      required: ['repo', 'title', 'body'],
    },
  },
  {
    name: 'read_github_issue_or_pr',
    description: 'Read the details, comments, and diff of a GitHub issue or pull request. Does NOT require approval.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/name format' },
        number: { type: 'number', description: 'Issue or PR number' },
      },
      required: ['repo', 'number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a new branch from uncommitted changes, commit, push, and open a pull request. REQUIRES USER APPROVAL. Use when the user asks to submit their work as a PR.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/name format' },
        branch: { type: 'string', description: 'Branch name to create (e.g. feat/add-auth)' },
        title: { type: 'string', description: 'PR title' },
        body: { type: 'string', description: 'PR description in markdown' },
        baseBranch: { type: 'string', description: 'Base branch (default: main)' },
      },
      required: ['repo', 'branch', 'title', 'body'],
    },
  },
  {
    name: 'write_file',
    description: 'Create a new file or overwrite an existing file in the workspace. REQUIRES USER APPROVAL with full content preview. Use for small, targeted writes (configs, single-file helpers). **For multi-step coding work, refactors, feature implementation, or when the user says "dispatch" / "hand off to Codex" / "assign to an agent", use `dispatch_codex_task` instead** — the orchestrator model is Claude plans, Codex executes in an isolated worktree.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path from repo root (e.g. "src/utils/helpers.ts")' },
        content: { type: 'string', description: 'Full file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Make a surgical edit to an existing file by replacing exact text. REQUIRES USER APPROVAL with diff preview. Use for small in-place fixes. **For multi-step changes, refactors, or when the user says "dispatch" / "hand off to Codex", use `dispatch_codex_task` instead** — the orchestrator model is Claude plans, Codex executes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path from repo root' },
        oldText: { type: 'string', description: 'Exact text to find and replace (must match exactly including whitespace)' },
        newText: { type: 'string', description: 'New text to replace it with' },
      },
      required: ['path', 'oldText', 'newText'],
    },
  },
  {
    name: 'dispatch_codex_task',
    description: 'Delegate a coding task to an isolated-worktree agent. USE THIS when the user says "dispatch", "hand off", "assign to an agent", or asks you to run a multi-step coding task. The orchestrator model: Claude (this chat) plans and reviews, the delegated agent executes in the background. Runtime defaults to the operator setting (Settings → Operator Defaults → Default dispatch runtime). Pass `runtime` explicitly only when overriding that preference. REQUIRES USER APPROVAL.',
    parameters: {
      type: 'object',
      properties: {
        repoPath: { type: 'string', description: 'Absolute path to the target repository (e.g. "/Users/me/projects/my-repo")' },
        branch: { type: 'string', description: 'Branch name for the worktree (e.g. "main" or a feature branch)' },
        label: { type: 'string', description: 'Short human-readable task label (e.g. "Add formatTokens helper")' },
        task: { type: 'string', description: 'The full task description for the agent. Be specific about files to create/edit, constraints, and success criteria.' },
        runtime: {
          type: 'string',
          enum: listDispatchableRuntimes(),
          description: 'Optional override. When omitted, uses the operator default dispatch runtime.',
        },
      },
      required: ['repoPath', 'task'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the workspace. REQUIRES USER APPROVAL. Use only when explicitly asked to remove a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path from repo root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_terminal_command',
    description: 'Execute a shell command in the workspace and return the output. Safe read-only commands run automatically. Write/mutation commands REQUIRE USER APPROVAL. Dangerous commands are blocked. Use for running tests, checking git status, building, installing packages, or any CLI task.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute (e.g. "npm run test", "git status", "ls -la src/")' },
        cwd: { type: 'string', description: 'Optional: working directory relative to repo root (default: repo root)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'list_lanes',
    description: 'List all active lanes. Lanes are durable work units binding a repo, branch, runtime, and session. Use to see what work is in progress.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'lane_command',
    description: 'Issue a command to the lane system. Available verbs: open_lane (create a new work lane), send_turn (send a message to a lane\'s session), interrupt (stop a lane\'s session), request_review (mark lane as needing review), create_pr (create a PR from a lane\'s worktree), merge (merge a lane\'s worktree), complete (mark done), archive (clean up). REQUIRES USER APPROVAL for create_pr, merge, and open_lane.',
    parameters: {
      type: 'object',
      properties: {
        verb: { type: 'string', description: 'Command verb: open_lane, send_turn, interrupt, request_review, create_pr, merge, complete, archive' },
        laneId: { type: 'string', description: 'Lane ID (required for all verbs except open_lane)' },
        message: { type: 'string', description: 'Message text (for send_turn)' },
        repoPath: { type: 'string', description: 'Repository path (for open_lane)' },
        branch: { type: 'string', description: 'Branch name (for open_lane)' },
        runtime: { type: 'string', description: 'Future runtime hint for open_lane. Production launch is restricted to Codex.' },
        label: { type: 'string', description: 'Human-readable label (for open_lane)' },
        reviewSummary: { type: 'string', description: 'Orchestrator review verdict (for merge/create_pr). Shown on the approval card so the operator understands what was done without reading code.' },
      },
      required: ['verb'],
    },
  },
];

// Tools that ALWAYS require user approval before execution
export const APPROVAL_REQUIRED_TOOLS = new Set([
  'create_github_issue',
  'create_pull_request',
  'write_file',
  'edit_file',
  'delete_file',
  'lane_command', // dynamic — some verbs are read-only (send_turn), others mutate (merge, create_pr)
  'dispatch_codex_task', // spawns a new Codex process
  // run_terminal_command uses dynamic approval — see classifyCommand()
]);

// ── Terminal Command Safety Tiers ──

// 🟡 Needs approval: mutation commands
const MUTATION_PREFIXES = [
  'npm install', 'npm run', 'npm ci', 'npm update', 'npm uninstall',
  'npx', 'yarn', 'pnpm',
  'git add', 'git commit', 'git push', 'git pull', 'git merge',
  'git checkout', 'git switch', 'git rebase', 'git reset', 'git stash',
  'go build', 'go install', 'go mod',
  'mkdir', 'touch', 'cp', 'mv', 'ln',
  'pip install', 'pip3 install',
  'cargo build', 'cargo install',
  'make', 'cmake',
  'docker', 'kubectl',
  'cortex import', 'cortex store', 'cortex embed', 'cortex cleanup',
  'cortex lifecycle', 'cortex optimize', 'cortex reimport',
  'gh issue create', 'gh pr create', 'gh pr merge',
];

// 🔴 Blocked: dangerous commands that should never run from chat
const BLOCKED_PATTERNS = [
  /\brm\s+(-[a-z]*r|-[a-z]*f|--recursive|--force)/i,  // rm -rf, rm -r, rm -f
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  /\bchown\b/,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\bformat\b/,
  />\s*\/dev\//,                     // redirect to device files
  /\bcurl\b.*\|\s*(sh|bash|zsh)/,   // curl pipe to shell
  /\bwget\b.*\|\s*(sh|bash|zsh)/,
  /\beval\b/,
  /\bexec\b/,
  /;.*\brm\b/,                      // chained rm
  /&&.*\brm\b/,                     // chained rm
  /\|\s*\brm\b/,                    // piped rm
  /\bkill\s+-9\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bnohup\b.*&/,                   // background persistent processes
  />\s*~\//,                         // overwrite home directory files
];

export type CommandSafety = 'safe' | 'needs_approval' | 'blocked';

export function classifyCommand(command: string): { safety: CommandSafety; reason: string } {
  const trimmed = command.trim();

  // Check blocked patterns first
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safety: 'blocked', reason: `Blocked: matches dangerous pattern ${pattern.source}` };
    }
  }

  // Check mutation prefixes
  for (const prefix of MUTATION_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return { safety: 'needs_approval', reason: `Mutation: ${prefix}` };
    }
  }

  // Shell strings are never intrinsically read-only: `cat` can read credentials,
  // `env` can expose provider keys, and separators/substitutions can append a
  // mutation to an innocent-looking prefix. Every non-blocked command therefore
  // requires an exact, one-shot operator approval.
  return { safety: 'needs_approval', reason: 'Shell command requires exact one-shot approval' };
}

// ── Tool Execution ──

export interface ToolResult {
  content: string;
  sources?: { title: string; url?: string; path?: string }[];
}

export async function executeTool(name: string, args: Record<string, unknown>, repoRoot: string | null = DEFAULT_REPO_ROOT): Promise<ToolResult> {
  switch (name) {
    case 'search_web': return await searchWeb(args.query as string);
    case 'read_file': return await readFile(args.path as string, args.startLine as number | undefined, args.endLine as number | undefined, repoRoot);
    case 'list_files': return listFiles(args.path as string | undefined, args.pattern as string | undefined, repoRoot);
    case 'search_code': return searchCode(args.query as string, args.filePattern as string | undefined, args.maxResults as number | undefined, repoRoot);
    case 'create_github_issue': return await createGithubIssue(args as Parameters<typeof createGithubIssue>[0]);
    case 'read_github_issue_or_pr': return await readGithubIssueOrPr(args as Parameters<typeof readGithubIssueOrPr>[0]);
    case 'create_pull_request': return await createPullRequest(args as Parameters<typeof createPullRequest>[0]);
    case 'write_file': return await writeFile(args.path as string, args.content as string, repoRoot);
    case 'edit_file': return await editFile(args.path as string, args.oldText as string, args.newText as string, repoRoot);
    case 'delete_file': return await deleteFile(args.path as string, repoRoot);
    case 'run_terminal_command': return runTerminalCommand(args.command as string, args.cwd as string | undefined, repoRoot);
    case 'list_lanes': return await executeListLanes();
    case 'lane_command': return await executeLaneCommand(args);
    case 'dispatch_codex_task': return await executeDispatchCodexTask(args);
    default: return { content: `Unknown tool: ${name}` };
  }
}

async function executeListLanes(): Promise<ToolResult> {
  try {
    const { listActiveLanes } = await import('@/lib/lane/registry');
    const lanes = listActiveLanes();
    if (lanes.length === 0) {
      return { content: 'No active lanes.' };
    }
    const summary = lanes.map((lane) =>
      `- **${lane.label}** (${lane.id})\n  Status: ${lane.status} | Runtime: ${lane.runtime} | Branch: ${lane.branch}\n  Repo: ${lane.repoPath}${lane.sessionKey ? `\n  Session: ${lane.sessionKey}` : ''}${lane.packetId ? `\n  Packet: ${lane.packetId}` : ''}`,
    ).join('\n\n');
    return { content: `**Active Lanes (${lanes.length}):**\n\n${summary}` };
  } catch (err) {
    return { content: `Error listing lanes: ${err instanceof Error ? err.message : 'unknown'}` };
  }
}

async function executeLaneCommand(args: Record<string, unknown>): Promise<ToolResult> {
  const verb = args.verb as string;
  if (!verb) return { content: 'Error: verb is required.' };

  try {
    const { dispatch } = await import('@/lib/lane/commands');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic command construction from LLM args
    const command: any = { verb, actor: 'orchestrator' as const };

    if (args.laneId) command.laneId = args.laneId;
    if (args.message) command.message = args.message;
    if (args.repoPath) command.repoPath = args.repoPath;
    if (args.branch) command.branch = args.branch;
    if (args.runtime) command.runtime = args.runtime;
    if (args.label) command.label = args.label;
    if (args.reviewSummary) command.reviewSummary = args.reviewSummary;

    const result = await dispatch(command);
    const laneInfo = result.lane ? `\nLane: ${result.lane.id} (${result.lane.status})` : '';
    return { content: `${result.ok ? 'Success' : 'Failed'}: ${result.note}${laneInfo}` };
  } catch (err) {
    return { content: `Error executing lane command: ${err instanceof Error ? err.message : 'unknown'}` };
  }
}

/**
 * Dispatch a coding task to a new Codex agent.
 *
 * Wraps open_lane + launch_session so the Assistant chat can hand off work
 * to Codex in one tool call, enforcing the orchestrator model (Claude
 * plans, Codex executes). See BUG #4 — without this, the Assistant tends
 * to write files directly instead of delegating.
 */
async function executeDispatchCodexTask(args: Record<string, unknown>): Promise<ToolResult> {
  const repoPath = args.repoPath as string;
  const task = args.task as string;
  const branch = (args.branch as string) || 'main';
  const label = (args.label as string) || task.slice(0, 60);
  const { validateRequestedRuntime, resolveWorkerRouting } = await import('@/lib/agents/routing');
  const runtimeOverride = validateRequestedRuntime(args.runtime, resolveDefaultDispatchRuntimeSync());

  if (!repoPath) return { content: 'Error: repoPath is required.' };
  if (!task) return { content: 'Error: task is required.' };

  const workerRouting = resolveWorkerRouting({
    requestedRuntime: runtimeOverride,
    source: 'dispatch-codex-task',
  });

  try {
    const { dispatch } = await import('@/lib/lane/commands');

    // Step 1: open the lane
    const openResult = await dispatch({
      verb: 'open_lane',
      repoPath,
      branch,
      runtime: workerRouting.selectedRuntime,
      label,
      actor: 'orchestrator',
    });

    if (!openResult.ok || !openResult.lane) {
      return { content: `Failed to open lane for ${workerRouting.selectedRuntime} dispatch: ${openResult.note}` };
    }

    const laneId = openResult.lane.id;

    // Step 2: launch the runtime session with the task as its prompt
    const launchResult = await dispatch({
      verb: 'launch_session',
      laneId,
      prompt: task,
      actor: 'orchestrator',
    });

    if (!launchResult.ok) {
      return { content: `Lane ${laneId} opened but ${workerRouting.selectedRuntime} launch failed: ${launchResult.note}` };
    }

    return {
      content: `Dispatched to ${workerRouting.selectedRuntime}. Lane ${laneId} is executing "${label}" in ${repoPath} on branch ${branch}. ${workerRouting.reason}`,
    };
  } catch (err) {
    return { content: `Error dispatching Codex task: ${err instanceof Error ? err.message : 'unknown'}` };
  }
}

// ── File Operation Tools ──

function requireRepoScope(repoRoot: string | null): repoRoot is string {
  return Boolean(repoRoot);
}

function validatePath(path: string, repoRoot: string | null = DEFAULT_REPO_ROOT, options: { blockSensitive?: boolean } = { blockSensitive: true }): { rel: string } | { error: string } {
  if (!requireRepoScope(repoRoot)) {
    return { error: 'Error: No repository is scoped to this chat' };
  }

  if (isAbsolute(path)) {
    return { error: 'Error: Path must be relative to the repository' };
  }
  const resolved = safeJoin(repoRoot, path);
  if (!resolved) {
    return { error: 'Error: Path must resolve within the repository' };
  }
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith('..') || rel.startsWith('/')) {
    return { error: 'Error: Path must be within the repository' };
  }
  // Block sensitive files. Case-insensitive: macOS APFS is case-insensitive by
  // default, so '.ENV' resolves to the same inode as '.env'.
  if (options.blockSensitive !== false) {
    const relLower = rel.toLowerCase();
    if (relLower.includes('.env') && !relLower.includes('.env.example')) {
      return { error: 'Error: Cannot modify .env files from chat (security)' };
    }
    if (relLower === '.git' || relLower.startsWith('.git/')) {
      return { error: 'Error: Cannot modify .git directory' };
    }
  }
  return { rel };
}

async function writeFile(path: string, content: string, repoRoot: string | null = DEFAULT_REPO_ROOT): Promise<ToolResult> {
  const validation = validatePath(path, repoRoot);
  if ('error' in validation) return { content: validation.error };

  try {
    const { rel } = validation;
    const result = await writeWorkspaceFile(repoRoot!, rel, content);

    const lineCount = content.split('\n').length;
    const byteCount = Buffer.byteLength(content, 'utf-8');

    return {
      content: `${result.created ? 'Created' : 'Wrote'} ${rel} (${lineCount} lines, ${byteCount.toLocaleString()} bytes)`,
      sources: [{ title: rel, path: rel }],
    };
  } catch (err) {
    return { content: `Error writing file: ${err instanceof Error ? err.message : 'Unknown'}` };
  }
}

async function editFile(path: string, oldText: string, newText: string, repoRoot: string | null = DEFAULT_REPO_ROOT): Promise<ToolResult> {
  const validation = validatePath(path, repoRoot);
  if ('error' in validation) return { content: validation.error };

  let opened: Awaited<ReturnType<typeof openWorkspaceFile>> | null = null;
  try {
    const { rel } = validation;
    opened = await openWorkspaceFile(repoRoot!, rel, 'read-write');
    const original = (await opened.handle.readFile()).toString('utf-8');

    // Check if oldText exists in the file
    const idx = original.indexOf(oldText);
    if (idx === -1) {
      // Try to help the model — show nearby content
      const lines = original.split('\n');
      const searchLower = oldText.toLowerCase().slice(0, 50);
      const nearLine = lines.findIndex(l => l.toLowerCase().includes(searchLower));

      if (nearLine >= 0) {
        const context = lines.slice(Math.max(0, nearLine - 2), nearLine + 3).join('\n');
        return {
          content: `Error: Exact text not found in ${rel}. A similar section was found near line ${nearLine + 1}:\n\n\`\`\`\n${context}\n\`\`\`\n\nThe oldText must match exactly (including whitespace and indentation).`,
        };
      }

      return { content: `Error: Text not found in ${rel}. The oldText must match the file content exactly.` };
    }

    // Check for multiple occurrences
    const occurrences = original.split(oldText).length - 1;
    if (occurrences > 1) {
      return {
        content: `Error: Found ${occurrences} occurrences of the text in ${rel}. The oldText must be unique. Add more surrounding context to make it unambiguous.`,
      };
    }

    // Apply the edit
    const updated = original.replace(oldText, newText);
    const updatedBytes = Buffer.from(updated, 'utf-8');
    await opened.handle.truncate(0);
    if (updatedBytes.byteLength > 0) await opened.handle.write(updatedBytes, 0, updatedBytes.byteLength, 0);
    await opened.handle.sync();

    // Calculate change stats
    const oldLines = oldText.split('\n').length;
    const newLines = newText.split('\n').length;
    const added = Math.max(0, newLines - oldLines);
    const removed = Math.max(0, oldLines - newLines);

    return {
      content: `Edited ${rel} — replaced ${oldLines} lines with ${newLines} lines (+${added} -${removed})`,
      sources: [{ title: rel, path: rel }],
    };
  } catch (err) {
    return { content: `Error editing file: ${err instanceof Error ? err.message : 'Unknown'}` };
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}

async function deleteFile(path: string, repoRoot: string | null = DEFAULT_REPO_ROOT): Promise<ToolResult> {
  const validation = validatePath(path, repoRoot);
  if ('error' in validation) return { content: validation.error };

  let opened: Awaited<ReturnType<typeof openWorkspaceFile>> | null = null;
  try {
    const { rel } = validation;
    opened = await openWorkspaceFile(repoRoot!, rel, 'read');
    const size = opened.stat.size;
    const finalStat = await lstat(opened.realPath);
    if (finalStat.dev !== opened.stat.dev || finalStat.ino !== opened.stat.ino) {
      return { content: `Error deleting file: ${rel} changed after open` };
    }
    await unlink(opened.realPath);

    return {
      content: `Deleted ${rel} (${size.toLocaleString()} bytes)`,
      sources: [{ title: `${rel} (deleted)`, path: rel }],
    };
  } catch (err) {
    return { content: `Error deleting file: ${err instanceof Error ? err.message : 'Unknown'}` };
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}

// ── Terminal Command Tool ──

const MAX_OUTPUT = 10_000; // 10KB output cap for LLM
const COMMAND_TIMEOUT = 30_000; // 30s timeout

function runTerminalCommand(command: string, cwd?: string, repoRoot: string | null = DEFAULT_REPO_ROOT): ToolResult {
  const classification = classifyCommand(command);

  if (classification.safety === 'blocked') {
    return { content: `🔴 Command blocked: ${classification.reason}\n\nThis command is not allowed to run from the chat for safety reasons.` };
  }

  const workingDirectory = resolveTerminalWorkingDirectory(repoRoot, cwd);
  if ('error' in workingDirectory) return { content: workingDirectory.error };
  const workDir = workingDirectory.path;

  try {
    const output = execSync(command, { windowsHide: true,
      encoding: 'utf-8',
      timeout: COMMAND_TIMEOUT,
      cwd: workDir,
      maxBuffer: 1024 * 1024, // 1MB buffer
      env: { ...terminalToolEnv(), FORCE_COLOR: '0', NO_COLOR: '1' }, // no ANSI or inherited credentials
      shell: resolveShell(),
    });

    let result = output.trim();

    // Truncate if too long
    if (result.length > MAX_OUTPUT) {
      const truncated = result.slice(0, MAX_OUTPUT);
      result = truncated + `\n\n... (output truncated — ${result.length.toLocaleString()} chars total, showing first ${MAX_OUTPUT.toLocaleString()})`;
    }

    return {
      content: result || '(command completed with no output)',
      sources: [{ title: `$ ${command}`, path: workingDirectory.relativePath }],
    };
  } catch (err) {
    // execSync throws on non-zero exit code — capture both stdout and stderr
    const execErr = err as { stdout?: string; stderr?: string; status?: number; message?: string };
    const stdout = (execErr.stdout || '').trim();
    const stderr = (execErr.stderr || '').trim();
    const status = execErr.status ?? 1;

    let output = '';
    if (stdout) output += stdout;
    if (stderr) output += (output ? '\n\n' : '') + `STDERR:\n${stderr}`;
    if (!output) output = execErr.message || 'Command failed with no output';

    // Truncate
    if (output.length > MAX_OUTPUT) {
      output = output.slice(0, MAX_OUTPUT) + '\n... (truncated)';
    }

    return {
      content: `Exit code ${status}:\n${output}`,
      sources: [{ title: `$ ${command} (exit ${status})`, path: cwd || '.' }],
    };
  }
}

async function searchWeb(query: string): Promise<ToolResult> {
  try {
    // Use Brave Search API if available
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) {
      return { content: 'Web search not configured (BRAVE_SEARCH_API_KEY not set). Please provide the information you need directly.' };
    }

    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
    const res = await fetch(url, {
      headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
    });

    if (!res.ok) {
      return { content: `Search failed (${res.status})` };
    }

    const data = await res.json();
    const results = (data.web?.results ?? []).slice(0, 5);

    const sources = results.map((r: { title: string; url: string }) => ({
      title: r.title,
      url: r.url,
    }));

    const content = results.map((r: { title: string; url: string; description: string }, i: number) =>
      `[${i + 1}] ${r.title}\n${r.description}\nURL: ${r.url}`
    ).join('\n\n');

    return { content: content || 'No results found', sources };
  } catch (err) {
    return { content: `Search error: ${err instanceof Error ? err.message : 'Unknown'}` };
  }
}

async function readFile(path: string, startLine?: number, endLine?: number, repoRoot: string | null = DEFAULT_REPO_ROOT): Promise<ToolResult> {
  try {
    if (!requireRepoScope(repoRoot)) {
      return { content: 'Error: No repository is scoped to this chat' };
    }

    const validation = validatePath(path, repoRoot, { blockSensitive: false });
    if ('error' in validation) return { content: validation.error };
    const opened = await readWorkspaceFile(repoRoot, validation.rel);
    let content = opened.bytes.toString('utf-8');

    if (opened.stat.size > MAX_FILE_SIZE) {
      content = content.slice(0, MAX_FILE_SIZE) + '\n... (truncated)';
    }

    if (startLine || endLine) {
      const lines = content.split('\n');
      const start = Math.max(0, (startLine || 1) - 1);
      const end = endLine || lines.length;
      content = lines.slice(start, end).map((line, i) => `${start + i + 1}: ${line}`).join('\n');
    }

    return {
      content,
      sources: [{ title: path, path }],
    };
  } catch {
    return { content: `Error: File not found: ${path}` };
  }
}

function listFiles(dirPath?: string, pattern?: string, repoRoot: string | null = DEFAULT_REPO_ROOT): ToolResult {
  try {
    if (!requireRepoScope(repoRoot)) {
      return { content: 'Error: No repository is scoped to this chat' };
    }

    const resolved = safeJoinReal(repoRoot, dirPath || '.');
    if (!resolved) {
      return { content: 'Error: Path must resolve within the repository' };
    }
    const rel = relative(repoRoot, resolved);
    if (rel.startsWith('..')) {
      return { content: 'Error: Path outside repository' };
    }

    // execFile with array args — `pattern` is a literal argv token, never a
    // shell string (was `find … -name "${pattern}"` via execSync = injection,
    // SECURITY_AUDIT_2026-07-02 §HIGH-2). `head -30` is replaced by a JS slice.
    const findArgs = pattern
      ? [resolved, '-maxdepth', '2', '-name', pattern, '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.next/*']
      : [resolved, '-maxdepth', '1', '-not', '-name', '.*', '-not', '-name', 'node_modules'];
    const output = execFileSync('find', findArgs, { windowsHide: true, encoding: 'utf-8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 }).trim();
    const entries = output.split('\n').filter(Boolean).slice(0, 30).map(f => {
      const relPath = relative(repoRoot, f);
      try {
        const s = statSync(f);
        return `${s.isDirectory() ? '📁' : '📄'} ${relPath}`;
      } catch {
        return `  ${relPath}`;
      }
    });

    return { content: entries.join('\n') || 'Empty directory' };
  } catch (err) {
    return { content: `Error: ${err instanceof Error ? err.message : 'Unknown'}` };
  }
}

function searchCode(query: string, filePattern?: string, maxResults?: number, repoRoot: string | null = DEFAULT_REPO_ROOT): ToolResult {
  try {
    if (!requireRepoScope(repoRoot)) {
      return { content: 'Error: No repository is scoped to this chat' };
    }

    const max = Math.min(maxResults || 10, 20);
    // execFile with array args — `query`/`filePattern` are literal argv tokens,
    // never a shell string (was `grep … "${query}" | head` via execSync =
    // command injection, SECURITY_AUDIT_2026-07-02 §HIGH-2). `-e` fixes `query`
    // as the pattern even if it leads with `-`; cwd replaces `cd`; JS slice
    // replaces `head`. grep exits 1 on no-match — that is not an error.
    const includes = filePattern
      ? [`--include=${filePattern}`]
      : ['--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.json', '--include=*.md'];
    let raw: string;
    try {
      raw = execFileSync('grep', ['-rn', ...includes, '-e', query, '.'], { windowsHide: true,
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (err) {
      if ((err as { status?: number }).status === 1) return { content: 'No matches found' };
      throw err;
    }
    const output = raw.split('\n').filter(Boolean).slice(0, max).join('\n').trim();

    if (!output) return { content: 'No matches found' };

    const sources = [...new Set(
      output.split('\n').map(line => line.split(':')[0]?.replace('./', ''))
    )].filter(Boolean).map(path => ({ title: path, path }));

    return { content: output, sources };
  } catch {
    return { content: 'No matches found' };
  }
}

// ── Provider Format Converters ──

const ANTHROPIC_EPHEMERAL_CACHE_CONTROL = { type: 'ephemeral' } as const;

export function toolsForAnthropic(options?: { cacheBreakpoint?: boolean }): Array<{ name: string; description: string; input_schema: Record<string, unknown>; cache_control?: typeof ANTHROPIC_EPHEMERAL_CACHE_CONTROL }> {
  const cacheBreakpoint = options?.cacheBreakpoint !== false;
  return TOOLS.map((tool, index) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
    ...(cacheBreakpoint && index === TOOLS.length - 1 ? { cache_control: ANTHROPIC_EPHEMERAL_CACHE_CONTROL } : {}),
  }));
}

export function toolsForOpenAI(): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
  return TOOLS.map((tool) => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
}

export function toolsForGoogle(): { functionDeclarations: { name: string; description: string; parameters: Record<string, unknown> }[] }[] {
  return [{ functionDeclarations: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }];
}
