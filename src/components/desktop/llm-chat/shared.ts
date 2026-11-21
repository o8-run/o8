import type { SavedChatRepoContext } from '@/lib/llm/chat-history';
import type { LinkedIssueRef } from '@/components/desktop/IssueLinkPicker';
import type { ClaudeCodeStreamJsonChatEvent } from '@/lib/claude-code/stream-json-parser';

export interface ToolCallInfo {
  name: string;
  status: 'calling' | 'running' | 'done';
  args?: Record<string, unknown>;
  preview?: string;
}

export interface SourceInfo {
  title: string;
  url?: string;
  path?: string;
  index?: number;
}

export interface ThinkingStep {
  type: 'thinking' | 'tool' | 'search' | 'reading' | 'analyzing';
  label: string;
  description?: string;
  status: 'active' | 'complete' | 'pending';
  detail?: string;
}

export interface LLMMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  costUsd?: number;
  inferenceRoute?: { provider: 'chatgpt-plan'; billing: 'subscription'; allowanceUse: 'unknown'; meter: 'provider-tokens' };
  timestamp: number;
  images?: string[];
  toolCalls?: ToolCallInfo[];
  sources?: SourceInfo[];
  thinking?: string;
  thinkingSteps?: ThinkingStep[];
  thinkingDurationMs?: number;
  claudeCodeEvents?: ClaudeCodeStreamJsonChatEvent[];
  isError?: boolean;
  recalledFacts?: number;
  isCompaction?: boolean;
  compactedCount?: number;
  isPartial?: boolean;
  fallbackNotice?: string;
}

export interface FileChangePreview {
  id: string;
  path: string;
  shortFile: string;
  tool: 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit' | 'apply_patch';
  additions: number;
  deletions: number;
  oldText?: string;
  newText?: string;
  content?: string;
}

export interface QueuedContextCard {
  id: string;
  reason?: string;
  text: string;
  title: string;
  meta: string[];
  preview?: string;
  previewImageDataUri?: string;
}

export interface HistoryConversationItem {
  tabId: string;
  title: string;
  preview: string;
  messageCount: number;
  model: string;
  savedAt: string;
  modifiedAt: string;
  starred: boolean;
  repoName?: string | null;
  repoPath?: string | null;
  repoBranch?: string | null;
  remoteUrl?: string | null;
}

export interface MissionRepoSummary {
  name: string;
  localPath?: string;
  remoteUrl?: string | null;
  slug?: string | null;
  issueCount: number | null;
  prCount: number | null;
}

export interface MissionAction {
  id: string;
  kind: 'send' | 'focus' | 'history';
  label: string;
  prompt?: string;
  historyTabId?: string;
  historyTitle?: string;
  historyRepo?: SavedChatRepoContext | null;
}

export interface MissionCardData {
  source: 'history' | 'repo' | 'codebase' | 'freeform';
  eyebrow: string;
  title: string;
  description: string;
  actions: MissionAction[];
}

export interface ModelOption {
  id: string;
  label: string;
  provider: 'anthropic' | 'openai' | 'google' | 'openrouter' | 'local' | 'operator' | 'chatgpt';
  color: string;
  description: string;
  /** 'cli' = routed through installed CLI runtime, 'api' = direct API via BYOK key */
  backend: 'cli' | 'api';
  /** Which CLI runtime powers this model (only when backend === 'cli') */
  cliRuntime?: 'claude-code' | 'codex' | 'opencode';
  /** Whether this model supports thinking/reasoning output */
  supportsThinking?: boolean;
  /** Default effort level for CLI models (Claude: low/medium/high/max) */
  defaultEffort?: 'low' | 'medium' | 'high' | 'max';
}

export interface PreferredRepoContext {
  name?: string;
  localPath?: string;
  branch?: string | null;
  remoteUrl?: string | null;
}

export interface PendingApprovalState {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  summary: string;
  editable?: boolean;
  diff?: { before?: string; after?: string; path?: string };
}

export interface AttachedImage {
  name: string;
  dataUri: string;
  mimeType?: string;
}

export interface FileSuggestion {
  path: string;
  name?: string;
}

