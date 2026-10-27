//! Symon planner selection — a registry of text-planner adapters (#2156).
//!
//! ## The registry
//! Every entry in `PLANNER_ADAPTERS` describes one CLI that can sit behind the
//! JSON-action planner protocol: the binary to look for (and the env overrides
//! that locate it), the transport its session factory uses, the model ids for
//! its worker and builder rungs, and how a reasoning effort reaches it. The
//! protocol itself never varies — `TextPlannerSession` in `claude.rs` is the
//! contract, and adapters differ only in spawn and transport — so adding a
//! runtime is a registry row plus a session type, not a new branch in the loop.
//!
//! ## Tier discipline (#2155)
//! The planner runs bounded multi-step Mac tasks over the native tool catalog.
//! That is a worker/builder seat, so the FRONTIER orchestrator model is never
//! the default here — a background seat that inherits the orchestrator tier is
//! the same footgun as a subagent inheriting its parent's model. With no
//! operator pin each entry seats its own `default_tier`:
//!
//! * Claude → Sonnet 5 (worker rung) at the CLI's default reasoning — the
//!   `--effort` flag rides the BUILDER rung only.
//! * Codex → `gpt-5.6-sol` (builder rung) at `high`.
//! * opencode → whatever model the operator already configured for it.
//!
//! The other rung of each ladder (Claude Opus 5 at `high`, Codex
//! `gpt-5.6-terra` at `medium`) and the frontier id itself stay reachable
//! through an operator pin or `resolve_bound`.
//!
//! ## Provider preference
//! The operator's "Symon brain" setting (Settings → Voice) picks the provider
//! outright. Left on `auto` the route follows their orchestrator backend
//! (`~/.o8/operator-defaults.json`), falling back to Codex — see
//! `preferred_provider_from`. A chosen provider whose binary is missing falls
//! through `OPEN_PREFERENCE`, which reaches for open runtimes first.

use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) const NO_AGENT_CLI_MESSAGE: &str =
    "no agent CLI found — install opencode, codex, or claude";
const INVALID_PLANNER_SELECTION_MESSAGE: &str = "invalid or unavailable Symon planner selection";
static CLAUDE_FABLE_UNAVAILABLE: AtomicBool = AtomicBool::new(false);
static CLAUDE_OPUS_5_UNAVAILABLE: AtomicBool = AtomicBool::new(false);

/// Worker-tier Claude planner — the no-pin default. Runs at the CLI's own
/// reasoning setting (no `--effort`), which is what keeps this seat cheap.
pub(crate) const DEFAULT_CLAUDE_PLANNER_MODEL: &str = crate::models::CLAUDE_SONNET_5;
/// Builder-tier Claude planner, reachable through an operator pin.
pub(crate) const BUILDER_CLAUDE_PLANNER_MODEL: &str = crate::models::CLAUDE_OPUS_5;
/// Builder-tier Codex planner — the no-pin default on the Codex side.
pub(crate) const DEFAULT_CODEX_PLANNER_MODEL: &str = crate::models::CODEX_GPT_5_6_SOL;
/// Worker-tier Codex planner, reachable through an operator pin.
pub(crate) const WORKER_CODEX_PLANNER_MODEL: &str = crate::models::CODEX_GPT_5_6_TERRA;

/// Reported effort for an adapter that takes its reasoning setting from the
/// operator's own runtime config rather than from o8.
pub(crate) const RUNTIME_CONFIGURED_EFFORT: &str = "default";

/// The `model` half of the bound surface's triple for a seat that has no
/// o8-side model id (#2176). It is a MARKER, never a model: `accepts_model`
/// refuses it as an operator pin, and `resolve_bound` translates it back to
/// "no model" before the selection reaches a spawn, so it can never ride a
/// CLI's `--model` flag. Binding identity for such a seat is the registry id
/// plus the per-session handle in `bound_seat`; this keeps the triple shape
/// intact for callers that already speak it.
pub(crate) const RUNTIME_CONFIGURED_MODEL: &str = "runtime-configured";

