//! Desktop row vocabulary and existing operator-defaults field names.
use serde_json::Value;

#[derive(Clone, Copy)]
pub enum Kind {
    Toggle,
    Choice(&'static [(&'static str, &'static str)]),
    Number(f64, &'static str),
    Text,
}
pub struct Field {
    pub id: &'static str,
    pub label: &'static str,
    pub section: &'static str,
    pub detail: &'static str,
    pub kind: Kind,
}
impl Field {
    pub fn matches(&self, query: &str) -> bool {
        let text = format!(
            "{} {} {} {}",
            self.id, self.label, self.section, self.detail
        )
        .to_lowercase();
        query
            .split_whitespace()
            .all(|word| text.contains(&word.to_lowercase()))
    }
    pub fn display(&self, value: &Value) -> String {
        match self.kind {
            Kind::Number(scale, unit) => value
                .as_f64()
                .map(|n| format!("{}{}", n * scale, unit))
                .unwrap_or("Unavailable".into()),
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
            Kind::Text => value.as_str().unwrap_or("Unavailable").into(),
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
const EFFORT: &[(&str, &str)] = &[
    ("adaptive", "Adaptive"),
    ("low", "Low"),
    ("medium", "Medium"),
    ("high", "High"),
    ("max", "Max"),
    ("xhigh", "Extra"),
];
pub const SECTIONS: &[(&str, &str)] = &[
    ("general", "General"),
    ("dispatch", "Dispatch"),
    ("models", "Models & providers"),
    ("git", "Git & PRs"),
    ("storage", "Worktrees & storage"),
    ("keys", "API keys"),
];
pub const FIELDS: &[Field] = &[
    field(
        "autoTitleInferenceEnabled",
        "Model-generated titles",
        "general",
        "Allow a background model call to title new conversations.",
        BOOL,
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
        Kind::Choice(&[("manual", "Manual"), ("pressure", "Pressure")]),
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
];
