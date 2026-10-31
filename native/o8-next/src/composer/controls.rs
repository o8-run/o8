//! Composer-only view state. Routing uses the existing durable queue schema.
use super::Composer;
use gpui::{Entity, FocusHandle, RenderImage};
use serde_json::{Value, json};
use std::collections::HashMap;

#[path = "context.rs"]
pub(crate) mod context;

pub(crate) struct State {
    pub context: context::MeterState,
    pub slash: super::commands::Slash,
    pub prompt: super::prompt_state::State,
    pub open: Option<&'static str>,
    pub model: Option<Entity<Composer>>,
    pub busy: bool,
    pub error: String,
    pub overrides: Value,
    pub focus: HashMap<String, FocusHandle>,
    pub images: Vec<Value>,
    /// Non-image attachments (a video, a log, a PDF), sent to the agent as paths.
    pub files: Vec<std::path::PathBuf>,
    pub previews: HashMap<String, std::sync::Arc<RenderImage>>,
    pub attachment_target: bool,
    pub images_enabled: bool,
    pub pending_images: usize,
}
impl Default for State {
    fn default() -> Self {
        Self {
            context: Default::default(),
            slash: Default::default(),
            prompt: Default::default(),
            open: None,
            model: None,
            busy: false,
            error: String::new(),
            overrides: json!({}),
            focus: HashMap::new(),
            images: vec![],
            files: vec![],
            previews: HashMap::new(),
            attachment_target: false,
            images_enabled: false,
            pending_images: 0,
        }
    }
}
pub(crate) fn mode_label(mode: &str) -> &'static str {
    match mode {
        "multitask" => "Worktrees",
        _ => "Shared",
    }
}
/// Classic shows only Shared and Worktrees (VISIBLE_COMPOSER_SELECTOR_MODES);
/// Solo and the advanced modes are internal. Any other saved mode reads the way
/// classic's cycleComposerSelectorMode maps it: Shared when the backend can
/// share a checkout (composerSupportsFastMode), otherwise Worktrees.
pub(crate) fn visible_mode(mode: Option<&str>, backend: Option<&str>) -> &'static str {
    let shares = shares_checkout(backend);
    match mode {
        Some("multitask") => "multitask",
        _ if shares => "fast",
        _ => "multitask",
    }
}
/// composerSupportsFastMode: the backends whose workers can share a checkout.
/// Shared is unavailable for the rest, as classic disables it.
pub(crate) fn shares_checkout(backend: Option<&str>) -> bool {
    backend.is_none_or(|b| matches!(b, "codex" | "claude" | "fable" | "pi" | "o8"))
}
/// The desktop's model names (formatModelLabel): "gpt-6.1-sol" reads "GPT-6.1 Sol",
/// "claude-opus-5-5" reads "Opus 5.5". Unknown ids pass through.
pub(crate) fn model_label(id: &str) -> String {
    let id = id.rsplit('/').next().unwrap_or(id);
    let title = |word: &str| {
        let mut chars = word.chars();
        chars
            .next()
            .map_or(String::new(), |c| c.to_uppercase().chain(chars).collect())
    };
    let (long, id) = match id.strip_suffix("[1m]") {
        Some(id) => (" (1M)", id),
        None => ("", id),
    };
    let words: Vec<&str> = id
        .split('-')
        .filter(|w| *w != "preview" && !(w.len() == 8 && w.chars().all(|c| c.is_ascii_digit())))
        .collect();
    let label = match words.as_slice() {
        ["gpt", version, "codex"] => format!("Codex {version}"),
        ["gpt", version, rest @ ..] => {
            let rest: Vec<String> = rest.iter().map(|w| title(w)).collect();
            format!("GPT-{version} {}", rest.join(" "))
                .trim_end()
                .to_owned()
        }
        ["claude", family, version @ ..] if !version.is_empty() => {
            format!("{} {}", title(family), version.join("."))
        }
        ["gemini" | "grok", ..] => words.iter().map(|w| title(w)).collect::<Vec<_>>().join(" "),
        _ => return format!("{id}{long}"),
    };
    format!("{label}{long}")
}
pub(crate) fn wire(text: &str, mode: &str) -> String {
    if text.starts_with('/') {
        return text.into();
    }
    let directive = match mode {
        "multitask" => {
            "[Mode: Multitask] Work directly for small tasks and ordinary replies. Delegate only when the user asks or independent work benefits from workers. If delegating, create scoped worker packets in isolated worktrees. Dispatch means calling the `cortex_launch_agent` tool — call it once per packet, in parallel, in this turn, BEFORE you write any summary. A turn with no `cortex_launch_agent` call has dispatched nothing, however good the plan is; never claim work was dispatched without the tool results to show for it. Review and merge through the gate as they finish."
        }
        "fast" => {
            "[Mode: Shared] Work in the current checkout. Work directly for small tasks and ordinary replies. Delegate only when the user asks or independent work benefits from workers; choosing Shared alone does not require a launch. Choose suitable enabled runtimes and models for each task. If delegating, divide independent work by file ownership and call `cortex_launch_agent` once per worker with `checkoutMode: \"shared\"` and non-overlapping relative `assignedPaths`. Each worker edits the same current checkout. Tell them not to commit, reset, stash, or switch branches. Track each surface and resolve overlap before accepting edits. Call `cortex_shared_team_status` to inspect all changed and committed paths, review the combined diff and run checks, then make one orchestrator-owned commit of only your team edits. If independent changes block Finish, review their actual diff and explicitly call `cortex_reconcile_shared_team` with the exact status review ID, HEAD and all review paths; never commit or discard someone else’s work to clear the hold. Finally call `cortex_finish_shared_team` with review and verification receipts to release checkout ownership. Never claim a worker was launched without a tool receipt."
        }
        _ => {
            "[Mode: Solo] Work directly in this session yourself — do NOT dispatch worker agents or create missions. Edit, run, and verify with your own tools."
        }
    };
    format!("{directive}\n\n{text}")
}

#[cfg(test)]
mod mode_tests {
    use super::*;
    #[test]
    fn shared_is_offered_only_where_workers_can_share_a_checkout() {
        assert!(shares_checkout(Some("codex")) && shares_checkout(None));
        assert!(!shares_checkout(Some("openclaw")));
        assert_eq!(visible_mode(Some("fast"), Some("openclaw")), "multitask");
        assert_eq!(visible_mode(Some("solo"), Some("claude")), "fast");
        assert_eq!(visible_mode(Some("multitask"), Some("codex")), "multitask");
    }
}