export interface ActiveThinkingState {
  steps: ThinkingStep[];
  thinking: string;
}

export interface LLMChatProps {
  tabId: string;
  preferredRepo?: PreferredRepoContext | null;
  linkedIssue?: LinkedIssueRef | null;
  draftInjection?: { id: string; text: string; autoSend?: boolean; reason?: string; previewImageDataUri?: string } | null;
  onSummaryChange?: (tabId: string, summary: string | null) => void;
  onConsumeDraftInjection?: (injectionId: string) => void;
  onLinkedIssueChange?: (issue: LinkedIssueRef | null) => void;
  onOpenInCanvas?: (code: string, language: string) => void;
  onRunInTerminal?: (command: string) => void;
  onOpenHistoryChat?: (historyTabId: string, title: string, repo?: SavedChatRepoContext | null) => void;
}

export interface SlashCommandOption {
  command: string;
  label: string;
  description: string;
  icon: 'globe' | 'search' | 'file' | 'brain' | 'review' | 'idea' | 'test' | 'fix' | 'issue' | 'pr' | 'terminal';
  prefix: string;
}

/** Models available per CLI runtime — the actual models each CLI supports */
export const CLI_RUNTIME_MODELS: Record<string, ModelOption[]> = {
  // claude-code CLI rows removed June 2026. Anthropic's pricing change bills
  // every `claude --print` against the user's Agent SDK credit pool — we
  // route Claude through the LLM proxy (user's ANTHROPIC_API_KEY) or the
  // operator MCP server (user's own Claude Code / Desktop session) instead.
  'claude-code': [],
  codex: [
    { id: 'cli:codex:gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai', color: '#10a37f', description: 'Orchestrator flagship', backend: 'cli', cliRuntime: 'codex', supportsThinking: true },
    { id: 'cli:codex:gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai', color: '#10a37f', description: 'Everyday orchestrator', backend: 'cli', cliRuntime: 'codex', supportsThinking: true },
    { id: 'cli:codex:gpt-6-sol', label: 'GPT-6 Sol', provider: 'openai', color: '#10a37f', description: 'Previous Sol', backend: 'cli', cliRuntime: 'codex', supportsThinking: true },
    { id: 'cli:codex:gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai', color: '#10a37f', description: 'Fast model for easier tasks', backend: 'cli', cliRuntime: 'codex', supportsThinking: true },
    { id: 'cli:codex:gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'openai', color: '#10a37f', description: 'Flagship (Opus-class)', backend: 'cli', cliRuntime: 'codex', supportsThinking: true },
    { id: 'cli:codex:gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'openai', color: '#10a37f', description: 'Balanced (Sonnet-class)', backend: 'cli', cliRuntime: 'codex', supportsThinking: true },
    { id: 'cli:codex:gpt-5.6-luna', label: 'GPT-5.6 Luna', provider: 'openai', color: '#10a37f', description: 'Fast + cheap (Haiku-class)', backend: 'cli', cliRuntime: 'codex', supportsThinking: true },
    { id: 'cli:codex:gpt-5.5', label: 'GPT-5.5', provider: 'openai', color: '#10a37f', description: 'Prior flagship', backend: 'cli', cliRuntime: 'codex', supportsThinking: true },
    { id: 'cli:codex:o4-mini', label: 'o4-mini', provider: 'openai', color: '#10a37f', description: 'Fast reasoning', backend: 'cli', cliRuntime: 'codex', supportsThinking: true },
  ],
  opencode: [
    // Fallback: single row used when auth.json is missing or unparseable.
    // At runtime, LLMChatContainer replaces this with buildOpencodeModels() which
    // surfaces each authed provider as its own sub-row (issue #512).
    { id: 'cli:opencode:default', label: 'OpenCode (default)', provider: 'local', color: '#a855f7', description: '75+ providers', backend: 'cli', cliRuntime: 'opencode' },
  ],
};

/** Display label for each opencode provider id. Unmapped ids fall back to title-case. */
const OPENCODE_PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'GPT',
  google: 'Gemini',
  groq: 'Groq',
  mistral: 'Mistral',
  cohere: 'Cohere',
  xai: 'Grok',
  bedrock: 'AWS Bedrock',
  vertex: 'Vertex AI',
  azure: 'Azure OpenAI',
  perplexity: 'Perplexity',
  together: 'Together AI',
  fireworks: 'Fireworks',
  deepseek: 'DeepSeek',
  ollama: 'Ollama',
};

/**
 * Build the opencode sub-row list from a list of authed provider keys read from
 * ~/.local/share/opencode/auth.json.  Falls back to the single "OpenCode (default)"
 * entry when the list is empty or undefined.
 */
export function buildOpencodeModels(authedProviders?: string[]): ModelOption[] {
  if (!authedProviders || authedProviders.length === 0) {
    return CLI_RUNTIME_MODELS.opencode;
  }

  return authedProviders.map((providerId) => {
    const displayLabel = OPENCODE_PROVIDER_LABELS[providerId]
      ?? (providerId.charAt(0).toUpperCase() + providerId.slice(1));
    return {
      id: `cli:opencode:${providerId}`,
      label: `OpenCode \u00b7 ${displayLabel}`,
      provider: 'local' as ModelOption['provider'],
      color: '#a855f7',
      description: displayLabel,
      backend: 'cli' as ModelOption['backend'],
      cliRuntime: 'opencode' as ModelOption['cliRuntime'],
    };
  });
}

/** o8 Operator — branded, free, zero-setup default. Routes to Gemini Flash with OpenRouter free fallback. */
export const OPERATOR_MODEL: ModelOption = {
  id: 'o8-operator',
  label: 'o8 Operator',
  provider: 'operator',
  color: '#2563eb',
  description: 'Free • powered by o8',
  backend: 'api',
  supportsThinking: false,
};

/** API-backed models in the picker.
 *
 * v1: Operator only. Direct Anthropic / OpenAI / Google / xAI keys were dropped —
 * power users either install a CLI runtime (codex / claude-code / gemini / opencode)
 * or use the Operator (which already uses Gemini + OpenRouter under the hood).
 * Future: surface OpenRouter as a separate "direct routes" section.
 */
export const API_MODELS: ModelOption[] = [
  OPERATOR_MODEL,
];

/** Backward compat — streaming.ts uses this for fallback label resolution */
export const MODELS: ModelOption[] = API_MODELS;

export const THEME_ACCENT = 'var(--t-accent, #2563eb)';
export const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
export const THEME_ACCENT_SOFT_STRONG = 'var(--t-accent-soft-strong, rgba(37, 99, 235, 0.14))';
export const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(37, 99, 235, 0.22))';
export const THEME_ACCENT_RING = 'var(--t-accent-ring, rgba(37, 99, 235, 0.15))';
export const THEME_TEXT = 'var(--t-text)';
export const THEME_TEXT_SECONDARY = 'var(--t-text-secondary)';
export const THEME_TEXT_MUTED = 'var(--t-text-muted)';
export const THEME_TEXT_FAINT = 'var(--t-text-faint)';
export const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
export const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';
export const THEME_PANEL_BORDER = 'var(--t-panel-border)';
export const THEME_GLASS_ELEVATED = 'var(--t-glass-elevated, var(--t-panel-translucent))';
export const THEME_GLASS_MUTED = 'var(--t-glass-muted, var(--t-panel-translucent))';
export const THEME_GLASS_BORDER_STRONG = 'var(--t-glass-border-strong, var(--t-panel-border))';
export const THEME_GLASS_SHADOW = 'var(--t-glass-shadow, var(--t-panel-shadow))';
export const HISTORY_DELETED_EVENT = 'cortex-llm-history-deleted';
export const MISSION_DISMISSED_STORAGE_KEY = 'cortex-ftux-mission-dismissed';

