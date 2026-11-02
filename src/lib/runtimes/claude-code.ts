import { coalesceClaudeTranscript } from './claude-code-transcript';
import { observedCacheTokens } from '@/lib/prompt-cache/usage-evidence';
/**
 * Claude Code Runtime Adapter
 *
 * Discovers Claude Code sessions from ~/.claude/projects/,
 * reads transcripts from JSONL files, and manages lifecycle
 * via the `claude` CLI.
 */
import { execFile } from '@/lib/providers/child-process';
import { access, open, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeSession,
  RuntimeTranscriptEntry,
  RuntimeTranscriptToolCall,
  RuntimeChangedFile,
  RuntimeActionResult,
  LaunchOptions,
  RuntimeTelemetry,
} from '@/lib/runtimes/types';
import {
  detectCompactionEvents,
  jsonlUsageTotal,
  type JsonlEntry,
} from '@/lib/runtimes/compaction-detector';
import { readClaudeRuntimeTelemetry } from '@/lib/runtimes/claude-cost-attribution';
import { readOwnedClaudeRuntimeTelemetry } from '@/lib/runtimes/claude-owned-telemetry';
import { ownedTailToRuntimeTranscript, runtimeTranscriptTime } from '@/lib/runtimes/shared/owned-transcript';
import { getRuntimeTerminalSession } from '@/lib/runtime/terminal-session-registry';
import {
  getOwnedClaudeCodeFleetAdditions,
  getOwnedClaudeCodeRuntimeTail,
  launchOwnedClaudeCodeSession,
  continueOwnedClaudeCodeSession,
} from '@/lib/claude-code/owned';
import { resolveDefaultWorkerEffortSync } from '@/lib/operator/defaults';
import { readClaudeAccountCapacity } from '@/lib/claude-code/live-capacity';
import {
  createLiveClaudeSessionMatcher,
  findLiveClaudeProcesses,
  probeLiveClaudeProcesses,
} from '@/lib/runtimes/claude-code-process-probe';
export {
  findLiveClaudeProcesses,
  probeLiveClaudeProcesses,
  type ClaudeProcessProbeExec,
  type LiveClaudeProbe,
  type LiveClaudeProcess,
} from '@/lib/runtimes/claude-code-process-probe';
const execFileAsync = promisify(execFile);
const CLAUDE_HOME = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const RECENT_WINDOW_MS = 6 * 60 * 60_000; // 6 hours
const CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const CLAUDE_ONE_MILLION_CONTEXT_WINDOW_TOKENS = 1_000_000;
const CLAUDE_CONTEXT_RESERVE_MAX_OUTPUT_TOKENS = 20_000;

const capabilities: RuntimeCapabilities = {
  discover: true,
  readTranscript: true,
  launch: true,
  // Only owned workers can continue; discovered sessions remain watch-only.
  resume: true,
  interrupt: true,
  reviewDiffs: true,
  costTelemetry: true,
  streaming: true,
  capacity: {
    observe: true,
    identitySelection: false,
    identitySelectionReason: 'This runtime does not expose a proven isolated config-home launch contract.',
  },
};

// ── Path helpers ──

/**
 * Detect orchestrator-spawned Claude Code sessions whose CWD lives inside an
 * o8-managed worktree. The worktree manager creates these under
 * `<repo>/.cortex-worktrees/packet-<slug>/` (see `src/lib/worktree/manager.ts`
 * `WORKTREE_DIR_NAME = '.cortex-worktrees'`). Sessions that match this pattern
 * are owned by the orchestrator — they're never spawned manually by the user.
 *
 * Marking these as `ownership: 'owned'` lets the runtime inventory filter
 * surface them on the desktop SessionVisualizer + AgentPanel. Without this
 * tag they'd be dropped because there's no terminal-session-registry entry
 * (orchestrator dispatch goes through the bridge terminal, not the user PTY)
 * and no IDE-session-registry entry (orchestrator lanes aren't IDE workspace
 * tabs). See #649 / #658 for the full context.
 */
function isOrchestratorWorktreeCwd(cwd: string | undefined | null): boolean {
  if (!cwd) return false;
  // Match `.cortex-worktrees/packet-...` anywhere in the path. Tolerate both
  // forward and reverse slashes for safety on alien filesystems even though
  // the worktree manager only writes POSIX paths.
  return /\.cortex-worktrees[\/\\]packet-/.test(cwd);
}

/**
 * Decode Claude Code's project directory name back to a filesystem path.
 * e.g., "-Users-alice-projects" → "/Users/alice/projects"
 */
function decodeProjectPath(encodedName: string): string {
  // Replace leading dash with /, then remaining dashes with /
  // But we need to be careful: the encoding replaces / with -
  return '/' + encodedName.slice(1).replace(/-/g, '/');
}

function normalizeFsPath(filePath?: string) {
  return (filePath ?? '').replace(/\/+$/, '');
}

