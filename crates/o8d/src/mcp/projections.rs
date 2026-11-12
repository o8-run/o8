use serde_json::{json, Value};
fn array(value: &Value) -> Vec<Value> {
    value.as_array().cloned().unwrap_or_default()
}

pub fn repos(data: Value) -> Value {
    let repos: Vec<Value> = array(&data["repos"])
        .iter()
        .map(|repo| {
            json!({
                "id":repo["id"], "name":repo["name"], "repoPath":repo["localPath"],
                "remoteUrl":repo["remoteUrl"], "defaultBranch":repo["defaultBranch"],
                "exists":repo["exists"], "readiness":repo["readiness"]["state"]
            })
        })
        .collect();
    json!({"count":repos.len(), "repos":repos})
}
pub fn projects(data: Value) -> Value {
    let projects = array(&data["projects"]);
    let concrete = projects.iter().any(|project| project["id"] != "default");
    let projects: Vec<Value> = projects
        .into_iter()
        .filter(|project| !concrete || project["id"] != "default")
        .map(|mut project| {
            let paths = array(&project["repoPaths"]);
            project["active"] = json!(project["id"] == data["activeProjectId"]);
            project["repoCount"] = json!(paths.len());
            project["repoPaths"] = json!(paths);
            project
        })
        .collect();
    json!({"activeProjectId":data["activeProjectId"],"count":projects.len(),"projects":projects})
}
pub fn tasks(data: Value, args: &Value) -> Value {
    let tasks = array(&data["tasks"]);
    let compact: Vec<Value> = tasks
        .iter()
        .map(|task| {
            if args["includeDetails"] == true || args["includeBrief"] == true {
                return task.clone();
            }
            let keys = [
                "id",
                "packetId",
                "laneId",
                "title",
                "group",
                "status",
                "runtime",
                "repoName",
                "branch",
                "queueState",
                "releaseState",
                "blockedReason",
                "lastEventAt",
                "execution",
            ];
            Value::Object(
                keys.iter()
                    .filter_map(|key| task.get(*key).map(|value| ((*key).into(), value.clone())))
                    .collect(),
            )
        })
        .collect();
    let groups = data["groups"]
        .as_object()
        .map(|groups| {
            groups
                .iter()
                .map(|(key, tasks)| {
                    (
                        key.clone(),
                        json!(array(tasks)
                            .iter()
                            .map(|task| task["id"].clone())
                            .collect::<Vec<_>>()),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    json!({"schema":"o8/mcp/task.pool/v1","tasks":compact,"groups":Value::Object(groups),"counts":data["counts"]})
}
pub fn status(data: Value, runtime: Value, snapshot: Value, args: &Value) -> Value {
    let agents = array(&data["agents"]);
    let approvals = if data["approvals"].is_array() {
        array(&data["approvals"])
    } else {
        array(&data["approvals"]["items"])
    };
    let count = data["approvals"]["count"]
        .as_u64()
        .unwrap_or(approvals.len() as u64);
    let recent = array(&data["recentActivity"]);
    let running = agents
        .iter()
        .filter(|agent| {
            matches!(
                agent["status"].as_str(),
                Some("launching" | "running" | "working" | "recovering")
            )
        })
        .count();
    let review = agents
        .iter()
        .filter(|agent| matches!(agent["status"].as_str(), Some("awaiting_review")))
        .count();
    let attention = agents
        .iter()
        .filter(|agent| {
            matches!(
                agent["status"].as_str(),
                Some("blocked" | "failed" | "stale")
            )
        })
        .count();
    let last = if let Some(event) = recent.first() {
        let action = event["action"].as_str().unwrap_or("");
        let target = event["target"]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(|value| format!(" {value}"))
            .unwrap_or_default();
        format!("Last: {action}{target}").trim().to_owned()
    } else if let Some(agent) = agents.first() {
        format!(
            "Last: {} {}",
            agent["name"].as_str().unwrap_or("undefined"),
            agent["status"].as_str().unwrap_or("undefined")
        )
    } else {
        "No recent activity".into()
    };
    let mut pieces = vec![
        format!(
            "{running} agent{} running",
            if running == 1 { "" } else { "s" }
        ),
        format!(
            "{count} approval{} pending",
            if count == 1 { "" } else { "s" }
        ),
    ];
    if review > 0 {
        pieces.push(format!("{review} awaiting review"));
    }
    if attention > 0 {
        pieces.push(format!("{attention} needs attention"));
    }
    pieces.push(last);
    let projected: Vec<Value> = agents
        .into_iter()
        .map(|mut agent| {
            if args["includeEvidence"] != true {
                if let Some(evidence) = agent["statusEvidence"].as_object_mut() {
                    let count = evidence
                        .remove("evidence")
                        .as_ref()
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len);
                    evidence.insert("evidenceCount".into(), json!(count));
                }
            }
            agent
        })
        .collect();
    let mut result = json!({"summary":format!("{}.",pieces.join(". ")),"data":{
        "runtimeConnections":runtime,"snapshot":snapshot,"agents":projected,"approvals":approvals,"approvalCount":count,
        "recentActivity":recent,"spendCapHits":array(&data["spendCapHits"]),
        "terminalReasons":array(&data["terminalReasons"]),"terminalReasonsTruncated":data["terminalReasonsTruncated"] == true
    }});
    if let Some(leads) = data.get("leads") {
        result["data"]["leads"] = leads.clone();
    }
    result
}
