use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Scope {
    pub repo: String,
    pub parent: Option<String>,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Group {
    Working,
    Attention,
    Done,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Worktree {
    pub lane: String,
    pub path: String,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Agent {
    pub shared: bool,
    /// Read from the house's own delegate call in the transcript, with no packet.
    pub native: bool,
    pub cleanup: Option<Worktree>,
    pub prompt: Option<String>,
    pub run: String,
    pub id: String,
    pub title: String,
    pub runtime: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub parent: Option<String>,
    pub session: Option<String>,
    pub group: Group,
    pub status: String,
    pub progress: Option<String>,
    pub result: Option<String>,
    pub started: Option<f64>,
    pub finished: Option<f64>,
}
fn text(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(crate::text::sanitize)
}
fn key(value: &str) -> &str {
    value.strip_prefix("llm-chat:").unwrap_or(value)
}
fn timestamp(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| crate::clock::timestamp(value.as_str()?).map(|seconds| seconds as f64 * 1000.))
}
pub(crate) fn agents(state: &Value, scope: &Scope) -> Result<Vec<Agent>, String> {
    let packets = state["mission"]["packets"]
        .as_array()
        .ok_or("Subagent state is unavailable. Retry to read the current work.")?;
    let mut agents = Vec::new();
    for packet in packets {
        let parent = text(&packet["orchestratorThreadId"])
            .or_else(|| text(&packet["launchContext"]["parentThreadId"]));
        if scope
            .parent
            .as_ref()
            .is_some_and(|p| parent.as_ref().is_none_or(|a| key(a) != key(p)))
        {
            continue;
        }
        let path = packet["workspaceTargetPath"]
            .as_str()
            .or(packet["lane"]["repoPath"].as_str());
        if !path.is_some_and(|path| crate::client::same_workspace(path, &scope.repo)) {
            continue;
        }
        let Some(id) = text(&packet["id"]) else {
            continue;
        };
        let status = packet["status"].as_str().unwrap_or("unknown");
        let (group, label) = match status {
            "running" => (Group::Working, "Working"),
            "launching" => (Group::Working, "Starting"),
            "recovering" => (Group::Working, "Recovering"),
            "released" => (Group::Done, "Done"),
            "awaiting_review" => (Group::Attention, "Needs review"),
            "blocked" => (Group::Attention, "Blocked"),
            "failed" => (Group::Attention, "Failed"),
            "queued" | "draft" => (Group::Attention, "Queued"),
            "archived" => (Group::Attention, "Archived"),
            "idle" => (Group::Attention, "Idle"),
            _ => (Group::Attention, "Status unavailable"),
        };
        let inventory = state["agents"].as_array().into_iter().flatten().find(|a| {
            a["sessionKey"] == packet["lane"]["sessionKey"] && a["sessionKey"].is_string()
        });
        let started = inventory.and_then(|a| timestamp(&a["startedAt"]));
        agents.push(Agent {
            shared: false,
            native: false,
            cleanup: (group == Group::Done)
                .then(|| {
                    Some(Worktree {
                        lane: text(&packet["lane"]["laneId"])?,
                        path: text(&packet["lane"]["worktreePath"])?,
                    })
                })
                .flatten(),
            prompt: None,
            run: format!(
                "{}:{}:{}",
                packet["lane"]["sessionKey"],
                packet["attemptCount"],
                packet["storageAdmissionEpoch"]
            ),
            id,
            title: text(&packet["title"]).unwrap_or_else(|| "Subagent".into()),
            parent,
            runtime: text(&packet["runtime"]).unwrap_or_default(),
            model: text(&packet["model"])
                .or_else(|| text(&packet["workerRouting"]["selectedModel"])),
            effort: text(&packet["workerRouting"]["selectedEffort"]),
            session: text(&packet["lane"]["sessionKey"]),
            group,
            status: label.into(),
            progress: text(&packet["blockedReason"])
                .or_else(|| text(&packet["lastEventLabel"]))
                .or_else(|| text(&packet["lane"]["lastEventLabel"])),
            result: text(&packet["completionSummary"]),
            started,
            finished: (group == Group::Done)
                .then(|| {
                    timestamp(&packet["releaseStatePayload"]["releasedAt"])
                        .or_else(|| timestamp(&packet["lastEventAt"]))
                })
                .flatten(),
        });
    }
    agents.sort_by(|a, b| a.title.cmp(&b.title).then_with(|| a.id.cmp(&b.id)));
    Ok(agents)
}

pub(crate) struct Snapshot {
    pub packets: Result<Vec<Agent>, String>,
    pub shared: Result<Vec<Agent>, String>,
}
pub(crate) fn load(client: &crate::client::Client, scope: &Scope) -> Snapshot {
    let packets = client
        .get::<Value>("/api/orchestrator/state", &[])
        .and_then(|state| agents(&state, scope));
    let shared = (|| {
        let route = "/api/orchestrator/shared-team/active";
        let parent = if let Some(parent) = &scope.parent {
            let parent = key(parent);
            if !parent.starts_with("thoughts-") {
                return Ok(vec![]);
            }
            parent.to_string()
        } else {
            let active: Value = client.get(route, &[("repoPath", &scope.repo)])?;
            let Some(parent) = active["team"]["parentThreadId"].as_str() else {
                return Ok(vec![]);
            };
            parent.to_string()
        };
        let response: Value =
            client.get(route, &[("repoPath", &scope.repo), ("threadId", &parent)])?;
        shared_agents(&response, &parent)
    })();
    Snapshot { packets, shared }
}
fn shared_agents(response: &Value, parent: &str) -> Result<Vec<Agent>, String> {
    if response["threadId"] != parent {
        return Err("Shared agent context changed. Refresh before inspecting it.".into());
    }
    response["workers"]
        .as_array()
        .ok_or("Shared agents are unavailable".to_string())?
        .iter()
        .filter_map(|worker| {
            let session = text(&worker["sessionKey"])?;
            let (mut group, mut status) = match worker["status"].as_str().unwrap_or("unknown") {
                "running" => (Group::Working, "Working"),
                "completed" => (Group::Done, "Done"),
                "failed" => (Group::Attention, "Failed"),
                "interrupted" => (Group::Attention, "Interrupted"),
                "idle" => (Group::Attention, "Idle"),
                "retired" => (Group::Attention, "Retired"),
                _ => (Group::Attention, "Status unavailable"),
            };
            if worker["returnStatus"] == "held" {
                group = Group::Attention;
                status = "Result needs attention";
            }
            Some(Ok(Agent {
                shared: true,
                native: false,
                cleanup: None,
                prompt: None,
                run: worker["recovery"]["runId"].as_str().unwrap_or("").into(),
                id: session.clone(),
                session: Some(session),
                parent: Some(parent.into()),
                title: text(&worker["name"]).unwrap_or_else(|| "Subagent".into()),
                runtime: text(&worker["runtime"]).unwrap_or_default(),
                model: text(&worker["model"]),
                effort: text(&worker["effort"]),
                group,
                status: status.into(),
                progress: text(&worker["returnReason"]),
                result: None,
                started: None,
                finished: None,
            }))
        })
        .collect()
}
pub(crate) fn summary(agents: &[Agent]) -> String {
    [
        (Group::Working, "working"),
        (Group::Attention, "need attention"),
        (Group::Done, "done"),
    ]
    .iter()
    .filter_map(|(group, label)| {
        let n = agents.iter().filter(|a| a.group == *group).count();
        (n > 0).then(|| format!("{n} {label}"))
    })
    .collect::<Vec<_>>()
    .join(" · ")
}

/// Explicit packet/session references returned by delegation tools. Tool success
/// means the launch returned, never that the worker finished.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Reference {
    pub id: String,
    pub title: String,
}
pub(crate) fn references(name: &str, tool: &Value) -> Vec<Reference> {
    if !matches!(
        name,
        "create_mission"
            | "dispatch_mission"
            | "delegate_task"
            | "launch_agent"
            | "cortex_launch_agent"
    ) {
        return vec![];
    }
    let result = tool["result"]
        .as_str()
        .and_then(|v| serde_json::from_str::<Value>(v).ok())
        .unwrap_or_else(|| tool["result"].clone());
    let values: Vec<&Value> = result["packets"]
        .as_array()
        .or(result["mission"]["packets"].as_array())
        .map(|a| a.iter().collect())
        .unwrap_or_else(|| vec![&result]);
    values
        .into_iter()
        .filter_map(|value| {
            let id = text(&value["packetId"])
                .or_else(|| text(&value["surfaceId"]))
                .or_else(|| text(&value["id"]))?;
            let title = text(&value["title"])
                .or_else(|| text(&tool["args"]["title"]))
                .or_else(|| text(&tool["args"]["taskName"]))
                .unwrap_or_else(|| "Subagent".into());
            Some(Reference { id, title })
        })
        .collect()
}