async function findSessionJsonl(sessionId: string) {
  try {
    const projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
    for (const projectDirName of projectDirs) {
      const jsonlPath = path.join(CLAUDE_PROJECTS_DIR, projectDirName, `${sessionId}.jsonl`);
      try {
        await access(jsonlPath);
        return { jsonlPath, projectDirName };
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function readSessionCwd(jsonlPath: string) {
  try {
    const raw = await readFile(jsonlPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as ClaudeCodeMessage;
        if (typeof parsed.cwd === 'string' && parsed.cwd) {
          return parsed.cwd;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function resolveSessionProjectPath(sessionId: string) {
  const match = await findSessionJsonl(sessionId);
  if (!match) {
    return null;
  }

  const cwd = await readSessionCwd(match.jsonlPath);
  return {
    jsonlPath: match.jsonlPath,
    projectDirName: match.projectDirName,
    projectPath: cwd ?? decodeProjectPath(match.projectDirName),
    cwd,
  };
}

async function resolveMostRecentSessionIdForCwd(cwd: string) {
  const encodedDir = `-${cwd.replace(/^\/+/, '').replace(/\//g, '-')}`;
  const projectDirPath = path.join(CLAUDE_PROJECTS_DIR, encodedDir);
  const dirEntries = await readdir(projectDirPath).catch(() => [] as string[]);
  const jsonlFiles = dirEntries.filter((entry) => entry.endsWith('.jsonl'));
  if (jsonlFiles.length === 0) {
    return null;
  }

  const withStats = await Promise.all(
    jsonlFiles.map(async (entry) => {
      const jsonlPath = path.join(projectDirPath, entry);
      const jsonlStat = await stat(jsonlPath).catch(() => null);
      return {
        file: entry,
        mtime: jsonlStat?.mtimeMs ?? 0,
      };
    }),
  );
  withStats.sort((left, right) => right.mtime - left.mtime);

  return withStats[0]?.file.replace('.jsonl', '') ?? null;
}

async function resolveLiveSessionIdFromPid(pid: number) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }

  try {
    const { stdout: cwdOut } = await execFileAsync(
      'lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { windowsHide: true, timeout: 2000 },
    );
    const cwdLine = cwdOut.split('\n').find((line) => line.startsWith('n/'));
    const cwd = cwdLine?.slice(1);
    return cwd ? await resolveMostRecentSessionIdForCwd(cwd) : null;
  } catch {
    return null;
  }
}

/**
 * Extract a human-readable project name from the path.
 * e.g., "/Users/alice/projects/o8" → "o8"
 */
function projectDisplayName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}

// ── Session JSONL parsing ──

interface ClaudeCodeMessage extends JsonlEntry {
  type: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  content?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  compactMetadata?: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    tokensAfter?: number;
  };
  usage?: Record<string, number>;
  message?: {
    id?: string;
    role?: string;
    content?: MessageContent;
    model?: string;
    usage?: Record<string, unknown>;
  };
}

type ContentBlock = {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
};

type MessageContent = string | ContentBlock[];

function extractTextFromContent(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n').trim();
}

function extractToolCallsFromContent(content: MessageContent): RuntimeTranscriptToolCall[] {
  if (typeof content === 'string' || !Array.isArray(content)) return [];
  const calls: RuntimeTranscriptToolCall[] = [];
  for (const block of content) {
    if (block.type !== 'tool_use' || !block.name) continue;
    const input = block.input && typeof block.input === 'object'
      ? (block.input as Record<string, unknown>)
      : undefined;
    const preview =
      (input?.description as string | undefined)
      ?? (input?.command as string | undefined)
      ?? (input?.pattern as string | undefined)
      ?? (input?.file_path as string | undefined)
      ?? (input?.path as string | undefined)
      ?? undefined;
    calls.push({
      id: (block as { id?: string }).id,
      name: block.name,
      args: input,
      preview: preview ? String(preview).slice(0, 180) : undefined,
      status: 'done',
    });
  }
  return calls;
}

function extractToolName(content: MessageContent): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block.type === 'tool_use' && block.name) return block.name;
  }
  return undefined;
}

function extractFilePath(content: MessageContent): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block.type === 'tool_use' && block.input && typeof block.input === 'object') {
      const input = block.input as Record<string, unknown>;
      if (typeof input.file_path === 'string') return input.file_path;
      if (typeof input.path === 'string') return input.path;
    }
  }
  return undefined;
}

function buildCompactionTranscriptEntry(
  event: ReturnType<typeof detectCompactionEvents>[number],
): RuntimeTranscriptEntry {
  return {
    id: event.id,
    role: 'system',
    text: 'Context compaction event',
    timestamp: event.timestamp,
    type: 'compaction',
    compaction: event,
  };
}