/// Voice-pref keys for the Symon brain setting. Written by `voice_prefs_set`
/// (→ `stt::keys::set_pref`) and read back out of the same JSON file here, so a
/// settings change applies to the next task with no relaunch.
pub(crate) const BRAIN_PROVIDER_PREF: &str = "symon_brain_provider";
pub(crate) const BRAIN_TIER_PREF: &str = "symon_brain_tier";
pub(crate) const BRAIN_MODEL_PREF: &str = "symon_brain_model";

/// How a planner session is spawned and how turns ride it. One variant per
/// session factory; the JSON-action protocol above it is identical for all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlannerTransport {
    /// Resident `claude --input-format stream-json` child, one per task.
    ClaudeStreamJson,
    /// Resident `codex app-server --stdio` child, degrading to per-turn
    /// `codex exec` / `exec resume` when the handshake fails.
    CodexAppServer,
    /// Per-turn `opencode run --format json`, resumed with `--session <id>`.
    OpencodeRun,
}

/// How the seat's reasoning effort reaches the CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlannerEffort {
    /// Model-tier defaults pass `--effort` on the builder rung. Bound requests
    /// pass their validated effort on every catalog model in a dedicated session.
    ClaudeBuilderFlag,
    /// `-c model_reasoning_effort=<tier>` on every spawn.
    CodexReasoningEffort,
    /// o8 passes nothing. The CLI's accepted reasoning names are per-provider
    /// and per-model, so an adapter whose model comes from the operator's own
    /// config is never handed a guessed one.
    RuntimeConfigured,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PlannerTier {
    Worker,
    Builder,
}

impl PlannerTier {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            PlannerTier::Worker => "worker",
            PlannerTier::Builder => "builder",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "worker" => Some(PlannerTier::Worker),
            "builder" => Some(PlannerTier::Builder),
            _ => None,
        }
    }
}

/// One row of the planner registry.
pub(crate) struct PlannerAdapter {
    /// Stable id — the operator setting value, the log tag, and the `engine`
    /// the bound (phone) surface sends back.
    pub id: &'static str,
    /// Operator-facing name for the settings row.
    pub label: &'static str,
    /// Executable looked for on PATH and in the well-known CLI bin dirs.
    pub binary: &'static str,
    /// Env vars consulted before the PATH scan, in order.
    pub binary_env: &'static [&'static str],
    /// Session factory shape.
    pub transport: PlannerTransport,
    /// Worker-rung model id, or `None` when o8 pins no model for this adapter
    /// and the CLI runs whatever the operator configured. Open runtimes take
    /// `None`: which models they can reach depends on the operator's own
    /// provider credentials, so an o8-side pin would name a model a large
    /// share of installs cannot run.
    pub worker_model: Option<&'static str>,
    /// Builder-rung model id, same `None` rule.
    pub builder_model: Option<&'static str>,
    /// The rung this adapter seats when the operator has picked no tier. It is
    /// per-adapter rather than a global constant because the ladders are not
    /// symmetric: Codex `gpt-5.6-sol` is the builder rung AND the cheapest
    /// capable Codex planner seat, which is what #2155 shipped as its default.
    pub default_tier: PlannerTier,
    /// How effort is passed.
    pub effort: PlannerEffort,
    /// Model ids an operator pin may name. Empty means the adapter takes any
    /// `provider/model` id, because its catalog is the operator's, not ours.
    pub pinnable_models: &'static [&'static str],
}

impl PlannerAdapter {
    /// True when this adapter runs whatever model the operator configured for
    /// it, so o8 holds no model id to bind the text surface with.
    pub(crate) fn runtime_configured_model(&self) -> bool {
        self.worker_model.is_none()
    }

