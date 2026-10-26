//! Composer-only view state. Routing uses the existing durable queue schema.
use super::Composer;
use gpui::{Entity, FocusHandle};
use serde_json::{Value, json};
use std::collections::HashMap;

pub(crate) struct State {
    pub open: Option<&'static str>,
    pub model: Option<Entity<Composer>>,
    pub busy: bool,
    pub error: String,
    pub overrides: Value,
    pub focus: HashMap<String, FocusHandle>,
    pub images: Vec<Value>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            open: None,
            model: None,
            busy: false,
            error: String::new(),
            overrides: json!({}),
            focus: HashMap::new(),
            images: vec![],
        }
    }
}
pub(crate) fn mode_label(mode: &str) -> &'static str {
    match mode {
        "multitask" => "Worktrees",
        "fast" => "Shared",
        _ => "Solo",
    }
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