const CONTEXT_WINDOW_SIGNAL_PATTERNS = {
  oneMillion: [
    /set model to .*1m context/i,
    /(?:^|[\s(])(?:opus|sonnet)\[1m\](?:[\s)]|$)/i,
    /--model\s+(?:opus|sonnet)\[1m\]/i,
    /anthropic_model=(?:opus|sonnet)\[1m\]/i,
    /\/model\s+(?:opus|sonnet)\[1m\]/i,
  ],
  default: [
    /set model to .*opus 4\.6(?!.*1m context)/i,
    /set model to .*sonnet 4\.6(?!.*1m context)/i,
    /--model\s+(?:opus|sonnet)(?!\[1m\])/i,
    /anthropic_model=(?:opus|sonnet)(?!\[1m\])/i,
    /\/model\s+(?:opus|sonnet)(?!\[1m\])/i,
  ],
};

const MAX_OUTPUT_TOKEN_KEYS = new Set([
  'maxOutput',
  'max_output',
  'maxOutputTokens',
  'max_output_tokens',
  'maxTokens',
  'max_tokens',
]);

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, '');
}

function extractEntryText(entry: ClaudeCodeMessage): string {
  if (typeof entry.content === 'string' && entry.content) {
    return entry.content;
  }

  if (typeof entry.message?.content === 'string') {
    return entry.message.content;
  }

  if (Array.isArray(entry.message?.content)) {
    return extractTextFromContent(entry.message.content);
  }

  return '';
}

function extractExplicitContextWindowSignal(entry: ClaudeCodeMessage): number | undefined {
  const text = stripAnsi(extractEntryText(entry)).trim();
  if (!text) return undefined;

  if (CONTEXT_WINDOW_SIGNAL_PATTERNS.oneMillion.some((pattern) => pattern.test(text))) {
    return CLAUDE_ONE_MILLION_CONTEXT_WINDOW_TOKENS;
  }

  if (CONTEXT_WINDOW_SIGNAL_PATTERNS.default.some((pattern) => pattern.test(text))) {
    return CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS;
  }

  return undefined;
}

function inferContextWindowFromModel(model?: string): number | undefined {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes('claude-opus-4-6')) return CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS;
  if (normalized.includes('claude-sonnet-5')) return CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS;
  if (normalized.includes('claude-sonnet-4-6')) return CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS;
  if (normalized.startsWith('claude-')) return CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS;
  return undefined;
}

function findNumericMetadataValue(
  value: unknown,
  keys: Set<string>,
  depth = 0,
): number | undefined {
  if (depth > 4 || value == null) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumericMetadataValue(item, keys, depth + 1);
      if (found != null) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;

  for (const [key, candidate] of Object.entries(value)) {
    if (keys.has(key)) {
      const numeric = asFiniteNumber(candidate);
      if (numeric != null) return numeric;
    }
    const nested = findNumericMetadataValue(candidate, keys, depth + 1);
    if (nested != null) return nested;
  }

  return undefined;
}

function calculateContextUsedPercent(
  totalTokens: number,
  contextWindow: number,
  maxOutputTokens?: number,
): number | undefined {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) {
    return undefined;
  }

  const reservedOutputTokens = Math.min(
    maxOutputTokens ?? CLAUDE_CONTEXT_RESERVE_MAX_OUTPUT_TOKENS,
    CLAUDE_CONTEXT_RESERVE_MAX_OUTPUT_TOKENS,
  );
  const effectiveContextWindow = contextWindow - reservedOutputTokens;
  if (effectiveContextWindow <= 0) {
    return undefined;
  }

  return Math.max(
    0,
    Math.min(100, Math.round((totalTokens / effectiveContextWindow) * 100)),
  );
}

type ClaudeTailMetadata = {
  model?: string;
  contextUsedPercent?: number;
  hasErrorInTail: boolean;
};

function extractClaudeTailMetadata(
  lines: string[],
  initialModel?: string,
  initialContextWindowTokens?: number,
): ClaudeTailMetadata {
  let model = initialModel;
  let totalTokens: number | undefined;
  let maxOutputTokens: number | undefined;
  let explicitContextWindowTokens: number | undefined;

  for (const line of [...lines].reverse()) {
    try {
      const parsed = JSON.parse(line) as ClaudeCodeMessage;
      if (!model && parsed.message?.model) {
        model = parsed.message.model;
      }
      if (explicitContextWindowTokens == null) {
        explicitContextWindowTokens = extractExplicitContextWindowSignal(parsed);
      }
      if (maxOutputTokens == null) {
        maxOutputTokens = findNumericMetadataValue(parsed, MAX_OUTPUT_TOKEN_KEYS);
      }
      if (totalTokens == null) {
        totalTokens = jsonlUsageTotal(parsed.message?.usage);
      }
      if (model && totalTokens != null && explicitContextWindowTokens != null && maxOutputTokens != null) {
        break;
      }
    } catch {
      continue;
    }
  }

  const recentTail = lines.slice(-10);
  let hasErrorInTail = false;
  for (const line of recentTail) {
    try {
      const parsed = JSON.parse(line) as ClaudeCodeMessage;
      if (parsed.type === 'system' && typeof parsed.message?.content === 'string') {
        const lower = parsed.message.content.toLowerCase();
        if (
          lower.includes('error')
          || lower.includes('crash')
          || lower.includes('fatal')
          || lower.includes('oom')
          || lower.includes('killed')
        ) {
          hasErrorInTail = true;
          break;
        }
      }
    } catch {
      continue;
    }
  }

  const contextWindow =
    explicitContextWindowTokens
    ?? initialContextWindowTokens
    ?? inferContextWindowFromModel(model);

  return {
    model,
    contextUsedPercent: totalTokens != null && contextWindow != null
      ? calculateContextUsedPercent(totalTokens, contextWindow, maxOutputTokens)
      : undefined,
    hasErrorInTail,
  };
}