    /// Does this adapter accept `model` as an operator pin? Catalog adapters
    /// allow-list their ids (a raw CLI value must never reach the spawn);
    /// open-catalog adapters validate the `provider/model` shape instead.
    pub(crate) fn accepts_model(&self, model: &str) -> bool {
        let model = model.trim();
        // The bound surface's marker is not a model and must never reach a
        // spawn — `resolve_bound` is the only place that understands it.
        if model.is_empty() || model == RUNTIME_CONFIGURED_MODEL {
            return false;
        }
        if !self.pinnable_models.is_empty() {
            return self.pinnable_models.contains(&model);
        }
        model.len() <= 120
            && model.contains('/')
            && model.chars().all(|c| {
                c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.' | ':')
            })
    }

    fn accepts_effort(&self, effort: &str) -> bool {
        matches!(effort, "low" | "medium" | "high" | "xhigh")
            || (self.effort == PlannerEffort::RuntimeConfigured
                && effort == RUNTIME_CONFIGURED_EFFORT)
    }

    fn tier_model(&self, tier: PlannerTier) -> Option<&'static str> {
        match tier {
            PlannerTier::Worker => self.worker_model,
            PlannerTier::Builder => self.builder_model,
        }
    }
}

/// Identity is the id — two rows never share one, and comparing the whole
/// struct would drag the model tables into every assertion.
impl PartialEq for PlannerAdapter {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}
impl Eq for PlannerAdapter {}

impl std::fmt::Debug for PlannerAdapter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.id)
    }
}

const CLAUDE_ADAPTER: PlannerAdapter = PlannerAdapter {
    id: "claude",
    label: "Claude",
    binary: "claude",
    binary_env: &["O8_CLAUDE_CODE_BIN", "CLAUDE_BIN"],
    transport: PlannerTransport::ClaudeStreamJson,
    worker_model: Some(DEFAULT_CLAUDE_PLANNER_MODEL),
    builder_model: Some(BUILDER_CLAUDE_PLANNER_MODEL),
    default_tier: PlannerTier::Worker,
    effort: PlannerEffort::ClaudeBuilderFlag,
    pinnable_models: &[
        crate::models::CLAUDE_OPUS_4_8,
        crate::models::CLAUDE_OPUS_5,
        crate::models::CLAUDE_SONNET_5,
        crate::models::CLAUDE_HAIKU_4_5_DATED,
        crate::models::CLAUDE_FABLE_5,
    ],
};

const CODEX_ADAPTER: PlannerAdapter = PlannerAdapter {
    id: "codex",
    label: "Codex",
    binary: "codex",
    binary_env: &["O8_CODEX_BIN", "CODEX_BIN"],
    transport: PlannerTransport::CodexAppServer,
    worker_model: Some(WORKER_CODEX_PLANNER_MODEL),
    builder_model: Some(DEFAULT_CODEX_PLANNER_MODEL),
    default_tier: PlannerTier::Builder,
    effort: PlannerEffort::CodexReasoningEffort,
    pinnable_models: &[
        crate::models::CODEX_GPT_6_1_SOL,
        crate::models::CODEX_GPT_6_SOL,
        crate::models::CODEX_GPT_6_LUNA,
        crate::models::CODEX_GPT_5_6_SOL,
        crate::models::CODEX_GPT_5_6_TERRA,
    ],
};

const OPENCODE_ADAPTER: PlannerAdapter = PlannerAdapter {
    id: "opencode",
    label: "opencode",
    binary: "opencode",
    binary_env: &["O8_OPENCODE_BIN", "OPENCODE_BIN"],
    transport: PlannerTransport::OpencodeRun,
    worker_model: None,
    builder_model: None,
    default_tier: PlannerTier::Worker,
    effort: PlannerEffort::RuntimeConfigured,
    pinnable_models: &[],
};

pub(crate) static PLANNER_ADAPTERS: &[PlannerAdapter] =
    &[CLAUDE_ADAPTER, CODEX_ADAPTER, OPENCODE_ADAPTER];

/// Fallback order when the operator's chosen provider is not installed: open
/// runtimes first, so a machine with no proprietary CLI still has a brain.
const OPEN_PREFERENCE: [&str; 3] = ["opencode", "codex", "claude"];