export const SLASH_COMMANDS: SlashCommandOption[] = [
  { command: '/web', label: 'Search the web', description: 'Find current information online', icon: 'globe', prefix: 'Search the web for: ' },
  { command: '/code', label: 'Search codebase', description: 'Find functions, imports, patterns', icon: 'search', prefix: 'Search this codebase for: ' },
  { command: '/file', label: 'Read a file', description: 'Read and analyze a specific file', icon: 'file', prefix: 'Read and explain the file: ' },
  { command: '/think', label: 'Think step by step', description: 'Reason through a complex problem', icon: 'brain', prefix: 'Think step by step about this: ' },
  { command: '/review', label: 'Code review', description: 'Review code for bugs and improvements', icon: 'review', prefix: 'Review this code for bugs, improvements, and best practices: ' },
  { command: '/explain', label: 'Explain this', description: 'Break down complex code or concepts', icon: 'idea', prefix: 'Explain in detail: ' },
  { command: '/test', label: 'Write tests', description: 'Generate test cases', icon: 'test', prefix: 'Write comprehensive tests for: ' },
  { command: '/fix', label: 'Fix this', description: 'Debug and fix an issue', icon: 'fix', prefix: 'Debug and fix this issue: ' },
  { command: '/issue', label: 'Create issue', description: 'File a GitHub issue from chat context', icon: 'issue', prefix: 'Create a GitHub issue for: ' },
  { command: '/pr', label: 'Create PR', description: 'Open a pull request from current changes', icon: 'pr', prefix: 'Create a pull request with these changes: ' },
  { command: '/run', label: 'Run command', description: 'Execute a terminal command in the workspace', icon: 'terminal', prefix: 'Run this terminal command: ' },
];