// ── Session metadata ──

interface SessionMeta {
  sessionId: string;
  projectDir: string;
  projectPath: string;
  jsonlPath: string;
  lastModified: Date;
  firstUserMessage?: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  contextUsedPercent?: number;
  hasErrorInTail?: boolean;
}

// ── Positional read helpers ──

const HEAD_BYTES = 8 * 1024;       // 8KB for first 20 lines of metadata
const TAIL_BYTES = 64 * 1024;      // 64KB for tail windows (50 + 30 + 10 lines)
const TRANSCRIPT_TAIL_BYTES = 512 * 1024; // 512KB for transcript tail reads (compaction summaries can be large)

/** mtime cache: avoids re-reading files that haven't changed */
const sessionMetaCache = new Map<string, { mtimeMs: number; meta: SessionMeta }>();

/**
 * Read the first `bytes` of a file via positional read.
 * Returns the decoded string. For files smaller than `bytes`, returns the full content.
 */
async function readHead(filePath: string, fileSize: number, bytes: number): Promise<string> {
  const readLen = Math.min(bytes, fileSize);
  if (readLen === 0) return '';
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(readLen);
    const { bytesRead } = await fh.read(buf, 0, readLen, 0);
    return buf.toString('utf-8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Read the last `bytes` of a file via positional read.
 * Returns the decoded string. For files smaller than `bytes`, returns the full content.
 */
async function readTail(filePath: string, fileSize: number, bytes: number): Promise<string> {
  const offset = Math.max(0, fileSize - bytes);
  const readLen = fileSize - offset;
  if (readLen === 0) return '';
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(readLen);
    const { bytesRead } = await fh.read(buf, 0, readLen, offset);
    return buf.toString('utf-8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Parse head lines (first N) from a raw head-read string.
 * Discards the last element if it's a partial line (cut mid-JSON).
 */
function headLines(raw: string, count: number): string[] {
  const lines = raw.split('\n').filter(Boolean);
  // Last line may be truncated at the byte boundary — drop it
  if (lines.length > 0 && !raw.endsWith('\n')) lines.pop();
  return lines.slice(0, count);
}

/**
 * Parse tail lines (last N) from a raw tail-read string.
 * Discards the first element if it's a partial line (cut mid-JSON).
 */
function tailLines(raw: string, count: number): string[] {
  const lines = raw.split('\n').filter(Boolean);
  // First line may be truncated at the byte boundary — drop it
  if (lines.length > 0 && !raw.startsWith('\n') && raw.length > 0) lines.shift();
  return lines.slice(-count);
}

type ClaudeHeadMetadata = {
  firstUserMessage?: string;
  cwd?: string;
  gitBranch?: string;
  model?: string;
  explicitContextWindowTokens?: number;
};

function extractClaudeHeadMetadata(lines: string[]): ClaudeHeadMetadata {
  let firstUserMessage: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let model: string | undefined;
  let explicitContextWindowTokens: number | undefined;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as ClaudeCodeMessage;
      if (parsed.cwd && !cwd) cwd = parsed.cwd;
      if (parsed.gitBranch && !gitBranch) gitBranch = parsed.gitBranch;
      if (parsed.message?.model && !model) model = parsed.message.model;
      if (explicitContextWindowTokens == null) {
        explicitContextWindowTokens = extractExplicitContextWindowSignal(parsed);
      }
      if (parsed.type === 'user' && parsed.message?.content && !firstUserMessage) {
        const text = typeof parsed.message.content === 'string'
          ? parsed.message.content
          : extractTextFromContent(parsed.message.content);
        firstUserMessage = text.slice(0, 200);
      }
      if (cwd && gitBranch && firstUserMessage) break;
    } catch {
      continue;
    }
  }

  return {
    firstUserMessage,
    cwd,
    gitBranch,
    model,
    explicitContextWindowTokens,
  };
}

async function discoverProjectSessions(projectDirName: string): Promise<SessionMeta[]> {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectDirName);

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return [];
  }

  const sessions: SessionMeta[] = [];
  const now = Date.now();

  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const sessionId = entry.replace('.jsonl', '');
    const jsonlPath = path.join(projectDir, entry);

    try {
      const fileStat = await stat(jsonlPath);
      // Skip sessions older than the recent window
      if (now - fileStat.mtimeMs > RECENT_WINDOW_MS) continue;

      // Check mtime cache — skip file I/O if unchanged
      const cached = sessionMetaCache.get(jsonlPath);
      if (cached && cached.mtimeMs === fileStat.mtimeMs) {
        sessions.push(cached.meta);
        continue;
      }

      const fileSize = fileStat.size;

      const headRaw = await readHead(jsonlPath, fileSize, HEAD_BYTES);
      const headMetadata = extractClaudeHeadMetadata(headLines(headRaw, 20));
      const tailRaw = await readTail(jsonlPath, fileSize, TAIL_BYTES);
      const tailMetadata = extractClaudeTailMetadata(
        tailLines(tailRaw, Number.MAX_SAFE_INTEGER),
        headMetadata.model,
        headMetadata.explicitContextWindowTokens,
      );
      const projectPath = headMetadata.cwd ?? decodeProjectPath(projectDirName);

      const meta: SessionMeta = {
        sessionId,
        projectDir,
        projectPath,
        jsonlPath,
        lastModified: fileStat.mtime,
        firstUserMessage: headMetadata.firstUserMessage,
        cwd: headMetadata.cwd ?? projectPath,
        gitBranch: headMetadata.gitBranch,
        model: tailMetadata.model ?? headMetadata.model,
        contextUsedPercent: tailMetadata.contextUsedPercent,
        hasErrorInTail: tailMetadata.hasErrorInTail,
      };

      // Cache for next scan
      sessionMetaCache.set(jsonlPath, { mtimeMs: fileStat.mtimeMs, meta });
      sessions.push(meta);
    } catch { /* skip unreadable files */ }
  }

  return sessions;
}