/// The pair the route shipped with before the registry (#2155). Left on `auto`
/// it is still tried first and in this order, so an install that resolved a
/// seat then resolves the same seat now; `OPEN_PREFERENCE` only extends the
/// tail, which used to be "no agent CLI found".
const DEFAULT_PAIR: [&str; 2] = ["codex", "claude"];

pub(crate) fn adapter_by_id(id: &str) -> Option<&'static PlannerAdapter> {
    PLANNER_ADAPTERS.iter().find(|adapter| adapter.id == id)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlannerSelection {
    pub provider: &'static PlannerAdapter,
    pub binary: String,
    /// Resolved model id, or `None` when the adapter defers to the model the
    /// operator configured for it.
    pub model: Option<String>,
    /// The reasoning tier this seat runs at. Bound requests pass this value
    /// unchanged; unbound selections use their model-tier defaults. An adapter
    /// whose reasoning comes from its runtime config reports `default`.
    pub effort: &'static str,
}

impl PlannerSelection {
    /// Model name for logs, the task ledger and the settings status line. Falls
    /// back to the adapter id when the seat carries no o8-side model.
    pub(crate) fn model_label(&self) -> &str {
        self.model.as_deref().unwrap_or(self.provider.id)
    }

    /// The `model` the bound (phone / managed-messages) surface carries for
    /// this seat: the o8-side id when the seat has one, and the
    /// runtime-configured marker when its model comes from the operator's own
    /// runtime config. Round-trips back through `resolve_bound`.
    pub(crate) fn bound_model(&self) -> &str {
        self.model.as_deref().unwrap_or(RUNTIME_CONFIGURED_MODEL)
    }

