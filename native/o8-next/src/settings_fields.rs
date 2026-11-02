//! Desktop row vocabulary and existing operator-defaults field names.
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};

// Several windows can share a backend; independent backends keep separate
// invalidations (including the production-path fixture hosts in native tests).
static BOT_RAIL_REVISIONS: LazyLock<Mutex<HashMap<String, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
fn backend_key(client: &crate::client::Client) -> String {
    client
        .url("/")
        .map(|url| url.to_string())
        .unwrap_or_default()
}
pub(crate) fn bot_rail_revision(client: &crate::client::Client) -> u64 {
    *BOT_RAIL_REVISIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&backend_key(client))
        .unwrap_or(&0)
}
pub(crate) fn bot_rail_changed(client: &crate::client::Client) {
    *BOT_RAIL_REVISIONS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(backend_key(client))
        .or_default() += 1;
}

#[derive(Clone, Copy)]
pub enum Kind {
    Toggle,
    ReadOnly,
    WordToggle(&'static str),
    Time,
    TierEffort,
    Choice(&'static [(&'static str, &'static str)]),
    Number(f64, &'static str),
    Text,
    Bots,
}
pub struct Field {
    pub id: &'static str,
    pub label: &'static str,
    pub section: &'static str,
    pub detail: &'static str,
    pub kind: Kind,
}
impl Field {
    pub fn search_score(&self, query: &str) -> Option<u32> {
        let label = self.label.to_lowercase();
        let group =
            format!("{} {} {}", self.section, self.group(), self.section_label()).to_lowercase();
        let id = self.id.to_lowercase();
        let detail = self.detail.to_lowercase();
        let mut score = 0;
        for word in query.split_whitespace() {
            score += if label.starts_with(word) {
                6
            } else if label.contains(word) {
                4
            } else if group.contains(word) {
                3
            } else if id.contains(word) {
                2
            } else if detail.contains(word) {
                1
            } else {
                return None;
            };
        }
        Some(score)
    }
    pub fn section_label(&self) -> &'static str {
        SECTIONS
            .iter()
            .find(|(id, _)| *id == self.section)
            .map(|(_, label)| *label)
            .unwrap_or(self.section)
    }
    pub fn group(&self) -> &'static str {
        match self.id {
            "autoTitleInferenceEnabled" | "autoSettleEnabled" | "autoSettleIdleDays" => {
                "Conversations"
            }
            "presentationQuietMode" | "notificationsReviewReady" => "Presentation",
            "productTelemetryEnabled" | "crashReportsEnabled" | "telemetryOptIn" => "Privacy",
            "parallelCap" | "overlapGate" => "Fleet",
            "healBotEnabled"
            | "supervisorAutoEscalate"
            | "reviewContinuation"
            | "requireApproval"
            | "updateAutoApply" => "Supervision",
            "packetExplainerEnabled" | "buyinDocEnabled" => "Change reports",
            "meteredPacketCostCapUsd" | "meteredPacketInputTokenCap" => "Task spending limits",
            "brainRoutingMode" | "brainCodexModel" | "brainCodexEffort" => "Engineering Brain",
            "codexAppThreads" => "Codex app",
            "subscriptionProfile" | "defaultDispatchRuntime" | "workerRuntimes" => "Workers",
            "targetingTriage" | "targetingAction" => "Thinking & task models",
            "reviewerBackend" => "Orchestrator",
            "codexWorkerEffort" => "Codex models",
            "claudeWorkerEffort" | "orchestratorModel" => "Claude models",
            "collideAggregator" | "inAppOrchestratorEnabled" => "Advanced orchestrator options",
            "crossHouseWorkerFallback" => "Advanced worker setup",
            "experimentalOpencode" => "OpenCode models",
            "localChatModel" | "localEmbedModel" => "Local models",
            "thinkingEffort" | "promptCachingEnabled" => "Thinking & task models",
            "classAComposer" | "brainUseClaudeCli" | "brainWarmupEnabled" | "workersUseBrain" => {
                "Brain advanced"
            }
            "branchPrefix" => "Branches",
            "commitAttributionEnabled" => "Commits",
            "prLinkDestination" => "Pull requests",
            "worktreeMaxCount" | "worktreeMaxTotalGb" => "Automatic cleanup",
            "workspaceParkingMode" => "Workspace parking",
            "storageReserveRatio" | "storageReserveFloorGb" => "Minimum free space",
            _ if self.section == "voice" => "Proactive attention",
            _ => "Task limits & setup",
        }
    }
    pub fn dependency_reason(
        &self,
        values: &std::collections::BTreeMap<String, Value>,
    ) -> Option<&'static str> {
        let value = |id: &str| values.get(id).unwrap_or(&Value::Null);
        if self.id == "autoSettleIdleDays" && value("autoSettleEnabled") == &Value::Bool(false) {
            return Some("Turn on Auto-settle finished threads to change the idle period.");
        }
        if self.id == "notificationsReviewReady"
            && value("presentationQuietMode") == &Value::Bool(true)
        {
            return Some("Held off while quiet mode is on.");
        }
        if matches!(
            self.id,
            "orchestratorBackend" | "reviewerBackend" | "defaultDispatchRuntime"
        ) && value("subscriptionProfile")
            .as_str()
            .is_some_and(|profile| profile != "both")
        {
            return Some(
                "Pinned by Subscription profile. Choose All available to change this provider.",
            );
        }
        if matches!(
            self.id,
            "broadcastVoiceAttention"
                | "broadcastVoiceApprovals"
                | "broadcastVoiceReviews"
                | "broadcastVoiceFailures"
                | "broadcastVoiceCompletions"
                | "broadcastVoiceCalendar"
                | "broadcastVoiceTimeCheckins"
                | "broadcastVoiceCalendarLeadMinutes"
        ) && value("broadcastVoice").as_str() != Some("on")
        {
            return Some("Turn on Spoken updates to change this notification.");
        }
        if self.id == "broadcastVoiceCalendarLeadMinutes"
            && value("broadcastVoiceCalendar") != &Value::Bool(true)
        {
            return Some("Turn on Calendar events to change the lead time.");
        }
        if matches!(
            self.id,
            "broadcastVoiceQuietStart" | "broadcastVoiceQuietEnd"
        ) && value("broadcastVoiceQuietHours").as_str() != Some("on")
        {
            return Some("Turn on Quiet hours to change this window.");
        }
        None
    }
    pub fn display(&self, value: &Value) -> String {
        match self.kind {
            Kind::ReadOnly => match value {
                Value::String(value) => value.clone(),
                Value::Array(values) => values
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", "),
                _ => "Unavailable".into(),
            },
            Kind::TierEffort => value["runtime"].as_str().unwrap_or("Unavailable").into(),
            Kind::Number(scale, unit) => value
                .as_f64()
                .map(|n| format!("{}{}", n * scale, unit))
                .unwrap_or("Unavailable".into()),
            Kind::WordToggle(word) => if value == word {
                "On"
            } else if value == "off" {
                "Off"
            } else {
                "Unavailable"
            }
            .into(),
            Kind::Toggle => match value.as_bool() {
                Some(true) => "On",
                Some(false) => "Off",
                None => "Unavailable",
            }
            .into(),
            Kind::Choice(choices) => choices
                .iter()
                .find(|(key, _)| value == key)
                .map(|(_, label)| *label)
                .unwrap_or("Unavailable")
                .into(),
            Kind::Bots => format!("{} selected", value.as_array().map_or(0, Vec::len)),
            Kind::Text | Kind::Time => value.as_str().unwrap_or("Unavailable").into(),
        }
    }
    pub fn parse(&self, text: &str) -> Result<Value, String> {
        match self.kind {
            Kind::Number(scale, _) => text
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite())
                .map(|n| Value::from(n / scale))
                .ok_or("Enter a finite number.".into()),
            Kind::Time => {
                let text = text.trim();
                let valid = text.len() == 5
                    && text.as_bytes()[2] == b':'
                    && text[..2].parse::<u8>().is_ok_and(|h| h < 24)
                    && text[3..].parse::<u8>().is_ok_and(|m| m < 60);
                if valid {
                    Ok(Value::from(text))
                } else {
                    Err("Enter a time in HH:MM format (00:00–23:59).".into())
                }
            }
            _ => Ok(Value::from(text.trim())),
        }
    }
}
const fn field(
    id: &'static str,
    label: &'static str,
    section: &'static str,
    detail: &'static str,
    kind: Kind,
) -> Field {
    Field {
        id,
        label,
        section,
        detail,
        kind,
    }
}
const BOOL: Kind = Kind::Toggle;
const NUMBER: Kind = Kind::Number(1., "");
pub(crate) const EFFORT: &[(&str, &str)] = &[
    ("adaptive", "Adaptive"),
    ("low", "Low"),
    ("medium", "Medium"),
    ("high", "High"),
    ("max", "Max"),
    ("xhigh", "Extra"),
];
pub const SECTIONS: &[(&str, &str)] = &[
    ("general", "General"),
    ("appearance", "Appearance"),
    ("voice", "Voice"),
    ("keyboard", "Keyboard"),
    ("bots", "Bots"),
    ("dispatch", "Dispatch"),
    ("models", "Models & providers"),
    ("local-models", "Local models"),
    ("providers", "Providers"),
    ("keys", "API keys"),
    ("storage", "Worktrees & storage"),
    ("git", "Git & PRs"),
    ("indexing", "Indexing"),
    ("mcp", "MCP"),
    ("machines", "Machines"),
    ("connections", "Connections"),
    ("diagnostics", "Diagnostics"),
    ("limits", "Limits"),
    ("about", "About"),
];
pub const FIELDS: &[Field] = &[
    field(
        "botRailEnabledIds",
        "Bots in the rail",
        "bots",
        "Choose which discovered local bots appear below PRs.",
        Kind::Bots,
    ),
    field(
        "autoTitleInferenceEnabled",
        "Model-generated titles",
        "general",
        "Allow a background model call to title new conversations.",
        BOOL,
    ),
    field(
        "autoSettleEnabled",
        "Auto-settle finished threads",
        "general",
        "Settle finished threads with a PR or worker. Pinned threads and threads waiting on you stay active.",
        BOOL,
    ),
    field(
        "autoSettleIdleDays",
        "Auto-settle after idle days",
        "general",
        "Days without activity before a thread with a PR or worker settles. 0 disables idle settlement.",
        NUMBER,
    ),
    field(
        "composerEnterQueues",
        "Enter queues while running",
        "general",
        "While a thread runs, Enter queues the follow-up instead of steering. Cmd-Shift-Enter still swaps for one send.",
        BOOL,
    ),
    field(
        "textGenerationTitleModel",
        "Title model",
        "general",
        "OpenRouter model tried first for thread titles ([text_generation] title_model). Empty uses the free chain.",
        Kind::Text,
    ),
    field(
        "presentationQuietMode",
        "Quiet mode",
        "general",
        "Suppress non-critical overlays, coach cards, pills, toasts and review notifications.",
        BOOL,
    ),
    field(
        "notificationsReviewReady",
        "Review notifications",
        "general",
        "Held off while quiet mode is on.",
        Kind::Choice(&[("off", "Off"), ("on", "On")]),
    ),
    field(
        "productTelemetryEnabled",
        "Share usage data",
        "general",
        "Optional feature-use events. Does not include prompts, code or file paths.",
        BOOL,
    ),
    field(
        "crashReportsEnabled",
        "Share crash reports",
        "general",
        "Share scrubbed errors and stack traces. Required for bug reports.",
        BOOL,
    ),
    field(
        "telemetryOptIn",
        "Automatically upload local crash logs",
        "general",
        "Upload saved crash logs when a destination is configured. Local logging continues when off.",
        BOOL,
    ),
    field(
        "parallelCap",
        "Concurrent agents",
        "dispatch",
        "Maximum simultaneous dispatched agents. Desktop presets: 2, 5, 8.",
        NUMBER,
    ),
    field(
        "overlapGate",
        "Overlapping work",
        "dispatch",
        "Choose how overlapping packet changes are handled.",
        Kind::Choice(&[("advisory", "Warn"), ("strict", "Block")]),
    ),
    field(
        "healBotEnabled",
        "Automatically fix failed checks",
        "dispatch",
        "One focused AI repair, limited to five minutes. Takes effect after restarting o8.",
        BOOL,
    ),
    field(
        "supervisorAutoEscalate",
        "Investigate failures in chat",
        "dispatch",
        "Start an AI investigation when a task needs help. May use the connected runtime's allowance.",
        BOOL,
    ),
    field(
        "reviewContinuation",
        "Automatically review completed work",
        "dispatch",
        "Review ready work, subject to merge approval and required checks.",
        BOOL,
    ),
    field(
        "requireApproval",
        "Merge approval",
        "dispatch",
        "Required checks still apply to every merge.",
        Kind::Choice(&[
            ("always", "Always"),
            ("surface", "Task owner"),
            ("high-risk", "After review"),
            ("never", "Never"),
        ]),
    ),
    field(
        "updateAutoApply",
        "Install app updates automatically",
        "dispatch",
        "Restart to install an update only when agents, terminals and background jobs are idle.",
        Kind::Choice(&[("off", "Off"), ("idle", "When idle")]),
    ),
    field(
        "packetExplainerEnabled",
        "Explain completed changes",
        "dispatch",
        "Create an extra AI report using the review provider.",
        BOOL,
    ),
    field(
        "buyinDocEnabled",
        "Create a summary after merge",
        "dispatch",
        "Shareable report with available demos. Does not delay merge.",
        BOOL,
    ),
    field(
        "meteredPacketCostCapUsd",
        "Spending limit per task",
        "dispatch",
        "Maximum reported gateway spending in USD per metered task, not an account-wide cap.",
        NUMBER,
    ),
    field(
        "meteredPacketInputTokenCap",
        "Backup input-token limit",
        "dispatch",
        "Token ceiling used only when gateway cost is unknown.",
        NUMBER,
    ),
    field(
        "uiLoopMaxIterations",
        "UI loop iterations",
        "dispatch",
        "Follow-up steers allowed per Design Mode packet.",
        NUMBER,
    ),
    field(
        "uiLoopMaxMinutes",
        "UI loop minutes",
        "dispatch",
        "Wall-time budget from the first Design Mode turn.",
        NUMBER,
    ),
    field(
        "uiLoopMaxDiffBytes",
        "UI loop diff bytes",
        "dispatch",
        "Maximum current packet diff size.",
        NUMBER,
    ),
    field(
        "uiLoopMaxDiffFiles",
        "UI loop diff files",
        "dispatch",
        "Maximum files in the current packet diff.",
        NUMBER,
    ),
    field(
        "uiLoopPreviewTimeoutMs",
        "UI loop preview timeout",
        "dispatch",
        "Milliseconds to wait for preview readiness.",
        NUMBER,
    ),
    field(
        "workspaceManifestPolicy",
        "Workspace manifest execution",
        "dispatch",
        "Gate checked-in setup commands before packet launch.",
        Kind::Choice(&[
            ("disabled", "Disabled"),
            ("one-approval", "Approve once"),
            ("auto", "Auto"),
        ]),
    ),
    field(
        "brainRoutingMode",
        "Answer routing",
        "models",
        "Auto uses eligible managed inference and never silently falls back. Subscription explicitly permits connected CLI quota.",
        Kind::Choice(&[("auto", "Auto"), ("subscription", "Subscription")]),
    ),
    field(
        "brainCodexModel",
        "Codex model",
        "models",
        "Model for Brain classification and cited answers. Server validates supported model IDs.",
        Kind::Text,
    ),
    field(
        "brainCodexEffort",
        "Codex effort",
        "models",
        "Reasoning effort for Engineering Brain calls.",
        Kind::Choice(&[
            ("adaptive", "Runtime default"),
            ("low", "Low"),
            ("medium", "Medium"),
            ("high", "High"),
            ("xhigh", "Extra"),
        ]),
    ),
    field(
        "codexAppThreads",
        "Show chats in the Codex app",
        "models",
        "Read and continue o8 orchestrator chats in Codex.",
        BOOL,
    ),
    field(
        "thinkingEffort",
        "Thinking effort",
        "models",
        "Default reasoning effort. Usage limits apply to longer turns.",
        Kind::Choice(EFFORT),
    ),
    field(
        "promptCachingEnabled",
        "Prompt caching",
        "models",
        "Reuse provider prompt caching where supported.",
        BOOL,
    ),
    field(
        "classAComposer",
        "Brain answer model",
        "models",
        "Optional answer-model tuning.",
        Kind::Choice(&[
            ("auto", "Auto"),
            ("haiku-cli", "Haiku"),
            ("sonnet-cli", "Sonnet"),
            ("fastest", "Fastest"),
        ]),
    ),
    field(
        "brainUseClaudeCli",
        "Brain uses Claude CLI",
        "models",
        "Allow Brain to use the connected Claude CLI allowance.",
        BOOL,
    ),
    field(
        "brainWarmupEnabled",
        "Pre-warm Brain runtimes",
        "models",
        "Warm Brain runtimes during startup.",
        BOOL,
    ),
    field(
        "workersUseBrain",
        "Workers use the Brain",
        "models",
        "Control worker access to Engineering Brain.",
        Kind::Choice(&[("off", "Off"), ("auto", "Auto"), ("all", "All")]),
    ),
    field(
        "branchPrefix",
        "Branch prefix",
        "git",
        "Issue branches use prefix/<number>-<title>. Inline drafts retain inline/.",
        Kind::Text,
    ),
    field(
        "commitAttributionEnabled",
        "Tag commits created by agents",
        "git",
        "Append the o8 agent Co-Authored-By trailer. Your own commits are unchanged.",
        BOOL,
    ),
    field(
        "prLinkDestination",
        "Open pull requests",
        "git",
        "Choose where PR links open in the desktop surface.",
        Kind::Choice(&[("in-app", "In o8"), ("browser", "Browser")]),
    ),
    field(
        "worktreeMaxCount",
        "Workspace count per repository",
        "storage",
        "Inactive task workspaces retained before automatic cleanup. 0 disables this limit.",
        NUMBER,
    ),
    field(
        "worktreeMaxTotalGb",
        "Disk usage per repository",
        "storage",
        "Inactive task workspace budget in GB. 0 disables this limit.",
        NUMBER,
    ),
    field(
        "workspaceParkingMode",
        "Parking mode",
        "storage",
        "Reclaim eligible workspaces with restoration information preserved.",
        Kind::Choice(&[("manual", "Manual"), ("pressure", "Pressure"), ("settled", "On settle")]),
    ),
    field(
        "storageReserveRatio",
        "Volume reserve",
        "storage",
        "Percentage of disk capacity to keep available.",
        Kind::Number(100., "%"),
    ),
    field(
        "storageReserveFloorGb",
        "Absolute floor",
        "storage",
        "Minimum free disk space in GB before starting tasks.",
        NUMBER,
    ),
    field(
        "subscriptionProfile",
        "Subscription profile",
        "models",
        "Choose which connected tools may run tasks. A single-provider profile pins the lead, reviewer and default worker.",
        Kind::Choice(&[
            ("both", "All available"),
            ("claude-only", "Claude only"),
            ("codex-only", "Codex / OpenAI only"),
        ]),
    ),
    field(
        "reviewerBackend",
        "Code review provider",
        "models",
        "Same as lead follows the orchestrator provider. A subscription profile can pin this choice.",
        Kind::Choice(&[
            ("follow", "Same as lead"),
            ("claude", "Claude"),
            ("codex", "Codex"),
        ]),
    ),
    field(
        "codexWorkerEffort",
        "Codex worker effort",
        "models",
        "Used when a Codex worker has no effort choice.",
        Kind::Choice(&[
            ("adaptive", "Runtime default"),
            ("low", "Low"),
            ("medium", "Medium"),
            ("high", "High"),
            ("xhigh", "Extra"),
        ]),
    ),
    field(
        "claudeWorkerEffort",
        "Claude worker effort",
        "models",
        "Used when a Claude Code worker has no effort choice.",
        Kind::Choice(&[
            ("adaptive", "Runtime default"),
            ("low", "Low"),
            ("medium", "Medium"),
            ("high", "High"),
            ("max", "Max"),
        ]),
    ),
    field(
        "orchestratorModel",
        "Claude fallback model",
        "models",
        "Used only when a request does not select a model. Composer choices take precedence.",
        Kind::Choice(&[
            ("claude-opus-5-5", "Opus 5.5"),
            ("claude-fable-5-1", "Fable 5.1"),
            ("claude-fable-5", "Fable 5"),
            ("claude-opus-5", "Opus 5"),
            ("claude-opus-4-8", "Opus 4.8"),
            ("claude-opus-4-7", "Opus 4.7"),
            ("claude-opus-4-6", "Opus 4.6"),
            ("claude-sonnet-5", "Sonnet 5"),
            ("claude-sonnet-4-5", "Sonnet 4.5"),
            ("claude-haiku-4-5", "Haiku 4.5"),
        ]),
    ),
    field(
        "collideAggregator",
        "Combined answer provider",
        "models",
        "Choose who combines answers when the lead uses Claude + Codex.",
        Kind::Choice(&[("auto", "Auto"), ("claude", "Claude"), ("codex", "Codex")]),
    ),
    field(
        "inAppOrchestratorEnabled",
        "Existing setup uses Claude",
        "models",
        "Only affects Use existing setup: on uses Claude, off uses Codex. An explicit lead takes precedence.",
        BOOL,
    ),
    field(
        "crossHouseWorkerFallback",
        "Worker quota fallback",
        "models",
        "Allow a task to restart with another supported subscription provider when its worker reaches a usage limit.",
        BOOL,
    ),
    field(
        "experimentalOpencode",
        "Show OpenCode in dispatch pickers",
        "models",
        "Allow OpenCode as a worker choice. Installing or signing in remains separate.",
        BOOL,
    ),
    field(
        "localChatModel",
        "Chat model",
        "local-models",
        "Model served by your already configured local inference endpoint. Does not change its address or credentials.",
        Kind::Text,
    ),
    field(
        "localEmbedModel",
        "Embedding model",
        "local-models",
        "Embedding model served by your already configured local inference endpoint.",
        Kind::Text,
    ),
    field(
        "targetingTriage",
        "Targeting — triage tier",
        "models",
        "Effort used to assess repositories and simpler files. The saved provider and model are preserved.",
        Kind::TierEffort,
    ),
    field(
        "targetingAction",
        "Targeting — action tier",
        "models",
        "Effort used for targeted implementation. The saved provider and model are preserved.",
        Kind::TierEffort,
    ),
    field(
        "defaultDispatchRuntime",
        "Default worker",
        "models",
        "Saved worker used when a task does not choose a runtime.",
        Kind::ReadOnly,
    ),
    field(
        "workerRuntimes",
        "Allowed workers",
        "models",
        "Saved worker pool. Inspect declared actions in Connections.",
        Kind::ReadOnly,
    ),
];

#[path = "settings_voice_fields.rs"]
mod voice;
pub fn fields() -> impl Iterator<Item = &'static Field> {
    FIELDS.iter().chain(voice::FIELDS)
}

// Keep the frozen classic model menu while retaining editable saved custom values.
pub const BRAIN_MODELS: &[(&str, &str)] = &[
    ("gpt-6-astra", "Astra"),
    ("gpt-6.1-sol", "GPT-6.1 Sol"),
    ("gpt-6-sol", "GPT-6 Sol"),
    ("gpt-6-luna", "GPT-6 Luna"),
    ("gpt-5.6-terra", "Terra"),
    ("gpt-5.6-sol", "GPT-5.6 Sol"),
    ("gpt-5.6-luna", "Luna"),
    ("gpt-5.5", "GPT-5.5"),
];
