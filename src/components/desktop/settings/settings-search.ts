/**
 * settings-search — static registry + matcher behind the Settings nav search.
 *
 * The registry is hand-authored from the rendered rows of every settings tab
 * (Cursor-parity pass, 2026-07-13). It deliberately duplicates row labels
 * rather than importing tab internals: search must stay cheap to render and
 * must never mount a tab to know what's inside it. When a tab gains or loses
 * a row, update its entries here — the nav search is the only consumer.
 */

import type { SettingsTab } from './shared';

export type SettingsSearchEntry = {
  tab: SettingsTab;
  tabLabel: string;
  /** GroupHeader the row sits under; omitted for tab-level matches. */
  group?: string;
  label: string;
  description?: string;
  /** Extra match terms beyond label/group/description. */
  keywords?: string[];
};

export type SettingsSearchMatch = SettingsSearchEntry & { score: number };

const MAX_RESULTS = 14;

export function searchSettings(
  registry: SettingsSearchEntry[],
  rawQuery: string,
): SettingsSearchMatch[] {
  const query = rawQuery.trim().toLowerCase();
  if (query.length < 2) return [];
  const tokens = query.split(/\s+/).filter(Boolean);
  const matches: SettingsSearchMatch[] = [];
  for (const entry of registry) {
    const label = entry.label.toLowerCase();
    const group = entry.group?.toLowerCase() ?? '';
    const description = entry.description?.toLowerCase() ?? '';
    const tabLabel = entry.tabLabel.toLowerCase();
    const keywords = (entry.keywords ?? []).join(' ').toLowerCase();
    let score = 0;
    let allTokensHit = true;
    for (const token of tokens) {
      if (label.startsWith(token)) score += 6;
      else if (label.includes(token)) score += 4;
      else if (group.includes(token) || tabLabel.includes(token)) score += 3;
      else if (keywords.includes(token)) score += 2;
      else if (description.includes(token)) score += 1;
      else { allTokensHit = false; break; }
    }
    if (!allTokensHit || score === 0) continue;
    matches.push({ ...entry, score });
  }
  matches.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return matches.slice(0, MAX_RESULTS);
}

