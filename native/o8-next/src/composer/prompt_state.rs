//! Per-draft composer controls. Repository/branch choices are advisory until send.
use super::*;
use serde_json::Value;
#[derive(Default)]
pub(crate) struct State {
    pub view: Option<AnyView>,
    pub repo: Option<String>,
    pub branch: String,
    pub branch_base: String,
    pub scroll: ScrollHandle,
    pub anchors: std::collections::HashMap<&'static str, Bounds<Pixels>>,
    pub rows: Vec<Value>,
    pub loading: bool,
    pub error: String,
    pub query: Option<Entity<Composer>>,
    pub fields: Vec<Entity<Composer>>,
    pub selected: usize,
    pub generation: u64,
    pub opened: Option<std::time::Instant>,
    pub store: Option<std::path::PathBuf>,
    pub scope: bool,
    pub result: String,
    pub last_query: String,
    pub query_subscription: Option<Subscription>,
    pub feedback: String,
    pub remove_rule: Option<String>,
    pub expanded_tiers: std::collections::BTreeSet<String>,
    pub prelude: String,
    pub queued_prelude: Option<(String, String)>,
    pub command_wire: Option<(String, String)>,
}