    /// The seat named the way the Settings → Voice status line names it —
    /// `label · model · effort`. A seat that takes BOTH its model and its
    /// reasoning from the operator's own runtime config collapses to
    /// `label · runtime-configured`, because spelling out a model o8 did not
    /// choose and an effort it did not pass says nothing.
    pub(crate) fn seat_line(&self) -> String {
        match &self.model {
            Some(model) => format!("{} · {model} · {}", self.provider.label, self.effort),
            None => format!("{} · {RUNTIME_CONFIGURED_MODEL}", self.provider.label),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlannerRouting {
    Selected(PlannerSelection),
    Unavailable { message: &'static str },
}

/// The operator's Symon brain setting, as stored.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct BrainSetting {
    /// `None` when the setting is unset or on `auto`.
    pub provider: Option<String>,
    pub tier: Option<PlannerTier>,
    pub model: Option<String>,
}

pub(crate) fn locate_planner_binary(adapter: &PlannerAdapter) -> Option<String> {
    crate::cli_locate::resolve_binary(adapter.binary, adapter.binary_env)
}

pub(crate) fn resolve() -> PlannerRouting {
    resolve_with(&read_brain_setting(), preferred_provider(), locate_planner_binary)
}

/// Text-only default. Voice keeps its existing rung; a bound session or model
/// pin never passes through this new-session selection.
pub(crate) fn resolve_text() -> (PlannerRouting, bool) {
    resolve_text_with(&read_brain_setting(), preferred_provider(), locate_planner_binary)
}

fn resolve_text_with<F>(setting: &BrainSetting, preferred: &'static PlannerAdapter, locate: F) -> (PlannerRouting, bool)
where F: FnMut(&PlannerAdapter) -> Option<String> {
    let mut routing = resolve_with(setting, preferred, locate);
    let mut automatic = false;
    if let PlannerRouting::Selected(selection) = &mut routing {
        if selection.provider.id == "codex" && setting.model.is_none()
            && selection.model.as_deref() == Some(DEFAULT_CODEX_PLANNER_MODEL) {
            selection.model = Some(crate::models::CODEX_GPT_6_1_SOL.to_string());
            automatic = true;
        }
    }
    (routing, automatic)
}

pub(crate) fn resolve_bound(engine: &str, model: &str, effort: &str) -> PlannerRouting {
    resolve_bound_with(engine, model, effort, locate_planner_binary)
}

/// Seat ONE named adapter for the Symon FRONT brain (#2164), or `None` when its
/// binary is missing — the front seat falls back on its own terms rather than
/// walking this registry's background fallback order.
///
/// The rung differs from `resolve`: with no operator tier the front seat takes
/// the WORKER rung, because it is the fast lane the operator talks to and it
/// must never inherit a builder default they did not ask for. The model pin is
/// the same one the background seat honors, and it still only rides the adapter
/// it validates for.
///
/// The locator is injected: a "this CLI is not installed" case cannot be staged
/// on a machine that HAS the CLI — a missing env override just falls through to
/// the PATH scan — so absence is tested through this seam, the way
/// `only_opencode_installed_routes_the_planner_through_opencode` does.
pub(crate) fn seat_front_adapter_with<F>(
    id: &str,
    tier: Option<PlannerTier>,
    pin: Option<&str>,
    mut locate: F,
) -> Option<PlannerSelection>
where
    F: FnMut(&PlannerAdapter) -> Option<String>,
{
    let adapter = adapter_by_id(id)?;
    let binary = locate(adapter)?;
    Some(selection_for(
        adapter,
        binary,
        Some(tier.unwrap_or(PlannerTier::Worker)),
        pin,
    ))
}

/// The `--effort` flag a Claude planner model is spawned with, or `None` to
/// leave the CLI at its own default. Builder tier (Opus / Fable) only: the
/// Sonnet worker default and the Smart Compose lane stay on the CLI default for
/// latency. A pure function of the model, so the model-keyed warm pool in
/// `claude_pool` cannot hand back a session booted at a different effort.
pub(crate) fn claude_effort_flag(model: &str) -> Option<&'static str> {
    (model.starts_with("claude-opus") || model == crate::models::CLAUDE_FABLE_5).then_some("high")
}

/// Reasoning tier reported for a Claude seat — the flag when one is passed, and
/// the CLI's own default (`medium`) when the seat runs flag-free.
fn claude_planner_effort(model: &str) -> &'static str {
    claude_effort_flag(model).unwrap_or("medium")
}

/// Reasoning tier for a Codex seat: `high` for the builder default,
/// `medium` for the worker rung.
fn codex_planner_effort(model: &str) -> &'static str {
    match model {
        WORKER_CODEX_PLANNER_MODEL => "medium",
        _ => "high",
    }
}

/// The provider the route reaches for first when the setting is on `auto`.
pub(crate) fn preferred_provider() -> &'static PlannerAdapter {
    preferred_provider_from(read_operator_defaults().as_ref())
}

