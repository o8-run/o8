import type { WorkspaceCliModelOption } from '@/components/desktop/workspace-terminal/types';
import { MODEL_IDS } from '@/lib/models';

export const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[^[]/g;
export const LOCALHOST_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{3,5})\b[^\s)"]*/g;
export const ORCHESTRATED_TAB_AUTO_ARCHIVE_MS = 10 * 60_000;

export const CLI_AGENTS = [
  { id: 'shell', label: 'Terminal', color: '#64748b', command: null },
  { id: 'claude', label: 'Claude Code', color: '#e07a3a', command: 'claude' },
  { id: 'codex', label: 'Codex', color: '#6b7280', command: 'codex' },
  { id: 'opencode', label: 'OpenCode 2', color: '#fb923c', command: 'opencode2' },
  { id: 'gemini', label: 'Gemini CLI', color: '#4285f4', command: 'gemini' },
  {
    id: 'magnitude',
    label: 'Magnitude',
    color: '#0f9f8f',
    command: "if command -v magnitude >/dev/null 2>&1; then magnitude; else printf '\\nMagnitude is not installed. Install it with:\\n  npm i -g @magnitudedev/cli\\n\\n'; fi",
  },
] as const;

// Order matters: the first entry is the default for new Gemini packets/tabs
// AND the primary model in the auto-fallback cascade. Cascade walks the list
// top → bottom on quota / rate-limit errors. Gemini 3 Pro goes first because
// the 3.1-pro daily quota (250/day on free tier) fills up fast under heavy
// dispatch, and 3 Pro has a separate bucket.
export const GEMINI_CLI_MODELS: WorkspaceCliModelOption[] = [
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro', color: '#4285f4' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', color: '#4285f4' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', color: '#4285f4' },
  { id: 'gemini-pro-latest', label: 'Gemini Pro (latest)', color: '#4285f4' },
  { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite', color: '#8ab4f8' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', color: '#8ab4f8' },
];

/** Cascade order for the rate-limit auto-fallback. The gemini adapter walks
 * this list top → bottom when the current model returns a quota/rate-limit
 * error, emitting a runtime_fallback notification so the chat pane can pill
 * the transition. */
export const GEMINI_FALLBACK_CASCADE: ReadonlyArray<string> = [
  'gemini-3-pro-preview',
  'gemini-3.1-pro-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
];

export const CLAUDE_CLI_MODELS: WorkspaceCliModelOption[] = [
  // Every Claude surface keeps its own hand-written list, so a registry
  // addition has to be copied into each one and Opus 5 reached the composer
  // and Settings but never here (#1808). `model-picker-coverage.test.ts` pins
  // the three lists together until they are generated from the registry.
  { id: MODEL_IDS.raw.anthropicClaudeOpus55, label: 'Opus 5.5', color: '#8b5cf6' },
  { id: MODEL_IDS.raw.anthropicClaudeFable51, label: 'Fable 5.1', color: '#8b5cf6' },
  { id: MODEL_IDS.raw.anthropicClaudeOpus5, label: 'Opus 5', color: '#8b5cf6' },
  { id: MODEL_IDS.raw.anthropicClaudeOpus48, label: 'Opus 4.8 (1M)', color: '#8b5cf6' },
  { id: MODEL_IDS.raw.anthropicClaudeOpus47, label: 'Opus 4.7 (1M)', color: '#8b5cf6' },
  { id: MODEL_IDS.raw.anthropicClaudeSonnet55, label: 'Sonnet 5.5', color: '#8b5cf6' },
  { id: MODEL_IDS.raw.anthropicClaudeSonnet5, label: 'Sonnet 5', color: '#8b5cf6' },
  { id: MODEL_IDS.raw.anthropicClaudeHaiku55, label: 'Haiku 5.5', color: '#8b5cf6' },
  { id: MODEL_IDS.raw.anthropicClaudeHaiku45, label: 'Haiku 4.5', color: '#8b5cf6' },
];

export const CODEX_CLI_MODELS: WorkspaceCliModelOption[] = [
  { id: MODEL_IDS.raw.openAiGpt6Astra, label: 'GPT-6 Astra', color: '#10b981' },
  { id: MODEL_IDS.raw.openAiGpt61Sol, label: 'GPT-6.1 Sol', color: '#10b981' },
  { id: MODEL_IDS.raw.openAiGpt6Sol, label: 'GPT-6 Sol', color: '#10b981' },
  { id: MODEL_IDS.raw.openAiGpt6Luna, label: 'GPT-6 Luna', color: '#10b981' },
  { id: MODEL_IDS.raw.openAiGpt56Sol, label: 'GPT-5.6 Sol', color: '#10b981' },
  { id: MODEL_IDS.raw.openAiGpt56Terra, label: 'GPT-5.6 Terra', color: '#10b981' },
  { id: MODEL_IDS.raw.openAiGpt56Luna, label: 'GPT-5.6 Luna', color: '#10b981' },
  { id: MODEL_IDS.raw.openAiGpt55, label: 'GPT-5.5', color: '#10b981' },
  { id: 'gpt-4o', label: 'GPT-4o', color: '#10b981' },
];

const OPENCODE_MODEL_COLOR = '#fb923c';

const OPENCODE_PROVIDER_MAP: Record<string, { label: string; models: Array<{ id: string; label: string }> }> = {
  anthropic: {
    label: 'Anthropic',
    models: [
      { id: 'opencode/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { id: 'opencode/claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
  },
  openai: {
    label: 'OpenAI',
    models: [
      { id: 'opencode/gpt-4o', label: 'GPT-4o' },
      { id: 'opencode/o3', label: 'o3' },
    ],
  },
  google: {
    label: 'Google',
    models: [
      { id: 'opencode/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'opencode/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
  },
  xai: {
    label: 'xAI',
    models: [
      { id: 'opencode/grok-4.5', label: 'Grok 4.5' },
    ],
  },
};

const OPENCODE_FALLBACK: WorkspaceCliModelOption[] = [
  { id: 'opencode/default', label: 'OpenCode (default)', color: OPENCODE_MODEL_COLOR },
];

export function getOpenCodeModels(authedProviders: string[]): WorkspaceCliModelOption[] {
  if (authedProviders.length === 0) return OPENCODE_FALLBACK;

  const models: WorkspaceCliModelOption[] = [];
  for (const provider of authedProviders) {
    const info = OPENCODE_PROVIDER_MAP[provider.trim().toLowerCase()];
    if (!info) continue;
    for (const model of info.models) {
      models.push({
        id: model.id,
        label: model.label,
        color: OPENCODE_MODEL_COLOR,
      });
    }
  }

  return models.length > 0 ? models : OPENCODE_FALLBACK;
}

export const CLI_SUGGESTED_PROMPTS = [
  { icon: 'Idea', text: 'Summarize the current repo state', description: 'Quickly orient this CLI session to the local checkout' },
  { icon: 'Search', text: 'Find the files related to the current bug', description: 'Search the repo and point me to the likely change surface' },
  { icon: 'Test', text: 'Tell me what tests I should run next', description: 'Use the current branch and recent changes as context' },
  { icon: 'Notes', text: 'Explain what changed on this branch', description: 'Read the local diff and summarize the work in progress' },
];

export const THEME_ACCENT = 'var(--t-accent, #2563eb)';
export const THEME_ACCENT_SOFT = 'var(--t-accent-soft, rgba(37, 99, 235, 0.08))';
export const THEME_ACCENT_SOFT_STRONG = 'var(--t-accent-soft-strong, rgba(37, 99, 235, 0.14))';
export const THEME_ACCENT_BORDER = 'var(--t-accent-border, rgba(37, 99, 235, 0.22))';
export const THEME_ACCENT_RING = 'var(--t-accent-ring, rgba(37, 99, 235, 0.15))';
export const THEME_BG_CARD = 'var(--t-bg-card, rgba(148, 163, 184, 0.08))';
export const THEME_PANEL = 'var(--t-panel)';
export const THEME_PANEL_GLASS = 'var(--t-panel-translucent)';

export function readThemeColor(name: string, fallback: string) {
  if (typeof window === 'undefined') return fallback;
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Build the xterm.js theme object from live CSS tokens on the current document.
 *
 * xterm paints its own canvas and cannot inherit theme colors from CSS, so we
 * resolve the `--t-terminal-*` tokens here and hand xterm concrete strings.
 * Must be called client-side (reads window.getComputedStyle). Returns a fresh
 * object every call — pass it to `new Terminal({ theme })` or assign to
 * `term.options.theme` on theme change to live-update without recreating.
 *
 * Fallbacks are the midnight palette, so a missing token never paints white.
 */
export function buildXtermTheme() {
  return {
    background: readThemeColor('--t-terminal-bg', '#16191e'),
    foreground: readThemeColor('--t-terminal-fg', '#e8ecf2'),
    cursor: readThemeColor('--t-terminal-cursor', '#8fb4ff'),
    cursorAccent: readThemeColor('--t-terminal-cursor-accent', '#0f1216'),
    selectionBackground: readThemeColor('--t-terminal-selection-bg', 'rgba(143, 180, 255, 0.26)'),
    selectionForeground: readThemeColor('--t-terminal-selection-fg', '#ffffff'),
    black: readThemeColor('--t-terminal-ansi-black', '#16191e'),
    red: readThemeColor('--t-terminal-ansi-red', '#f87171'),
    green: readThemeColor('--t-terminal-ansi-green', '#86efac'),
    yellow: readThemeColor('--t-terminal-ansi-yellow', '#fcd34d'),
    blue: readThemeColor('--t-terminal-ansi-blue', '#93c5fd'),
    magenta: readThemeColor('--t-terminal-ansi-magenta', '#c4b5fd'),
    cyan: readThemeColor('--t-terminal-ansi-cyan', '#67e8f9'),
    white: readThemeColor('--t-terminal-ansi-white', '#d8dfe7'),
    brightBlack: readThemeColor('--t-terminal-ansi-bright-black', '#5f6b7a'),
    brightRed: readThemeColor('--t-terminal-ansi-bright-red', '#fca5a5'),
    brightGreen: readThemeColor('--t-terminal-ansi-bright-green', '#bbf7d0'),
    brightYellow: readThemeColor('--t-terminal-ansi-bright-yellow', '#fde68a'),
    brightBlue: readThemeColor('--t-terminal-ansi-bright-blue', '#bfdbfe'),
    brightMagenta: readThemeColor('--t-terminal-ansi-bright-magenta', '#ddd6fe'),
    brightCyan: readThemeColor('--t-terminal-ansi-bright-cyan', '#a5f3fc'),
    brightWhite: readThemeColor('--t-terminal-ansi-bright-white', '#f8fafc'),
  };
}