export const PROMPT_ICONS = {
  tree: 'M160,112h48a16,16,0,0,0,16-16V48a16,16,0,0,0-16-16H160a16,16,0,0,0-16,16V64H128a24,24,0,0,0-24,24v32H72v-8A16,16,0,0,0,56,96H24A16,16,0,0,0,8,112v32a16,16,0,0,0,16,16H56a16,16,0,0,0,16-16v-8h32v32a24,24,0,0,0,24,24h16v16a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V160a16,16,0,0,0-16-16H160a16,16,0,0,0-16,16v16H128a8,8,0,0,1-8-8V88a8,8,0,0,1,8-8h16V96A16,16,0,0,0,160,112ZM56,144H24V112H56v32Zm104,16h48v48H160Zm0-112h48V96H160Z',
  search: 'M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z',
  file: 'M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z',
  diff: 'M112,152a8,8,0,0,0-8,8v28.69L66.34,151A8,8,0,0,1,64,145.37V95a32,32,0,1,0-16,0v50.38a23.85,23.85,0,0,0,7,17L92.69,200H64a8,8,0,0,0,0,16h48a8,8,0,0,0,8-8V160A8,8,0,0,0,112,152ZM40,64A16,16,0,1,1,56,80,16,16,0,0,1,40,64Zm168,97V110.63a23.85,23.85,0,0,0-7-17L163.31,56H192a8,8,0,0,0,0-16H144a8,8,0,0,0-8,8V96a8,8,0,0,0,16,0V67.31L189.66,105a8,8,0,0,1,2.34,5.66V161a32,32,0,1,0,16,0Zm-8,47a16,16,0,1,1,16-16A16,16,0,0,1,200,208Z',
  rocket: 'M152,224a8,8,0,0,1-8,8H112a8,8,0,0,1,0-16h32A8,8,0,0,1,152,224ZM128,112a12,12,0,1,0-12-12A12,12,0,0,0,128,112Zm95.62,43.83-12.36,55.63a16,16,0,0,1-25.51,9.11L158.51,200h-61L70.25,220.57a16,16,0,0,1-25.51-9.11L32.38,155.83a16.09,16.09,0,0,1,3.32-13.71l28.56-34.26a123.07,123.07,0,0,1,8.57-36.67c12.9-32.34,36-52.63,45.37-59.85a16,16,0,0,1,19.6,0c9.34,7.22,32.47,27.51,45.37,59.85a123.07,123.07,0,0,1,8.57,36.67l28.56,34.26A16.09,16.09,0,0,1,223.62,155.83ZM99.43,184h57.14c21.12-37.54,25.07-73.48,11.74-106.88C156.55,47.64,134.49,29,128,24c-6.51,5-28.57,23.64-40.33,53.12C74.36,110.52,78.31,146.46,99.43,184Zm-15,5.85Q68.28,160.5,64.83,132.16L48,152.36,60.36,208l.18-.13ZM208,152.36l-16.83-20.2q-3.42,28.28-19.56,57.69l23.85,18,.18.13Z',
} as const;