/// `~/.o8/operator-defaults.json`, the same file the native shell already reads
/// for the crash-report toggle (`telemetry.rs`). Reading it here keeps the
/// planner's provider choice aligned with the operator's orchestrator backend
/// without an HTTP hop into the Next server. Missing or malformed resolves to
/// `None` and the Codex fallback below.
fn read_operator_defaults() -> Option<Value> {
    let raw = std::fs::read_to_string(super::agent_data_dir().join("operator-defaults.json")).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

/// `~/.o8/dictation.json` — the voice-pref store `voice_prefs_set` writes. Read
/// straight off disk rather than through `stt::keys`' mtime cache: the planner
/// resolves once per task, and a plain read keeps one file as the truth with no
/// second cached copy to go stale.
pub(crate) fn read_voice_prefs() -> Option<Value> {
    let raw = std::fs::read_to_string(super::agent_data_dir().join("dictation.json")).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

pub(crate) fn read_brain_setting() -> BrainSetting {
    brain_setting_from(read_voice_prefs().as_ref())
}

fn brain_setting_from(prefs: Option<&Value>) -> BrainSetting {
    let Some(prefs) = prefs else {
        return BrainSetting::default();
    };
    let string = |key: &str| {
        prefs
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    BrainSetting {
        provider: string(BRAIN_PROVIDER_PREF)
            .filter(|value| *value != "auto")
            .map(str::to_string),
        tier: string(BRAIN_TIER_PREF).and_then(PlannerTier::parse),
        model: string(BRAIN_MODEL_PREF).map(str::to_string),
    }
}

/// Map the operator's `orchestratorBackend` onto a planner adapter.
///
/// `claude`, `collide` and `fable` all run the Claude harness, so they seat the
/// Claude planner. `auto` defers to the legacy `inAppOrchestratorEnabled`
/// toggle exactly as the orchestrator backend registry does. `openclaw` and
/// `hermes` carry no local-CLI signal (they are governed profiles that only
/// dispatch), so they take the default with everything else: **Codex**, because
/// the Codex seat is subscription-billed and is the orchestrator default.
fn preferred_provider_from(defaults: Option<&Value>) -> &'static PlannerAdapter {
    let claude = &CLAUDE_ADAPTER;
    let codex = &CODEX_ADAPTER;
    let Some(defaults) = defaults else {
        return codex;
    };
    match defaults.get("orchestratorBackend").and_then(Value::as_str) {
        Some("claude") | Some("collide") | Some("fable") => claude,
        Some("codex") => codex,
        Some("auto") => match defaults.get("inAppOrchestratorEnabled").and_then(Value::as_bool) {
            Some(true) => claude,
            _ => codex,
        },
        _ => codex,
    }
}

pub(crate) fn effective_claude_model(model: &str) -> &str {
    effective_claude_model_with_availability(
        model,
        CLAUDE_FABLE_UNAVAILABLE.load(Ordering::Relaxed),
        CLAUDE_OPUS_5_UNAVAILABLE.load(Ordering::Relaxed),
    )
}

fn effective_claude_model_with_availability(
    model: &str,
    fable_unavailable: bool,
    opus_5_unavailable: bool,
) -> &str {
    match model {
        crate::models::CLAUDE_FABLE_5 if fable_unavailable && opus_5_unavailable => {
            crate::models::CLAUDE_OPUS_4_8
        }
        crate::models::CLAUDE_FABLE_5 if fable_unavailable => crate::models::CLAUDE_OPUS_5,
        crate::models::CLAUDE_OPUS_5 if opus_5_unavailable => crate::models::CLAUDE_OPUS_4_8,
        _ => model,
    }
}

pub(crate) fn claude_fallback_selection(binary: &str, model: &str) -> Option<PlannerSelection> {
    let model = match model {
        crate::models::CLAUDE_FABLE_5 => crate::models::CLAUDE_OPUS_5,
        crate::models::CLAUDE_OPUS_5 => crate::models::CLAUDE_OPUS_4_8,
        _ => return None,
    };
    Some(PlannerSelection {
        provider: &CLAUDE_ADAPTER,
        binary: binary.to_string(),
        model: Some(model.to_string()),
        effort: claude_planner_effort(model),
    })
}

pub(crate) fn remember_claude_model_unavailable(model: &str) {
    match model {
        crate::models::CLAUDE_FABLE_5 => CLAUDE_FABLE_UNAVAILABLE.store(true, Ordering::Relaxed),
        crate::models::CLAUDE_OPUS_5 => CLAUDE_OPUS_5_UNAVAILABLE.store(true, Ordering::Relaxed),
        _ => {}
    }
}

/// The degrade chain only rewrites Claude ids; every other adapter's catalog is
/// its own.
fn effective_model_for(adapter: &PlannerAdapter, model: &str) -> String {
    match adapter.transport {
        PlannerTransport::ClaudeStreamJson => effective_claude_model(model).to_string(),
        _ => model.to_string(),
    }
}

fn effort_for(adapter: &PlannerAdapter, model: Option<&str>) -> &'static str {
    match adapter.effort {
        PlannerEffort::ClaudeBuilderFlag => model.map_or("medium", claude_planner_effort),
        PlannerEffort::CodexReasoningEffort => model.map_or("high", codex_planner_effort),
        PlannerEffort::RuntimeConfigured => RUNTIME_CONFIGURED_EFFORT,
    }
}

/// Narrow a validated effort back to a `'static` string.
fn static_effort(effort: &str) -> &'static str {
    match effort {
        "low" => "low",
        "high" => "high",
        "xhigh" => "xhigh",
        RUNTIME_CONFIGURED_EFFORT => RUNTIME_CONFIGURED_EFFORT,
        _ => "medium",
    }
}

