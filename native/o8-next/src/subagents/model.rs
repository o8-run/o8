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
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct DiffStat {
    pub files: u64,
    pub insertions: u64,
    pub deletions: u64,
}
/// A pending approval the worker waits on, from the packet's status evidence.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Approval {
    pub id: String,
    pub text: String,
}
/// What a roster row shows beyond its state: the lane's worktree, what it
/// changed, what it waits on and what it last reported.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Facts {
    pub lane: Option<String>,
    pub branch: Option<String>,
    pub worktree: Option<String>,
    pub diff: Option<DiffStat>,
    pub approval: Option<Approval>,
    pub last_event: Option<String>,
    pub last_event_at: Option<f64>,
    /// The worker's last few distinct reports, oldest first.
    pub recent: Vec<String>,
}
const RECENT: usize = 3;
/// The server reads at most this many diff stats per request.
const STAT_LIMIT: usize = 16;
/// One lane as GET /api/lanes reports it; branch, path and start never change.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Lane {
    pub branch: Option<String>,
    pub path: Option<String>,
    pub created: Option<f64>,
    pub diff: Option<DiffStat>,
    /// Whether the diff stat was asked for, so a lane without one isn't re-read.
    pub stat_read: bool,
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
    pub facts: Facts,
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
            facts: Facts {
                lane: text(&packet["lane"]["laneId"]),
                worktree: text(&packet["lane"]["worktreePath"]),
                approval: approval(&packet["statusEvidence"]),
                last_event: text(&packet["lane"]["lastEventLabel"])
                    .or_else(|| text(&packet["lastEventLabel"])),
                last_event_at: timestamp(&packet["lane"]["lastEventAt"])
                    .or_else(|| timestamp(&packet["lastEventAt"])),
                ..Default::default()
            },
        });
    }
    agents.sort_by(|a, b| a.title.cmp(&b.title).then_with(|| a.id.cmp(&b.id)));
    Ok(agents)
}
/// The approval a packet waits on: the server lists each pending one as
/// `approval:<id>` with `pending · <summary>`.
fn approval(evidence: &Value) -> Option<Approval> {
    evidence["evidence"].as_array()?.iter().find_map(|item| {
        let id = item["source"].as_str()?.strip_prefix("approval:")?;
        let text = item["value"].as_str()?.strip_prefix("pending")?;
        let text = text.trim_start_matches([' ', '·']);
        (!id.is_empty()).then(|| Approval {
            id: id.into(),
            text: crate::text::sanitize(if text.is_empty() {
                evidence["summary"].as_str().unwrap_or("Approval pending")
            } else {
                text
            }),
        })
    })
}
/// The lanes GET /api/lanes returned, by id.
pub(crate) fn lanes(response: &Value, asked: &[String]) -> Result<Vec<(String, Lane)>, String> {
    let lanes = response["lanes"]
        .as_array()
        .ok_or("Lane state is unavailable. Retry to read the worktrees.")?;
    Ok(lanes
        .iter()
        .filter_map(|lane| {
            let id = text(&lane["id"])?;
            let stat = &lane["diffStat"];
            let count = |key: &str| stat[key].as_u64();
            let diff = (|| {
                Some(DiffStat {
                    files: count("files")?,
                    insertions: count("insertions")?,
                    deletions: count("deletions")?,
                })
            })();
            Some((
                id.clone(),
                Lane {
                    branch: text(&lane["branch"]),
                    path: text(&lane["worktreePath"]),
                    created: timestamp(&lane["createdAt"]),
                    diff,
                    stat_read: asked.contains(&id),
                },
            ))
        })
        .collect())
}
/// Carries what earlier reads knew onto a fresh one: each lane's worktree,
/// start and diff stat, and the worker's last few reports.
pub(crate) fn carry(
    old: &[Agent],
    agents: &mut [Agent],
    lanes: &std::collections::HashMap<String, Lane>,
) {
    for agent in agents {
        let before = old.iter().find(|a| a.id == agent.id);
        let mut recent = before.map(|a| a.facts.recent.clone()).unwrap_or_default();
        if let Some(progress) = agent.progress.as_ref().and_then(|p| p.lines().next())
            && recent.last().map(String::as_str) != Some(progress)
        {
            recent.push(progress.to_owned());
        }
        let skip = recent.len().saturating_sub(RECENT);
        recent.drain(..skip);
        agent.facts.recent = recent;
        let Some(lane) = agent.facts.lane.as_ref().and_then(|id| lanes.get(id)) else {
            continue;
        };
        agent.facts.branch = lane.branch.clone();
        if agent.facts.worktree.is_none() {
            agent.facts.worktree = lane.path.clone();
        }
        agent.facts.diff = lane.diff;
        agent.started = agent.started.or(lane.created);
    }
}

pub(crate) struct Snapshot {
    pub packets: Result<Vec<Agent>, String>,
    pub shared: Result<Vec<Agent>, String>,
    /// Lanes read this time; none when every packet's lane was already known.
    pub lanes: Result<Vec<(String, Lane)>, String>,
}
/// Which packet lanes still need a read: unknown ones, and finished ones whose
/// diff stat hasn't been asked for. The second list names those finished lanes.
pub(crate) fn unread(
    agents: &[Agent],
    known: &std::collections::HashMap<String, Lane>,
) -> (Vec<String>, Vec<String>) {
    let mut any = Vec::new();
    let mut stats = Vec::new();
    for agent in agents {
        let Some(id) = &agent.facts.lane else {
            continue;
        };
        let done = agent.group == Group::Done;
        match known.get(id) {
            Some(lane) if lane.stat_read || !done => continue,
            _ if !any.contains(id) => any.push(id.clone()),
            _ => {}
        }
        if done && !stats.contains(id) && stats.len() < STAT_LIMIT {
            stats.push(id.clone());
        }
    }
    (any, stats)
}
pub(crate) fn load(
    client: &crate::client::Client,
    scope: &Scope,
    known: &std::collections::HashMap<String, Lane>,
) -> Snapshot {
    let packets = client
        .get::<Value>("/api/orchestrator/state", &[])
        .and_then(|state| agents(&state, scope));
    // The same lane read the roster's Clean up makes, asked for the finished
    // lanes' diff stats; once known, a lane is not read again.
    let lanes = match packets.as_ref().map(|agents| unread(agents, known)) {
        Ok((wanted, stats)) if !wanted.is_empty() => client
            .get::<Value>(
                "/api/lanes",
                &[("active", "false"), ("diffStat", &stats.join(","))],
            )
            .and_then(|response| lanes(&response, &stats))
            .map(|mut read| {
                // Only the lanes asked about: a known lane keeps its stat.
                read.retain(|(lane, _)| wanted.contains(lane));
                // A lane this caller can't see is known to have nothing to
                // show, rather than read again on every refresh.
                for id in wanted {
                    if !read.iter().any(|(lane, _)| *lane == id) {
                        let stat_read = stats.contains(&id);
                        read.push((
                            id,
                            Lane {
                                stat_read,
                                ..Default::default()
                            },
                        ));
                    }
                }
                read
            }),
        _ => Ok(vec![]),
    };
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
    Snapshot {
        packets,
        shared,
        lanes,
    }
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
                facts: Facts::default(),
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