/** Registry population is generated from the tab inventory — see module doc. */
export const SETTINGS_SEARCH_REGISTRY: SettingsSearchEntry[] = [
  { tab: 'models', tabLabel: 'Providers', group: 'ChatGPT / Codex account usage', label: 'ChatGPT account usage', description: 'Reported Codex account limits, reset times, and observation freshness', keywords: ['quota', 'weekly', 'five hour', 'subscription'] },
  { tab: 'models', tabLabel: 'Providers', group: 'Cursor account usage', label: 'Cursor account usage', description: 'Account usage availability and the provider dashboard', keywords: ['quota', 'limit', 'subscription'] },
  { tab: 'models', tabLabel: 'Providers', group: 'ChatGPT plan', label: 'ChatGPT plan connection', description: 'Connect or manage the ChatGPT plan used by supported app requests', keywords: ['account', 'subscription', 'login'] },
  { tab: 'models', tabLabel: 'Providers', group: 'Local ACP', label: 'Local ACP launch settings', description: 'Command, arguments, and explicit OpenRouter key forwarding for a local agent', keywords: ['environment', 'runtime'] },
  { tab: 'account', tabLabel: 'Account', group: 'Profile', label: 'Manage account', description: 'Your o8 profile and sign-in', keywords: ['identity', 'email', 'login', 'sign in', 'sign out'] },
  { tab: 'models', tabLabel: 'Providers', group: 'Advanced orchestrator options', label: 'OpenCode fallback model', description: 'Used only when a request supplies no model; composer choices take precedence', keywords: ['opencode', 'orchestrator', 'default'] },
  { tab: 'worktrees', tabLabel: 'Worktrees & storage', group: 'Storage usage', label: 'Space for new tasks', description: 'Free disk space, task reservations, and space available after minimum free space is kept', keywords: ['headroom', 'reserved', 'capacity'] },
  { tab: 'worktrees', tabLabel: 'Worktrees & storage', group: 'Storage usage', label: 'Workspace files', description: 'Disk space used and total file size across repositories', keywords: ['usage', 'allocated', 'logical'] },
  { tab: 'worktrees', tabLabel: 'Worktrees & storage', group: 'Workspace parking', label: 'Parking mode', description: 'Temporarily reclaim eligible workspaces while preserving restoration information' },
  { tab: 'worktrees', tabLabel: 'Worktrees & storage', group: 'Minimum free space', label: 'Volume reserve', description: 'Percentage of disk capacity to keep available' },
  { tab: 'worktrees', tabLabel: 'Worktrees & storage', group: 'Minimum free space', label: 'Absolute floor', description: 'Minimum free disk space before starting tasks' },
  { tab: 'worktrees', tabLabel: 'Worktrees & storage', group: 'Storage categories', label: 'Storage breakdown', description: 'Source, dependencies, build files, runtime files, and transcripts' },
  { tab: 'models', tabLabel: 'Providers', group: 'Advanced worker setup', label: 'Codex launch method', description: 'Start the tool directly or use the optional Ori launcher', keywords: ['execution carrier', 'ori', 'direct'] },
  { tab: 'git-prs', tabLabel: 'Git & PRs', group: "GitHub", label: "Identity", description: "Connect GitHub, manage the account, or sign out", keywords: ['sign in', 'sign out', 'login', 'identity', 'profile', 'github'] },
  { tab: 'general', tabLabel: 'General', group: "Privacy", label: "Share usage data", description: "Allowlisted product events; optional and off by default", keywords: ['telemetry', 'usage', 'analytics', 'privacy'] },
  { tab: 'general', tabLabel: 'General', group: "Startup", label: "Launch at login", description: "Start o8 automatically when you sign in to your Mac", keywords: ['autostart', 'boot', 'startup'] },
  { tab: 'general', tabLabel: 'General', group: "Privacy", label: "Share crash reports", description: "Optionally send scrubbed error messages, stack traces, and user-initiated bug reports", keywords: ['telemetry', 'sentry', 'privacy', 'bug reports'] },
  { tab: 'general', tabLabel: 'General', group: "Privacy", label: "Automatically upload local crash logs", description: "Periodically upload saved crash logs when a destination is configured", keywords: ['telemetry', 'privacy'] },
  { tab: 'general', tabLabel: 'General', group: "Presentation", label: "Quiet mode", description: "Suppress overlays, coach cards, non-critical pills and toasts during a screen share or recording", keywords: ['quiet', 'presentation', 'demo', 'screen share', 'recording', 'overlay', 'do not disturb'] },
  { tab: 'general', tabLabel: 'General', group: "Presentation", label: "Review notifications", description: "Desktop notification when a packet is ready for review", keywords: ['notification', 'banner', 'review', 'notify', 'alert'] },
  { tab: 'git-prs', tabLabel: 'Git & PRs', group: "Branches", label: "Branch prefix", description: "Prefix for branches agents create from issues", keywords: ['git', 'worktree', 'branch', 'naming'] },
  { tab: 'git-prs', tabLabel: 'Git & PRs', group: "Attribution", label: "Tag commits created by agents", description: "Append a Co-Authored-By trailer to agent commits", keywords: ['git', 'commit', 'attribution', 'co-authored'] },
  { tab: 'git-prs', tabLabel: 'Git & PRs', group: "Pull requests", label: "PR link destination", description: "Open pull request links inside o8 or in your browser", keywords: ['git', 'github', 'pull request', 'browser'] },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: 'Task spending limits', label: 'Task spending limits', description: 'Spending per metered task and backup input-token limit', keywords: ['cost', 'cap', 'budget', 'metered', 'packet'] },
  { tab: 'models', tabLabel: 'Providers', group: "Codex connection", label: "Connections", description: "Per-runtime detection, enable toggles, and worker effort", keywords: ['codex', 'claude', 'gemini', 'opencode', 'cursor', 'grok', 'runtime', 'effort'] },
  { tab: 'models', tabLabel: 'Providers', group: "Claude fallback model", label: "Claude fallback model", description: "Fallback model for requests without a model selection", keywords: ['opus', 'sonnet', 'orchestrator'] },
  { tab: 'api-keys', tabLabel: 'Providers', group: "Provider keys", label: "API keys", description: "Bring your own provider keys", keywords: ['byok', 'anthropic', 'openai', 'openrouter', 'gemini', 'key'] },
  { tab: 'api-keys', tabLabel: 'Providers', group: 'Symon & voice keys', label: 'Symon & voice keys', description: 'Manage desktop voice service keys', keywords: ['elevenlabs', 'groq', 'gemini', 'google cloud', 'tts', 'openrouter', 'voice'] },
  { tab: 'local-models', tabLabel: 'Providers', group: "Local models", label: "Local models", description: "Ollama endpoint for Brain and dictation polish", keywords: ['ollama', 'local', 'offline'] },
  { tab: 'worktrees', tabLabel: 'Worktrees & storage', group: "Automatic cleanup", label: "Workspace count per repository", description: "How many inactive task workspaces to keep before automatic cleanup", keywords: ['worktree', 'retention', 'disk', 'workspace', 'cleanup', 'max worktrees'] },
  { tab: 'worktrees', tabLabel: 'Worktrees & storage', group: "Automatic cleanup", label: "Disk usage per repository", description: "Disk space for inactive task workspaces before automatic cleanup", keywords: ['worktree', 'disk', 'size', 'storage', 'max total size'] },
  { tab: 'indexing', tabLabel: 'Indexing', group: "Repositories", label: "Repository index", description: "Per-repo index status with a Reindex action", keywords: ['index', 'reindex', 'codebase', 'cortex', 'search'] },
  { tab: 'indexing', tabLabel: 'Indexing', group: "Engineering Brain", label: "Brain knowledge", description: "Directives and ledger outcomes the Brain cites", keywords: ['brain', 'memory', 'directives', 'cortex'] },
  { tab: 'about', tabLabel: 'About', group: "Developer", label: "Preview onboarding", description: "Runs the flow without resetting state (dev builds only)" },
  { tab: 'about', tabLabel: 'About', group: "Developer", label: "Reset + run onboarding", description: "Clears setup state and restarts the flow (dev builds only)" },
  { tab: 'about', tabLabel: 'About', group: "Links", label: "Documentation", description: "Architecture, workflows, and guides" },
  { tab: 'about', tabLabel: 'About', group: "Links", label: "GitHub", description: "o8-run/o8" },
  { tab: 'about', tabLabel: 'About', group: "Links", label: "Releases", description: "Changelog and downloads" },
  { tab: 'about', tabLabel: 'About', group: "Onboarding", label: "Replay onboarding", description: "Replays the welcome flow (intro, repos, runtimes)" },
  { tab: 'appearance', tabLabel: 'Appearance', group: "Theme", label: "Workspace theme", description: "Light Solid, Dark Solid, or All Glass", keywords: ['window chrome', 'palette', 'transparency'] },
  { tab: 'appearance', tabLabel: 'Appearance', group: "Theme", label: "All Glass", description: "Glass across the entire window" },
  { tab: 'connections', tabLabel: 'Mobile', group: "Paired devices", label: "Refresh" },
  { tab: 'connections', tabLabel: 'Mobile', group: "Remote access", label: "Connect this Mac", description: "Keep an authenticated outbound connection to the o8 relay", keywords: ['connect', 'relay', 'remote', 'web', 'machine'] },
  { tab: 'connections', tabLabel: 'Mobile', group: "Symon Messages", label: "Text Symon", description: "Managed number, durable history, and CLI-backed replies", keywords: ['messages', 'text', 'sms', 'symon', 'cli', 'phone'] },
  { tab: 'connections', tabLabel: 'Mobile', group: "Pairing", label: "Show pairing QR", description: "button dispatching the mobile pairing QR fullscreen view" },
  { tab: 'git-prs', tabLabel: 'Git & PRs', group: "GitHub", label: "Repository & CLI access", description: "Connect GitHub through device flow or an access token" },
  { tab: 'git-prs', tabLabel: 'Git & PRs', group: "GitHub", label: "Automation app", description: "Install or manage the o8 GitHub App" },
  { tab: 'diagnostics', tabLabel: 'Diagnostics', group: "Reset app data", label: "Factory reset", description: "Wipes ~/.o8 \u2014 sessions, keys, mission state, watched repos; opens confirm modal" },
  { tab: 'diagnostics', tabLabel: 'Diagnostics', group: "Demo sequence", label: "Run demo sequence", description: "After explicit diagnostic authorization, button drives live webview dashboard \u2192 Orchestrator tab \u2192 quick action, read-only" },
  { tab: 'diagnostics', tabLabel: 'Diagnostics', group: "Loop status", label: "Recent merges", description: "Disclosure toggle expanding the last 5 merge commits (interactive only when commits exist)" },
  { tab: 'diagnostics', tabLabel: 'Diagnostics', group: "Shipped feature audit", label: "Default-off feature flags", description: "Scheduled release-age check for features that remain dark", keywords: ['flags', 'experimental', 'promotion', 'release age', 'audit'] },
  { tab: 'diagnostics', tabLabel: 'Diagnostics', group: "Maintenance", label: "Archive old Codex sessions", description: "Archive sessions older than 14 days" },
  { tab: 'diagnostics', tabLabel: 'Diagnostics', group: "Connection health", label: "Check installed tools", description: "Last checked <time> / Not yet checked; Check again refreshes tool detection" },
  { tab: 'mcp', tabLabel: 'MCP', group: "Clients", label: "Claude Code", description: "dynamic connect status: Connected / Ready to connect / Not connected (Install, Update, Remove)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "Clients", label: "Claude Desktop", description: "dynamic connect status: Connected / Ready to connect / Not connected (Install, Update, Remove)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "Clients", label: "Hermes Agent", description: "dynamic status: CLI not found / Ready to connect / Connected (Install, Remove)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "Clients", label: "OpenClaw", description: "dynamic status: CLI not found / Ready to connect / Connected (Install, Remove)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "Diagnostics", label: "Manual config", description: "Prefer to edit the file yourself? (disclosure with copy config button)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "Diagnostics", label: "System details", description: "Show the runtime environment o8 is using. (disclosure)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "External servers", label: "Enabled/Disabled", description: "SettingsToggleButton for new server enabled state" },
  { tab: 'mcp', tabLabel: 'MCP', group: "External servers", label: "Manual setup", description: "disclosure toggle opening the field-by-field add-server form" },
  { tab: 'mcp', tabLabel: 'MCP', group: "External servers", label: "add a server", description: "smart-add textarea: paste a config JSON, an npx command line, or a server URL" },
  { tab: 'mcp', tabLabel: 'MCP', group: "External servers", label: "add server", description: "submit button for manual add form" },
  { tab: 'mcp', tabLabel: 'MCP', group: "External servers", label: "args json array", description: "textarea, stdio transport only (manual form)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "External servers", label: "command / endpoint url", description: "text input (npx command or https endpoint, manual form)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "External servers", label: "env json object", description: "textarea, stdio transport only (manual form)" },
  { tab: 'mcp', tabLabel: 'MCP', group: "External servers", label: "transport", description: "stdio / http toggle pills (manual form)" },
  { tab: 'models', tabLabel: 'Providers', group: "Brain advanced", label: "Brain uses Claude CLI", description: "Warm claude CLI answers (~2.7s Haiku), sub-billed" },
  { tab: 'models', tabLabel: 'Providers', group: "Runtime routing", label: "Orchestrate", description: "Configured and effective backend, runtime, model, source, readiness, and fallbacks" },
  { tab: 'models', tabLabel: 'Providers', group: "Runtime routing", label: "Build", description: "Configured and effective worker runtime, model, source, readiness, and fallbacks" },
  { tab: 'models', tabLabel: 'Providers', group: "Runtime routing", label: "Review", description: "Configured reviewer and the effective backend when Follow is selected" },
  { tab: 'models', tabLabel: 'Providers', group: "Runtime routing", label: "Brain", description: "Configured composer and the effective request-time inference cascade" },
  { tab: 'models', tabLabel: 'Providers', group: "Runtime routing", label: "Triage", description: "Configured and effective intake runtime, model, effort, and readiness" },
  { tab: 'models', tabLabel: 'Providers', group: "Runtime routing", label: "Recovery", description: "The persisted worker route reused when a packet resumes or recovers" },
  { tab: 'models', tabLabel: 'Providers', group: "Engineering Brain", label: "Codex model", description: "Codex subscription model used for Brain classification and cited answers" },
  { tab: 'models', tabLabel: 'Providers', group: "Engineering Brain", label: "Codex effort", description: "Reasoning effort used only by Engineering Brain calls" },
  { tab: 'models', tabLabel: 'Providers', group: "Claude Code connection", label: "Model source", description: "Choose the model source for Claude Code orchestrators and workers", keywords: ['orchestrator', 'worker', 'harness', 'gateway', 'codex', 'deepseek', 'grok'] },
  { tab: 'models', tabLabel: 'Providers', group: "Advanced orchestrator options", label: "Combined answer provider", description: "Who synthesizes when the Collide backend runs" },
  { tab: 'models', tabLabel: 'Providers', group: "Advanced orchestrator options", label: "Existing setup uses Claude", description: "What backend Auto follows: on = Claude REPL, off = Codex" },
  { tab: 'models', tabLabel: 'Providers', group: "Brain advanced", label: "Brain answer model", description: "Model used to write repository answers" },
  { tab: 'models', tabLabel: 'Providers', group: "Brain advanced", label: "Workers use the Brain", description: "Teach dispatched workers o8 ask for cited repo answers" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Task limits & setup", label: "Workspace manifest execution", description: "Gate checked-in setup commands before packet launch", keywords: ['manifest', 'approval', 'setup', 'workspace'] },
  { tab: 'models', tabLabel: 'Providers', group: "Claude Code connection", label: "Claude worker effort", description: "Fallback effort for spawned Claude Code workers" },
  { tab: 'models', tabLabel: 'Providers', group: "Codex connection", label: "Codex worker effort", description: "Fallback effort for spawned Codex workers" },
  { tab: 'models', tabLabel: 'Providers', group: "Workers", label: "Default worker", description: "Codex by default \u2014 pick any installed dispatchable runtime to override (may be profile-pinned)" },
  { tab: 'models', tabLabel: 'Providers', group: "Workers", label: "Subscription profile", description: "Use both houses by default \u00b7 Codex/Claude auth status \u00b7 optional profile hint" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Experimental", label: "o8 next", description: "", keywords: ['native', 'GPUI'] },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Experimental", label: "Canvas mode", description: "The glass canvas, a voice-first fleet surface." },
  { tab: 'models', tabLabel: 'Providers', group: "Antigravity connection", label: "Antigravity", description: "Google account connection for agent tasks", keywords: ['google', 'gemini', 'agy'] },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Experimental", label: "Native browser-view", description: "Host-owned native window for the Browser pane (macOS)" },
  { tab: 'models', tabLabel: 'Providers', group: "OpenCode 2 connection", label: "OpenCode 2 runtime", description: "Show OpenCode 2 in dispatch pickers" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: 'Fleet', label: 'Reuse dependencies (APFS)', description: 'Reuse eligible npm dependencies on compatible Macs; otherwise install normally' },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Fleet", label: "Concurrent agents", description: "Maximum agent tasks running at once" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Fleet", label: "Overlapping work", description: "Strict waits for overlapping active tasks; Advisory allows parallel work" },
  { tab: 'local-models', tabLabel: 'Providers', group: "Local models", label: "Chat model", description: "Local chat model for Brain compose/classify and dictation polish. Needs the e..." },
  { tab: 'local-models', tabLabel: 'Providers', group: "Local models", label: "Dispatch model", description: "Workers, orchestrator, and Brain answers run on this model; ollama:/lmstudio:..." },
  { tab: 'local-models', tabLabel: 'Providers', group: "Local models", label: "Embedding model", description: "Local embedding model for the Brain (e.g. nomic-embed-text). Needs the endpoi..." },
  { tab: 'local-models', tabLabel: 'Providers', group: "Local models", label: "Local endpoint", description: "OpenAI-compatible base URL for local Brain embedding and chat calls. No trail..." },
  { tab: 'models', tabLabel: 'Providers', group: "Thinking & task models", label: "Adaptive orchestrator thinking", description: "New turns default to adaptive and can stream summarized reasoning" },
  { tab: 'models', tabLabel: 'Providers', group: "Thinking & task models", label: "Prompt caching", description: "Mark the Anthropic system prompt with cache_control" },
  { tab: 'models', tabLabel: 'Providers', group: "Thinking & task models", label: "Targeting \u2014 action tier", description: "Premium tier: the Dispatch button + hard-file routing" },
  { tab: 'models', tabLabel: 'Providers', group: "Thinking & task models", label: "Targeting \u2014 triage tier", description: "Cheap tier: repo triage, rationales, trivial files" },
  { tab: 'models', tabLabel: 'Providers', group: "Thinking & task models", label: "Thinking effort", description: "Default effort for orchestrator turns" },
  { tab: 'models', tabLabel: 'Providers', group: "Orchestrator", label: "Lead provider", description: "Choose the orchestrator that leads conversations and coordinates workers", keywords: ['chat provider', 'lead'] },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Change reports", label: "Create a summary after merge", description: "Share what changed, why, and how it was checked" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Change reports", label: "Explain completed changes", description: "Create an optional AI report explaining completed changes" },
  { tab: 'models', tabLabel: 'Providers', group: "Orchestrator", label: "Code review provider", description: "Choose who reviews completed changes, or use the same provider as the lead" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: 'Supervision', label: 'Automatically review completed work', description: 'Review assigned tasks, request fixes, or merge approved changes' },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: 'Supervision', label: 'Merge approval', description: 'Always, Task owner, After review, or Never: choose when merges need approval' },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Supervision", label: "Install app updates automatically", description: "Install and restart when agents, terminals, and background jobs are idle" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Supervision", label: "Investigate failures in chat", description: "Start an AI investigation when a task needs help" },
  { tab: 'operator-defaults', tabLabel: 'Dispatch', group: "Supervision", label: "Automatically fix failed checks", description: "Try one focused AI repair with a five-minute limit" },
  { tab: 'projects', tabLabel: 'Projects', label: "Add files", description: "Card row, disabled, value Soon" },
  { tab: 'projects', tabLabel: 'Projects', label: "Delete", description: "Project card action; opens inline Confirm/Cancel strip" },
  { tab: 'projects', tabLabel: 'Projects', label: "Edit", description: "Project card action; opens embedded edit form" },
  { tab: 'projects', tabLabel: 'Projects', label: "Group / Dismiss", description: "Org auto-suggest strip actions (OrgSuggestionStrip)" },
  { tab: 'projects', tabLabel: 'Projects', label: "Instructions (card)", description: "None yet \u2014 add standing guidance for agents" },
  { tab: 'projects', tabLabel: 'Projects', label: "Locks", description: "Card row: active/stale lock count; expands lock list + Archive" },
  { tab: 'projects', tabLabel: 'Projects', label: "New project", description: "Header action; opens the inline create form" },
  { tab: 'projects', tabLabel: 'Projects', label: "Preview brief / Hide brief", description: "Project card action; loads the task brief" },
  { tab: 'voice', tabLabel: 'Voice', group: 'Voice shortcuts', label: 'Voice shortcuts', description: 'Fn dictation, Right Option requests, Right Command realtime voice, Escape to cancel, and external keyboard controls.', keywords: ['hotkeys', 'keyboard', 'hands-free', 'quick tips'] },
  { tab: 'voice', tabLabel: 'Voice', group: 'Symon', label: 'Open Symon settings', description: 'Open a separate window for dictation history, writing polish, custom words and snippets, memory, appearance, and voice customization.', keywords: ['dictionary', 'persona', 'customization', 'history'] },
  { tab: 'voice', tabLabel: 'Voice', group: 'Symon text brain', label: 'Text brain', description: 'Automatic, o8 managed, or Connected planner for new Symon text turns.', keywords: ['symon', 'managed', 'planner', 'brain'] },
  { tab: 'voice', tabLabel: 'Voice', group: 'Symon conversations', label: 'Browse saved conversations', description: 'Read durable Symon history from Messages, phone, voice, and the app without starting a model turn.', keywords: ['symon', 'history', 'transcript', 'conversations', 'messages'] },
  { tab: 'connections', tabLabel: 'Mobile', group: 'Native Messages receiver', label: 'Authorized senders', description: 'Authorize phone numbers and emails for the native macOS Messages receiver. Off by default; enabling disables the existing iMessage bridge.', keywords: ['symon', 'imessage', 'receiver', 'macos', 'permission'] },
  { tab: 'voice', tabLabel: 'Voice', group: "Dictation", label: "Mic input", description: "How the mic button next to Send behaves (Tap/Hold)" },
  { tab: 'voice', tabLabel: 'Voice', group: "Dictation", label: "On-screen partials bar", description: "Show the live transcript in a bar at the bottom while you hold Fn" },
  { tab: 'voice', tabLabel: 'Voice', group: "Permissions", label: "Accessibility", description: "Lets o8 see the focused window so dictation lands in the right app" },
  { tab: 'voice', tabLabel: 'Voice', group: "Permissions", label: "Fn key binding", description: "Press globe key to in Keyboard Settings \u2014 change only if Fn dictation misfires" },
  { tab: 'voice', tabLabel: 'Voice', group: "Permissions", label: "Input Monitoring", description: "Required for the Fn key to receive events \u2014 stricter than Accessibility" },
  { tab: 'voice', tabLabel: 'Voice', group: "Transcription", label: "Groq API key", description: "Cloud transcription using your Groq account (password input + Save/Remove)" },
  { tab: 'voice', tabLabel: 'Voice', group: 'Proactive attention', label: 'Automatic AI commentary', description: 'Generate periodic activity summaries using your model allowance. Turning this off keeps messages and approvals available.', keywords: ['broadcast', 'background', 'usage', 'summary', 'summaries', 'narration'] },
  { tab: 'voice', tabLabel: 'Voice', group: "Proactive attention", label: "Spoken updates", description: 'Read commentary and subscribed work updates aloud. Does not turn AI commentary generation on or off.', keywords: ['proactive', 'interrupt', 'notification', 'broadcast'] },
  { tab: 'voice', tabLabel: 'Voice', group: "Proactive attention", label: "Quiet hours", description: "Silence automatic Symon callouts during a local-time window", keywords: ['sleep', 'do not disturb', 'schedule'] },
  { tab: 'voice', tabLabel: 'Voice', group: "Proactive attention", label: "Hourly budget", description: "Cap automatic spoken and commentary updates in a rolling hour", keywords: ['limit', 'interrupt', 'rate'] },
  { tab: 'voice', tabLabel: 'Voice', group: "Proactive attention", label: "Calendar events", description: "Call out upcoming timed events with a configurable lead time", keywords: ['symon', 'calendar', 'event', 'proactive', 'lead time'] },
  { tab: 'voice', tabLabel: 'Voice', group: "Voice brain", label: "Escalation", description: "When to hand a request to the deeper brain (Off/Auto/Deep)" },
  { tab: 'voice', tabLabel: 'Voice', group: 'Voice brain', label: 'Model', description: 'Choose a supported background model or use the Automatic preset.', keywords: ['model pin', 'selector', 'provider', 'worker', 'builder'] },
  { tab: 'permissions', tabLabel: 'Permissions', group: "macOS permissions", label: "Microphone", description: "Grant mic access for dictation and Symon", keywords: ['permission', 'mic', 'tcc', 'privacy', 'grant', 'allow'] },
  { tab: 'permissions', tabLabel: 'Permissions', group: "macOS permissions", label: "Accessibility", description: "Lets o8 see the focused window so dictation lands in the right app", keywords: ['permission', 'tcc', 'privacy', 'grant', 'allow'] },
  { tab: 'permissions', tabLabel: 'Permissions', group: "macOS permissions", label: "Input Monitoring", description: "Required for the global Fn hotkey to receive key events", keywords: ['permission', 'tcc', 'privacy', 'grant', 'allow', 'fn', 'hotkey'] },
  { tab: 'permissions', tabLabel: 'Permissions', group: "macOS permissions", label: "Screen Recording", description: "Powers Symon's screen sight — reading what's on screen to point and guide", keywords: ['permission', 'tcc', 'privacy', 'grant', 'allow', 'capture'] },
];