fn selection_for(
    adapter: &'static PlannerAdapter,
    binary: String,
    tier: Option<PlannerTier>,
    pin: Option<&str>,
) -> PlannerSelection {
    // A pin only applies to the adapter it is valid for — a Claude id left over
    // from an earlier provider choice must not ride an opencode spawn.
    let model = pin
        .filter(|pin| adapter.accepts_model(pin))
        .map(|pin| effective_model_for(adapter, pin))
        .or_else(|| {
            adapter
                .tier_model(tier.unwrap_or(adapter.default_tier))
                .map(|model| effective_model_for(adapter, model))
        });
    PlannerSelection {
        provider: adapter,
        binary,
        effort: effort_for(adapter, model.as_deref()),
        model,
    }
}

/// Adapters to try, in order. An explicitly chosen provider leads; `auto`
/// leads with the orchestrator-backend preference and the pair that preference
/// shipped with. Either way the tail is `OPEN_PREFERENCE`, so a machine
/// carrying only an open runtime still resolves a seat.
fn resolution_order(
    chosen: Option<&str>,
    preferred: &'static PlannerAdapter,
) -> Vec<&'static PlannerAdapter> {
    let mut order: Vec<&'static PlannerAdapter> = Vec::new();
    match chosen.and_then(adapter_by_id) {
        Some(adapter) => order.push(adapter),
        None => {
            order.push(preferred);
            for id in DEFAULT_PAIR {
                push_unique(&mut order, id);
            }
        }
    }
    for id in OPEN_PREFERENCE {
        push_unique(&mut order, id);
    }
    order
}

fn push_unique(order: &mut Vec<&'static PlannerAdapter>, id: &str) {
    let Some(adapter) = adapter_by_id(id) else {
        return;
    };
    if !order.iter().any(|seen| seen.id == adapter.id) {
        order.push(adapter);
    }
}

fn resolve_bound_with<F>(engine: &str, model: &str, effort: &str, mut locate: F) -> PlannerRouting
where
    F: FnMut(&PlannerAdapter) -> Option<String>,
{
    let unavailable = PlannerRouting::Unavailable {
        message: INVALID_PLANNER_SELECTION_MESSAGE,
    };
    let Some(adapter) = adapter_by_id(engine) else {
        return unavailable;
    };
    // Bind by seat identity, not by model triple (#2176): a seat whose model
    // comes from the operator's own runtime config carries the marker in the
    // model slot, and it is translated back to "no model" here so the spawn is
    // the same one the voice path makes.
    let runtime_configured =
        adapter.runtime_configured_model() && model.trim() == RUNTIME_CONFIGURED_MODEL;
    if !adapter.accepts_effort(effort) {
        return unavailable;
    }
    if !runtime_configured && !adapter.accepts_model(model) {
        return unavailable;
    }
    let Some(binary) = locate(adapter) else {
        return unavailable;
    };
    let model = (!runtime_configured).then(|| effective_model_for(adapter, model));
    PlannerRouting::Selected(PlannerSelection {
        provider: adapter,
        binary,
        // Bound requests carry a concrete pin, separate from the unbound
        // model-tier defaults. The session factory must pass it unchanged.
        effort: match adapter.effort {
            PlannerEffort::ClaudeBuilderFlag | PlannerEffort::CodexReasoningEffort => static_effort(effort),
            PlannerEffort::RuntimeConfigured => RUNTIME_CONFIGURED_EFFORT,
        },
        model,
    })
}