export function inferHistoricalClaudeStatus(
  meta: Pick<SessionMeta, 'hasErrorInTail' | 'lastModified'>,
  livenessKnown: boolean,
  now = Date.now(),
): RuntimeSession['status'] {
  const ageMs = now - meta.lastModified.getTime();
  if (meta.hasErrorInTail && ageMs < 30 * 60_000) return 'failed';
  // This runs only for a session no live process owns. When the probe actually
  // ran, that absence is the answer: the turn is over. Reporting `reviewing`
  // off transcript mtime claimed a worker was still thinking for five minutes
  // after its process had exited, which is also when an operator most wants to
  // steer it (#1855). The mtime hedge survives only for the case the probe
  // could not run, where absence proves nothing.
  if (!livenessKnown && ageMs < 5 * 60_000) return 'reviewing';
  return 'idle';
}

// ── The Runtime ──

export const claudeCodeRuntime: AgentRuntime = {
  id: 'claude-code',
  displayName: 'Claude Code',
  capabilities,
  getCapacity: (_identityId, options) => readClaudeAccountCapacity(options),

  async discoverSessions(options = {}): Promise<RuntimeSession[]> {
    const fresh = options.fresh ?? false;
    let projectDirs: string[];
    try {
      projectDirs = fresh ? await readdir(CLAUDE_PROJECTS_DIR) : [];
    } catch {
      projectDirs = [];
    }

    const [allSessions, liveProbe] = await Promise.all([
      projectDirs.length > 0
        ? Promise.all(projectDirs.map((dir) => discoverProjectSessions(dir))).then((r) => r.flat())
        : Promise.resolve([]),
      fresh ? probeLiveClaudeProcesses() : Promise.resolve({ processes: [], probed: false }),
    ]);
    const liveProcesses = liveProbe.processes;
    allSessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    const matchesLiveSession = createLiveClaudeSessionMatcher(liveProcesses);

    const results: RuntimeSession[] = allSessions.map((meta): RuntimeSession => {
      const normalizedCwd = normalizeFsPath(meta.cwd ?? meta.projectPath);
      const isLiveSession = matchesLiveSession(meta.sessionId, normalizedCwd);
      const exactLiveProcess = liveProcesses.find((candidate) => candidate.sessionId === meta.sessionId
        && normalizeFsPath(candidate.cwd) === normalizedCwd);
      const status = isLiveSession ? 'running' : inferHistoricalClaudeStatus(meta, liveProbe.probed);
      const name = `${projectDisplayName(meta.projectPath)}${meta.gitBranch ? ` • ${meta.gitBranch}` : ''}`;
      // #658: packet worktrees are owned; user-started terminals are discovered.
      const ownership: RuntimeSession['ownership'] = isOrchestratorWorktreeCwd(meta.cwd ?? meta.projectPath)
        ? 'owned'
        : 'discovered';

      return {
        sessionKey: `claude-code:${meta.sessionId}`,
        runtimeId: 'claude-code',
        displayName: name,
        cwd: meta.cwd ?? meta.projectPath,
        branch: meta.gitBranch,
        status,
        pid: isLiveSession ? exactLiveProcess?.pid : undefined,
        ownership,
        sessionCapabilities: {
          canSendInput: false,
          canInterrupt: status === 'running',
          canReviewDiffs: true,
        },
        lastActivityAt: meta.lastModified,
        initialTask: meta.firstUserMessage,
        // `model` is optional on RuntimeSession and the display helper renders
        // the runtime alone when it is absent. Substituting the bare string
        // 'claude' -- which is not a model id -- printed "Claude Code · claude"
        // as though a real model had been selected (#1869).
        model: meta.model,
        contextUsedPercent: meta.contextUsedPercent,
        tmuxSession: getRuntimeTerminalSession(`claude-code:${meta.sessionId}`)?.sessionName ?? undefined,
      };
    });

    // Create sessions for live Claude Code processes that don't match a recent session.
    // Instead of synthetic IDs, find the REAL most-recent JSONL in the matching project dir
    // so transcript and resume actually work.
    const matchedCwds = new Set(
      results
        .filter((session) => session.status === 'running')
        .map((session) => session.cwd)
        .filter(Boolean),
    );

    for (const proc of liveProcesses) {
      if (!proc.cwd) continue;
      const alreadyMatched = proc.sessionId
        ? results.some(
          (session) => session.sessionKey === `claude-code:${proc.sessionId}` && session.status === 'running',
        )
        : [...matchedCwds].some(
          (cwd) => cwd && (proc.cwd!.startsWith(cwd) || cwd.startsWith(proc.cwd!)),
        );
      if (alreadyMatched) continue;

      // Find the project dir for this CWD
      const encodedDir = `-${proc.cwd.replace(/^\/+/, '').replace(/\//g, '-')}`;
      const projectDirPath = path.join(CLAUDE_PROJECTS_DIR, encodedDir);
      let realSessionId: string | undefined = proc.sessionId;
      let contextUsedPercent: number | undefined;
      let firstUserMessage: string | undefined;
      let gitBranch: string | undefined;
      let model: string | undefined;

      try {
        const dirEntries = await readdir(projectDirPath);
        const jsonlFiles = dirEntries.filter((e) => e.endsWith('.jsonl'));
        if (!realSessionId && jsonlFiles.length > 0) {
          // Find most recently modified JSONL
          const withStats = await Promise.all(
            jsonlFiles.map(async (f) => {
              const fp = path.join(projectDirPath, f);
              const s = await stat(fp).catch(() => null);
              return { file: f, mtime: s?.mtimeMs ?? 0, path: fp };
            }),
          );
          withStats.sort((a, b) => b.mtime - a.mtime);
          const best = withStats[0];
          realSessionId = best.file.replace('.jsonl', '');

          // Positional reads for metadata and context %
          try {
            const bestStat = await stat(best.path);
            const bestSize = bestStat.size;
            const hRaw = await readHead(best.path, bestSize, HEAD_BYTES);
            const headMetadata = extractClaudeHeadMetadata(headLines(hRaw, 20));
            const tRaw = await readTail(best.path, bestSize, TAIL_BYTES);
            const tailMetadata = extractClaudeTailMetadata(
              tailLines(tRaw, Number.MAX_SAFE_INTEGER),
              headMetadata.model,
              headMetadata.explicitContextWindowTokens,
            );
            firstUserMessage = headMetadata.firstUserMessage;
            gitBranch = headMetadata.gitBranch;
            model = tailMetadata.model ?? headMetadata.model;
            contextUsedPercent = tailMetadata.contextUsedPercent;
          } catch { /* couldn't read JSONL */ }
        }
      } catch { /* project dir doesn't exist */ }

      const dirName = proc.cwd.split('/').pop() || 'unknown';
      const displayName = `${dirName}${gitBranch ? ` • ${gitBranch}` : ''}`;

      // #658 — Same orchestrator-vs-user distinction as above; a live process
      // running under `.cortex-worktrees/packet-*` is an orchestrator lane.
      const ownership: RuntimeSession['ownership'] = isOrchestratorWorktreeCwd(proc.cwd)
        ? 'owned'
        : 'discovered';

      results.push({
        sessionKey: realSessionId ? `claude-code:${realSessionId}` : `claude-code:live-${proc.pid}`,
        runtimeId: 'claude-code',
        displayName,
        cwd: proc.cwd,
        branch: gitBranch,
        status: 'running',
        pid: !realSessionId || proc.sessionId === realSessionId ? proc.pid : undefined,
        ownership,
        sessionCapabilities: {
          canSendInput: false,
          canInterrupt: true,
          canReviewDiffs: Boolean(realSessionId),
        },
        lastActivityAt: new Date(),
        initialTask: firstUserMessage ?? `Live Claude Code session (PID ${proc.pid})`,
        // Same as the historical path above: absent is a supported state, and
        // a fabricated model id is not (#1869).
        model,
        contextUsedPercent,
        tmuxSession: realSessionId ? (getRuntimeTerminalSession(`claude-code:${realSessionId}`)?.sessionName ?? undefined) : undefined,
      });
    }

    const owned = await getOwnedClaudeCodeFleetAdditions({ fresh }).catch((error) => {
      console.error('[claude-code-runtime] owned-session discovery failed:', error);
      return null;
    });
    if (owned) {
      for (const agent of owned.agents) {
        const lifecycle = agent.runtimeSurface?.lifecycle?.availability
          ? agent.runtimeSurface.lifecycle as RuntimeSession['lifecycle']
          : undefined;
        results.push({
          sessionKey: agent.sessionKey,
          runtimeId: 'claude-code',
          displayName: agent.name,
          cwd: agent.runtimeSurface?.cwd ?? agent.workspace,
          branch: agent.runtimeSurface?.reviewContext?.branch ?? agent.branch,
          headSha: agent.runtimeSurface?.reviewContext?.head,
          repoSlug: agent.runtimeSurface?.reviewContext?.repoSlug,
          status: agent.status === 'running' ? 'running' : agent.status === 'failed' ? 'failed' : 'reviewing',
          ownership: 'owned',
          sessionCapabilities: {
            canSendInput: agent.runtimeSurface?.capabilities?.sendInput ?? false,
            canInterrupt: agent.runtimeSurface?.capabilities?.interrupt ?? false,
            canReviewDiffs: agent.runtimeSurface?.capabilities?.diffContext ?? true,
          },
          lastActivityAt: new Date(agent.lastActivityAt ?? Number.NaN),
          initialTask: agent.currentTask,
          model: agent.model,
          lifecycle,
          tmuxSession: agent.tmuxSession,
        });
      }
    }

    return results;
  },

  async readTranscript(sessionKey: string, sinceId?: string, limit = 50): Promise<RuntimeTranscriptEntry[]> {
    if (sessionKey.startsWith('claude-code-owned:')) {
      const tail = await getOwnedClaudeCodeRuntimeTail(sessionKey, sinceId ? 200 : limit);
      return ownedTailToRuntimeTranscript(tail, sinceId, limit, { includeSinceEntry: true });
    }

    const sessionId = sessionKey.replace('claude-code:', '');

    // Find the JSONL file across all projects
    let jsonlPath: string | null = null;
    try {
      const projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
      for (const dir of projectDirs) {
        const candidate = path.join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
        try {
          await access(candidate);
          jsonlPath = candidate;
          break;
        } catch { /* not in this project */ }
      }
    } catch { /* projects dir missing */ }

    if (!jsonlPath) return [];

    // Tail-read: only the last chunk instead of the entire file
    const fileStat = await stat(jsonlPath).catch(() => null);
    if (!fileStat || fileStat.size === 0) return [];

    const tailRaw = await readTail(jsonlPath, fileStat.size, TRANSCRIPT_TAIL_BYTES);
    const lines = tailLines(tailRaw, Number.MAX_SAFE_INTEGER);
    const parsedEntries: ClaudeCodeMessage[] = [];

    for (const line of lines) {
      try {
        parsedEntries.push(JSON.parse(line) as ClaudeCodeMessage);
      } catch { /* skip malformed */ }
    }

    const compactionEvents = detectCompactionEvents(parsedEntries);

    const skippedEntryIds = new Set(
      compactionEvents.flatMap((event) => [
        event.boundaryEntryId,
        event.summaryEntryId,
      ]).filter((id): id is string => Boolean(id)),
    );

    const entries: RuntimeTranscriptEntry[] = compactionEvents.map((event) => (
      buildCompactionTranscriptEntry(event)
    ));
    let entryIndex = 0;
    const usageEntries = new Map<string, RuntimeTranscriptEntry>();

    for (const parsed of parsedEntries) {
      if (parsed.uuid && skippedEntryIds.has(parsed.uuid)) continue;
      if (parsed.isCompactSummary) continue;
      if (parsed.type !== 'user' && parsed.type !== 'assistant') continue;
      if (!parsed.message?.content) continue;

      const text = extractTextFromContent(parsed.message.content);
      const toolCalls = parsed.type === 'assistant'
        ? extractToolCallsFromContent(parsed.message.content)
        : [];

      // Skip entries that have neither text nor tool calls (pure tool_result echoes
      // on user turns, or empty assistant events). Both-empty = no UI surface.
      if (!text.trim() && toolCalls.length === 0) continue;

      const id = parsed.uuid ?? `cc-${entryIndex}`;
      entryIndex++;

      const providerMessage = parsed.message.id ?? parsed.uuid;
      if (parsed.type === 'assistant' && providerMessage && parsed.message.usage) {
        const prior = usageEntries.get(providerMessage);
        if (prior) { prior.tokens = undefined; prior.model = undefined; }
      }
      entries.push({
        id,
        role: parsed.type === 'user' ? 'user' : 'assistant',
        ...(parsed.type === 'assistant' && parsed.message.usage ? { tokens: observedCacheTokens(parsed.message.usage), model: parsed.message.model } : {}),
        text,
        ...runtimeTranscriptTime(parsed.timestamp),
        type: 'message',
        toolName: parsed.type === 'assistant' ? extractToolName(parsed.message.content) : undefined,
        filePath: parsed.type === 'assistant' ? extractFilePath(parsed.message.content) : undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      });
      if (parsed.type === 'assistant' && providerMessage && parsed.message.usage) usageEntries.set(providerMessage, entries[entries.length - 1]);
    }

    entries.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());

    const coalesced = coalesceClaudeTranscript(entries);

    // sinceId filtering: return only entries after the given id
    let result = coalesced.filter(
      (entry) => entry.text.trim().length > 0 || (entry.toolCalls && entry.toolCalls.length > 0),
    );
    if (sinceId) {
      const idx = result.findIndex((e) => e.id === sinceId);
      if (idx !== -1) {
        result = result.slice(idx + 1);
      }
    }

    // Return last N entries
    return result.slice(-limit);
  },

  async launch(opts: LaunchOptions): Promise<RuntimeActionResult> {
    const result = await launchOwnedClaudeCodeSession({
      ...opts,
      effort: opts.controlledProvider ? undefined : resolveDefaultWorkerEffortSync('claude-code', opts.effort),
    });
    return {
      ok: result.ok,
      note: result.note,
      sessionKey: result.surfaceId || undefined,
      sideEffect: result.sideEffect,
    };
  },
  async resume(sessionKey: string, prompt: string): Promise<RuntimeActionResult> {
    if (!sessionKey.startsWith('claude-code-owned:')) {
      return { ok: false, sessionKey, note: 'Only owned Claude Code workers can continue through o8. Continue discovered sessions in their original client.' };
    }
    if (!prompt.trim()) return { ok: false, sessionKey, note: 'A follow-up message is required.' };
    try {
      return { ...await continueOwnedClaudeCodeSession(sessionKey, prompt.trim()), sessionKey };
    } catch (error) {
      return { ok: false, sessionKey, note: error instanceof Error ? error.message : 'Claude Code continuation failed.' };
    }
  },

  async interrupt(sessionKey: string): Promise<RuntimeActionResult> {
    const sessionId = sessionKey.replace('claude-code:', '');
    const liveProcesses = await findLiveClaudeProcesses();
    if (liveProcesses.length === 0) {
      return { ok: false, note: 'No live Claude Code process found to interrupt.' };
    }

    const livePidMatch = sessionId.match(/^live-(\d+)$/);
    let targetPids: number[] = [];

    if (livePidMatch?.[1]) {
      targetPids = [Number(livePidMatch[1])];
    } else {
      const sessionProject = await resolveSessionProjectPath(sessionId);
      const sessionCwd = sessionProject?.cwd ?? sessionProject?.projectPath;

      if (sessionCwd) {
        const normalizedTarget = normalizeFsPath(sessionCwd);
        targetPids = liveProcesses
          .filter((proc) => {
            const normalizedProc = normalizeFsPath(proc.cwd);
            return normalizedProc === normalizedTarget
              || normalizedProc.startsWith(`${normalizedTarget}/`)
              || normalizedTarget.startsWith(`${normalizedProc}/`);
          })
          .map((proc) => proc.pid);
      }
    }

    targetPids = [...new Set(targetPids.filter((pid) => Number.isFinite(pid) && pid > 0))];
    if (targetPids.length === 0) {
      return {
        ok: false,
        note: 'No live Claude Code PID matched this session.',
        sessionKey,
      };
    }

    let interrupted = false;
    for (const pid of targetPids) {
      try {
        process.kill(pid, 'SIGINT');
        interrupted = true;
      } catch { /* process may have exited */ }
    }
    return {
      ok: interrupted,
      note: interrupted
        ? `SIGINT sent to Claude Code pid${targetPids.length === 1 ? '' : 's'} ${targetPids.join(', ')}.`
        : 'Could not interrupt the live Claude Code process for this session.',
      sessionKey,
      pids: targetPids,
    };
  },

  async getTelemetry(sessionKey: string): Promise<RuntimeTelemetry | undefined> {
    if (sessionKey.startsWith('claude-code-owned:')) {
      return readOwnedClaudeRuntimeTelemetry(sessionKey);
    }
    let sessionId = sessionKey.replace('claude-code:', '');
    if (sessionId.startsWith('live-')) {
      const pid = Number(sessionId.replace('live-', ''));
      const resolvedSessionId = await resolveLiveSessionIdFromPid(pid);
      if (resolvedSessionId) {
        sessionId = resolvedSessionId;
      }
    }

    const sessionProject = await resolveSessionProjectPath(sessionId);
    if (!sessionProject?.jsonlPath) {
      return undefined;
    }

    return readClaudeRuntimeTelemetry(sessionProject.jsonlPath);
  },

  async getChangedFiles(sessionKey: string): Promise<RuntimeChangedFile[]> {
    const sessionId = sessionKey.replace('claude-code:', '');

    // Find the session to get CWD
    const sessionProject = await resolveSessionProjectPath(sessionId);
    const cwd = sessionProject?.cwd ?? sessionProject?.projectPath ?? null;

    if (!cwd) return [];

    // Use git diff to find changed files
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--numstat', 'HEAD'], { windowsHide: true,
        cwd,
        timeout: 5000,
      });

      return stdout.trim().split('\n').filter(Boolean).map((line) => {
        const [add, del, filePath] = line.split('\t');
        return {
          path: filePath ?? '',
          status: 'modified' as const,
          additions: parseInt(add ?? '0', 10) || 0,
          deletions: parseInt(del ?? '0', 10) || 0,
        };
      });
    } catch {
      return [];
    }
  },
};