export const SUGGESTED_PROMPTS = [
  { iconKey: 'diff' as const, text: 'Review pending agent changes', description: 'Check diffs waiting for approval' },
  { iconKey: 'search' as const, text: 'What did agents ship today?', description: 'Summarize merged work and activity' },
  { iconKey: 'tree' as const, text: 'Audit today\'s token spend', description: 'Cost breakdown by agent and model' },
  { iconKey: 'rocket' as const, text: 'Dispatch a task', description: 'Route a scoped task to an agent' },
  { iconKey: 'file' as const, text: 'Review the most recent changes', description: 'Analyze recent commits for issues' },
  { iconKey: 'search' as const, text: 'What needs my attention?', description: 'Surface blockers, failures, and stale work' },
];

export function buildQueuedContextCard(injection: { id: string; text: string; reason?: string; previewImageDataUri?: string }): QueuedContextCard {
  const lines = injection.text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const header = lines[0]?.match(/^\[(.+)\]$/)?.[1] ?? lines[0] ?? 'Context';
  const meta = lines.slice(1).filter((line) => /^[A-Za-z][A-Za-z ]+:\s+/.test(line)).slice(0, 3);
  const firstBodyLine = lines.find((line) => !/^\[.+\]$/.test(line) && !/^[A-Za-z][A-Za-z ]+:\s+/.test(line));
  const preview = firstBodyLine && firstBodyLine !== header ? firstBodyLine : undefined;
  const title = injection.reason?.startsWith('pr-comment')
    ? (meta[0]?.startsWith('Author:') ? meta[0].replace(/^Author:\s*/, '') : 'PR comment')
    : injection.reason?.startsWith('ci-check')
      ? 'CI context'
      : injection.reason?.startsWith('deploy')
        ? 'Deploy context'
        : header;

  return { id: injection.id, reason: injection.reason, text: injection.text, title, meta, preview, previewImageDataUri: injection.previewImageDataUri };
}

export function buildConversationSummary(messages: LLMMessage[]) {
  const latestUser = [...messages].reverse().find((message) => (
    message.role === 'user'
    && message.content.trim()
    && !/^(hi|hey|hello)\b/i.test(message.content.trim())
  ));
  if (!latestUser) return null;
  const summary = latestUser.content.replace(/\s+/g, ' ').trim();
  if (!summary) return null;
  return summary.length <= 48 ? summary : `${summary.slice(0, 47)}...`;
}

export function fallbackRepoLabel(repo?: { name?: string; localPath?: string | null } | null) {
  const preferredName = repo?.name?.trim();
  if (preferredName) return preferredName;
  const preferredPath = repo?.localPath?.trim();
  if (!preferredPath) return 'your codebase';
  return preferredPath.split('/').filter(Boolean).pop() ?? 'your codebase';
}

export function describeRepoMission(name: string, issueCount: number, prCount: number) {
  if (issueCount > 0 && prCount > 0) {
    return `${name} has ${issueCount} open issue${issueCount === 1 ? '' : 's'} and ${prCount} pending PR${prCount === 1 ? '' : 's'}.`;
  }
  if (issueCount > 0) {
    return `${name} has ${issueCount} open issue${issueCount === 1 ? '' : 's'} ready for triage.`;
  }
  return `${name} has ${prCount} pending PR${prCount === 1 ? '' : 's'} waiting for review.`;
}

function lineCount(text?: string) {
  if (!text) return 0;
  return text.split('\n').length;
}

