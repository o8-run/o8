//! Bounded native harness: production transport, planner control flow and terminal serialization.
//! Desktop tools, prompt construction and machine identity are stubbed; no model calls.
#![allow(dead_code)]
static DATA_DIR_ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
#[path = "../../../src-tauri/src/models.rs"]
mod models;
#[derive(Clone)]
struct ConfirmCorrelation;
struct LoopResult {
    result_text: String,
    model_used: String,
    tool_calls_json: String,
    brain_sources: Vec<serde_json::Value>,
}
#[derive(Default)]
struct TaskCtx {
    task_id: String,
    app: Option<()>,
    screen: Option<Screen>,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
struct Screen {
    png_base64: String,
}
impl TaskCtx {
    fn is_cancelled(&self) -> bool {
        self.cancel.load(std::sync::atomic::Ordering::SeqCst)
    }
}
mod machine {
    #[derive(serde::Serialize)]
    pub struct MachineIdentity;
}
fn speak_filler_now() {}
fn emit_agent_event(_: &(), _: serde_json::Value) {}
async fn execute_text_tool_call(
    ctx: &TaskCtx,
    tool: &str,
    _: serde_json::Value,
    _: ConfirmCorrelation,
) -> serde_json::Value {
    if tool == "fixture_interrupt" {
        ctx.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    serde_json::json!({ "ok": true })
}
async fn execute_cascaded_tool_call(
    _: &TaskCtx,
    _: &str,
    _: serde_json::Value,
    _: &mut bool,
) -> serde_json::Value {
    unreachable!("bound tests use the correlated tool seam")
}
mod claude;
#[path = "../../../src-tauri/src/agent/codex.rs"]
mod codex;
#[path = "../../../src-tauri/src/agent/text_turn.rs"]
mod text_turn;

mod cli_locate {
    pub fn resolve_binary(_: &str, overrides: &[&str]) -> Option<String> {
        overrides.iter().find_map(|name| std::env::var(name).ok())
    }
}
fn agent_data_dir() -> std::path::PathBuf {
    panic!("use injected routing in harness")
}
mod front_brain {
    #[derive(Default, serde::Serialize)]
    pub struct SymonFrontBrainState;
    pub fn state() -> SymonFrontBrainState {
        SymonFrontBrainState
    }
}
#[path = "../../../src-tauri/src/agent/planner_route.rs"]
mod planner_route;

#[cfg(test)]
mod terminal_tests;
#[cfg(all(test, unix))]
mod phone_effort_tests;