fn resolve_with<F>(
    setting: &BrainSetting,
    preferred: &'static PlannerAdapter,
    mut locate: F,
) -> PlannerRouting
where
    F: FnMut(&PlannerAdapter) -> Option<String>,
{
    for adapter in resolution_order(setting.provider.as_deref(), preferred) {
        if let Some(binary) = locate(adapter) {
            return PlannerRouting::Selected(selection_for(
                adapter,
                binary,
                setting.tier,
                setting.model.as_deref(),
            ));
        }
    }
    PlannerRouting::Unavailable {
        message: NO_AGENT_CLI_MESSAGE,
    }
}

// ── settings surface ────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymonBrainAdapterState {
    pub id: &'static str,
    pub label: &'static str,
    pub installed: bool,
    /// True when the adapter takes its model from the operator's own runtime
    /// config, so the settings panel can say so instead of showing a blank pin.
    pub runtime_configured_model: bool,
}

/// What Settings → Voice renders for the Symon brain row: the stored setting,
/// which adapters are actually installed, and the seat the route resolves right
/// now — so "not installed, falling back" is visible rather than silent.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymonBrainState {
    pub provider: String,
    pub tier: String,
    pub model: Option<String>,
    pub adapters: Vec<SymonBrainAdapterState>,
    pub resolved_provider: Option<&'static str>,
    pub resolved_label: Option<&'static str>,
    pub resolved_model: Option<String>,
    pub resolved_effort: Option<&'static str>,
    /// The chosen provider, when its binary is missing and the route fell
    /// through to another entry.
    pub fell_back_from: Option<String>,
    pub detail: Option<&'static str>,
    /// The FRONT seat (#2164) — the Right-Option gesture's own choice, resolved
    /// through the same registry plus the built-in Gemini loop. Default (empty)
    /// in the pure-resolution unit tests; `brain_state` fills it for the panel.
    pub front: super::front_brain::SymonFrontBrainState,
}

pub fn brain_state() -> SymonBrainState {
    let mut state =
        brain_state_with(&read_brain_setting(), preferred_provider(), locate_planner_binary);
    state.front = super::front_brain::state();
    state
}

fn brain_state_with<F>(
    setting: &BrainSetting,
    preferred: &'static PlannerAdapter,
    mut locate: F,
) -> SymonBrainState
where
    F: FnMut(&PlannerAdapter) -> Option<String>,
{
    let adapters = PLANNER_ADAPTERS
        .iter()
        .map(|adapter| SymonBrainAdapterState {
            id: adapter.id,
            label: adapter.label,
            installed: locate(adapter).is_some(),
            runtime_configured_model: adapter.runtime_configured_model(),
        })
        .collect();
    let routing = resolve_with(setting, preferred, &mut locate);
    let mut state = SymonBrainState {
        provider: setting.provider.clone().unwrap_or_else(|| "auto".to_string()),
        tier: setting
            .tier
            .map_or("auto", PlannerTier::as_str)
            .to_string(),
        model: setting.model.clone(),
        adapters,
        resolved_provider: None,
        resolved_label: None,
        resolved_model: None,
        resolved_effort: None,
        fell_back_from: None,
        detail: None,
        front: super::front_brain::SymonFrontBrainState::default(),
    };
    match routing {
        PlannerRouting::Selected(selection) => {
            if let Some(chosen) = setting.provider.as_deref() {
                if chosen != selection.provider.id {
                    state.fell_back_from = Some(chosen.to_string());
                }
            }
            state.resolved_provider = Some(selection.provider.id);
            state.resolved_label = Some(selection.provider.label);
            state.resolved_model = selection.model;
            state.resolved_effort = Some(selection.effort);
        }
        PlannerRouting::Unavailable { message } => state.detail = Some(message),
    }
    state
}

#[cfg(test)]
#[path = "planner_route_tests.rs"]
mod tests;