function basenameFromPath(filePath?: string) {
  if (!filePath) return 'file';
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

function deriveFileChangesFromPatch(patchText: string) {
  const changes: FileChangePreview[] = [];
  const fileBlocks = patchText.split(/\*\*\*\s+(Update|Add)\s+File:\s+/);

  for (let index = 1; index < fileBlocks.length; index += 2) {
    const operation = fileBlocks[index];
    const block = fileBlocks[index + 1];
    if (!block) continue;
    const lines = block.split('\n');
    const filePath = lines[0].trim();
    const shortFile = basenameFromPath(filePath);

    if (operation === 'Add') {
      const content = lines.slice(1).filter((line) => line.startsWith('+')).map((line) => line.slice(1)).join('\n');
      changes.push({
        id: `patch-${shortFile}-${changes.length}`,
        path: filePath,
        shortFile,
        tool: 'apply_patch',
        additions: lineCount(content),
        deletions: 0,
        content,
      });
      continue;
    }

    const oldLines: string[] = [];
    const newLines: string[] = [];
    let additions = 0;
    let deletions = 0;

    for (const line of lines.slice(1)) {
      if (line.startsWith('@@')) continue;
      if (line.startsWith('-')) {
        oldLines.push(line.slice(1));
        deletions += 1;
      } else if (line.startsWith('+')) {
        newLines.push(line.slice(1));
        additions += 1;
      } else if (line.startsWith(' ')) {
        oldLines.push(line.slice(1));
        newLines.push(line.slice(1));
      }
    }

    changes.push({
      id: `patch-${shortFile}-${changes.length}`,
      path: filePath,
      shortFile,
      tool: 'apply_patch',
      additions,
      deletions,
      oldText: oldLines.join('\n'),
      newText: newLines.join('\n'),
    });
  }

  return changes;
}

export function deriveFileChangesFromTools(toolCalls?: ToolCallInfo[]) {
  if (!toolCalls?.length) return [];
  const changes: FileChangePreview[] = [];

  for (const tool of toolCalls) {
    const args = tool.args ?? {};
    if (tool.name === 'apply_patch') {
      const patch = typeof args.input === 'string' ? args.input : typeof args.patch === 'string' ? args.patch : '';
      if (patch) {
        changes.push(...deriveFileChangesFromPatch(patch));
      }
      continue;
    }
    if (tool.name === 'Edit' || tool.name === 'edit_file') {
      const filePath = String(args.file_path ?? args.path ?? '');
      if (!filePath) continue;
      const oldText = typeof args.old_string === 'string' ? args.old_string : typeof args.oldText === 'string' ? args.oldText : undefined;
      const newText = typeof args.new_string === 'string' ? args.new_string : typeof args.newText === 'string' ? args.newText : undefined;
      changes.push({
        id: `${filePath}-${changes.length}`,
        path: filePath,
        shortFile: basenameFromPath(filePath),
        tool: 'Edit',
        additions: lineCount(newText),
        deletions: lineCount(oldText),
        oldText,
        newText,
      });
      continue;
    }
    if (tool.name === 'Write' || tool.name === 'write_file' || tool.name === 'NotebookEdit') {
      const filePath = String(args.file_path ?? args.path ?? '');
      const content = typeof args.content === 'string' ? args.content : '';
      if (!filePath) continue;
      changes.push({
        id: `${filePath}-${changes.length}`,
        path: filePath,
        shortFile: basenameFromPath(filePath),
        tool: tool.name === 'NotebookEdit' ? 'NotebookEdit' : 'Write',
        additions: lineCount(content),
        deletions: 0,
        content,
      });
      continue;
    }
    if (tool.name === 'MultiEdit') {
      const filePath = String(args.file_path ?? args.path ?? '');
      const edits = Array.isArray(args.edits) ? args.edits as Array<Record<string, unknown>> : [];
      if (!filePath || edits.length === 0) continue;
      edits.forEach((edit, index) => {
        const oldText = typeof edit.old_string === 'string' ? edit.old_string : undefined;
        const newText = typeof edit.new_string === 'string' ? edit.new_string : undefined;
        changes.push({
          id: `${filePath}-${index}-${changes.length}`,
          path: filePath,
          shortFile: basenameFromPath(filePath),
          tool: 'MultiEdit',
          additions: lineCount(newText),
          deletions: lineCount(oldText),
          oldText,
          newText,
        });
      });
    }
  }

  return changes;
}

export function buildRepoRequestHeaders(preferredRepo?: PreferredRepoContext | null): Record<string, string> {
  const repoPath = preferredRepo?.localPath?.trim();
  if (!repoPath) return {};
  return { 'x-cortex-repo-path': repoPath };
}
