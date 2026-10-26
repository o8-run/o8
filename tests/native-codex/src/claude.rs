use super::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
const MAX_TURNS: usize = 10;
const TURN_TIMEOUT_SECS: u64 = 2;
const FIRST_TURN_MODEL_UNAVAILABLE_PREFIX: &str = "claude first turn model unavailable: ";
const MODEL_UNAVAILABLE_ERROR_PREFIX: &str = "claude model unavailable: ";
const PREMATURE_DONE_NUDGE: &str = "fixture nudge";
#[path = "../../../src-tauri/src/agent/claude/session.rs"]
mod session;
pub(crate) use session::ClaudeSession;
use session::is_model_unavailable_error;
#[path = "../../../src-tauri/src/agent/claude/phone_text.rs"]
mod phone_text;
pub(crate) use phone_text::run_phone_text_loop_with_binary;

fn ensure_empty_mcp_config() -> Result<String, String> {
    let root = std::env::var("O8_DATA_DIR").map_err(|_| "Fixture data directory is required.")?;
    let path = std::path::Path::new(&root).join("empty-mcp.json");
    std::fs::write(&path, "{\"mcpServers\":{}}" ).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
fn looks_like_action_request(_: &str) -> bool {
    false
}
fn say_is_question_or_refusal(_: &str) -> bool {
    false
}
fn extract_action(text: &str) -> Option<Value> {
    serde_json::from_str(text).ok()
}
fn text_tool_result_message(tool: &str, result: &Value) -> String {
    format!("{tool}: {result}")
}
mod planner_payload {
    use super::*;
    pub const TOOL_LOOKUP: &str = "fixture_lookup";
    pub const MAX_TOOL_LOOKUPS: usize = 3;
    pub struct Prompt {
        pub prompt: String,
        pub tool_defs: usize,
    }
    pub fn build_first_prompt(intent: &str, _: &TaskCtx) -> Prompt {
        Prompt {
            prompt: intent.into(),
            tool_defs: 0,
        }
    }
    pub fn requested_lookup_names(_: &Value) -> Vec<String> {
        vec![]
    }
    pub fn lookup_budget_spent_message() -> String {
        "budget spent".into()
    }
    pub fn tool_lookup_message(_: &[String]) -> String {
        "tools".into()
    }
}
pub(crate) trait TextPlannerSession: Send + 'static {
    fn effective_model(&self) -> Option<&str> {
        None
    }
    fn send_planner_turn(&mut self, prompt: &str, image: Option<&str>) -> Result<String, String>;
}
impl TextPlannerSession for ClaudeSession {
    fn send_planner_turn(&mut self, prompt: &str, image: Option<&str>) -> Result<String, String> {
        self.send_turn(prompt, image)
    }
}
pub fn path_with_node_runtime() -> String {
    std::env::var("PATH").unwrap_or_default()
}
#[path = "../../../src-tauri/src/agent/claude/text_loop.rs"]
mod text_loop;
pub(crate) use text_loop::{run_text_planner_loop, run_text_planner_loop_correlated};
