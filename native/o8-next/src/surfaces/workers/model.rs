use serde_json::Value;

pub const FILTERS: [&str; 3] = ["Working", "Needs review", "Blocked"];
#[derive(Clone, PartialEq)]
pub struct Task {
    pub packet: Value,
    pub lane: Value,
    pub id: String,
    pub filter: usize,
}
impl Task {
    pub fn text(&self, key: &str) -> String {
        text(&self.packet, key)
    }
    pub fn lane_id(&self) -> String {
        text(&self.lane, "id")
    }
    pub fn repo(&self) -> String {
        let path = self.text("workspaceTargetPath");
        path.trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("")
            .to_owned()
    }
    pub fn status(&self) -> &'static str {
        FILTERS[self.filter]
    }
}
pub fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}
/// Render the server-enriched packet status. No native lifecycle reconciliation.
pub fn tasks(state: &Value, lanes: &Value, workspace: &str) -> Vec<Task> {
    state["mission"]["packets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|packet| {
            let lane = lanes["lanes"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|lane| {
                    lane["id"] == packet["lane"]["laneId"] || lane["packetId"] == packet["id"]
                })
                .cloned()
                .unwrap_or(Value::Null);
            let path = packet["workspaceTargetPath"]
                .as_str()
                .or(lane["repoPath"].as_str())
                .unwrap_or_default();
            if !crate::client::same_workspace(path, workspace)
                && !path
                    .strip_prefix(workspace)
                    .is_some_and(|p| p.starts_with('/'))
            {
                return None;
            }
            let status = packet["status"].as_str()?;
            let filter = match status {
                "running" | "launching" | "recovering" | "queued" | "idle" => 0,
                "awaiting_review" => 1,
                "blocked" | "failed" => 2,
                _ => return None,
            };
            if packet["releaseState"] == "released" || packet["archivedAt"].is_string() {
                return None;
            }
            Some(Task {
                id: packet["id"].as_str()?.to_owned(),
                packet: project(
                    packet,
                    &[
                        "id",
                        "referenceLabel",
                        "title",
                        "status",
                        "blockedReason",
                        "workspaceTargetPath",
                        "queueState",
                        "releaseState",
                    ],
                ),
                lane: project(
                    &lane,
                    &["id", "packetId", "repoPath", "worktreePath", "status"],
                ),
                filter,
            })
        })
        .collect()
}

fn project(value: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .map(|key| ((*key).to_owned(), value[*key].clone()))
            .collect(),
    )
}
