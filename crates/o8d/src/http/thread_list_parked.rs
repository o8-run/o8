//! Verified parked-workspace membership from durable snapshot, lane and packet
//! records. Unsupported normalization or corrupt proof defers the whole stage.
use super::*;
use sha2::{Digest, Sha256};
use thread_list::{file, trimmed, truthy};
use thread_list_projection::{key, rows, subject};
fn number(v: &Value) -> Result<i64, ()> {
    v.as_i64()
        .filter(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
        .ok_or(())
}
fn parse(v: &Value) -> ReadResult {
    serde_json::from_str(v.as_str().ok_or(())?).map_err(|_| ())
}
fn hash(v: &Value) -> Result<String, ()> {
    Ok(format!(
        "{:x}",
        Sha256::digest(chat_context_json::canonical(v)?.as_bytes())
    ))
}
fn safe_error(v: &Value) -> Result<Value, ()> {
    if v.is_null() {
        return Ok(Value::Null);
    }
    let p = parse(v)?;
    if !p.is_object()
        || !["code", "message", "phase"]
            .iter()
            .all(|f| p[f].is_string())
    {
        return Err(());
    }
    number(&p["recordedAt"])?;
    Ok(p)
}
fn chain(row: &Value, receipts: &[Value], fingerprint: &str) -> Result<(), ()> {
    let first = receipts.first().ok_or(())?;
    if first["transition_kind"] != "created"
        || first["snapshot_generation"] != 1
        || !first["from_state"].is_null()
        || first["to_state"] != "materialized"
        || first["prior_version"] != 0
        || first["resulting_version"] != 1
        || !first["error_json"].is_null()
        || first["recorded_at"] != row["created_at"]
        || (row["snapshot_generation"] == 1 && first["snapshot_fingerprint"] != fingerprint)
    {
        return Err(());
    }
    let mut state = "materialized".to_owned();
    let mut version = 1;
    let mut recorded = number(&first["recorded_at"])?;
    let mut entered = recorded;
    let generation = 1;
    let prior_hash = first["snapshot_fingerprint"].as_str().ok_or(())?.to_owned();
    for receipt in &receipts[1..] {
        let from = receipt["from_state"].as_str().ok_or(())?;
        let to = receipt["to_state"].as_str().ok_or(())?;
        let at = number(&receipt["recorded_at"])?;
        if from != state
            || number(&receipt["prior_version"])? != version
            || number(&receipt["resulting_version"])? != version + 1
            || at < recorded
            || at < number(&receipt["transition_started_at"])?
        {
            return Err(());
        }
        if receipt["transition_kind"] == "created" {
            // Generation anchors hash JSON.stringify(previousSnapshot) in its
            // original insertion order. The local decoder does not retain that
            // order, so superseded generations stay with the canonical reader.
            return Err(());
        } else if receipt["transition_kind"] == "transition" {
            if receipt["snapshot_generation"] != generation
                || receipt["snapshot_fingerprint"] != prior_hash
            {
                return Err(());
            }
            let allowed = match from {
                "materialized" => ["parkable", "retiring"].contains(&to),
                "parkable" => ["materialized", "hibernating"].contains(&to),
                "hibernating" => ["materialized", "parked"].contains(&to),
                "parked" => to == "restoring",
                "restoring" => ["materialized", "parked"].contains(&to),
                "retiring" => ["materialized", "retired"].contains(&to),
                "retired" => false,
                _ => return Err(()),
            };
            if (from == to && receipt["error_json"].is_null()) || (from != to && !allowed) {
                return Err(());
            }
            if from != to {
                entered = at;
            }
        } else {
            return Err(());
        }
        state = to.to_owned();
        version += 1;
        recorded = at;
    }
    let last = receipts.last().ok_or(())?;
    let error = safe_error(&last["error_json"])?;
    let error_at = if error.is_null() {
        Value::Null
    } else {
        error["recordedAt"].clone()
    };
    if receipts.len() as i64 != number(&row["record_version"])?
        || row["state"] != state
        || row["record_version"] != version
        || row["snapshot_generation"] != generation
        || row["snapshot_fingerprint"] != prior_hash
        || prior_hash != fingerprint
        || row["last_transition_id"] != last["transition_id"]
        || row["transition_started_at"] != last["transition_started_at"]
        || row["state_entered_at"] != entered
        || row["updated_at"] != recorded
        || row["last_error_json"] != last["error_json"]
        || row["last_error_at"] != error_at
    {
        return Err(());
    }
    Ok(())
}
fn snapshot(row: &Value, receipts: &[Value]) -> ReadResult {
    let identities = parse(&row["session_identity_json"])?;
    let identities=identities.as_array().ok_or(())?.iter().map(|v| {
        if !v.is_object() || !v["kind"].is_string() || !v["identity"].is_string() { return Err(()); }
        Ok(json!({"kind":v["kind"],"identity":v["identity"],"runtime":if v["runtime"].is_string(){v["runtime"].clone()}else{Value::Null},"bindingId":if v["bindingId"].is_string(){v["bindingId"].clone()}else{Value::Null}}))
    }).collect::<Result<Vec<_>,_>>()?;
    let reservation = if !truthy(&row["reservation_json"]) {
        Value::Null
    } else {
        let p = parse(&row["reservation_json"])?;
        number(&p["bytes"])?;
        number(&p["reservedAt"])?;
        if !p["id"].is_string() {
            return Err(());
        }
        json!({"id":p["id"],"bytes":p["bytes"],"reservedAt":p["reservedAt"],"volumeId":if p["volumeId"].is_string(){p["volumeId"].clone()}else{Value::Null}})
    };
    let mut truth = json!({"sessionIdentities":identities,"reservation":reservation});
    for (field, column) in [
        ("repositoryUuid", "repository_uuid"),
        ("packetId", "packet_id"),
        ("missionId", "mission_id"),
        ("laneId", "lane_id"),
        ("originalPath", "original_path"),
        ("branch", "branch"),
        ("baseCommit", "base_commit"),
        ("headCommit", "head_commit"),
        ("treeSha", "tree_sha"),
        ("recoveryRef", "recovery_ref"),
        ("diffFingerprint", "diff_fingerprint"),
        ("dependencyRecipeKey", "dependency_recipe_key"),
    ] {
        truth[field] = row[column].clone();
    }
    let fingerprint = hash(&truth)?;
    if row["snapshot_fingerprint"] != fingerprint {
        return Err(());
    }
    chain(row, receipts, &fingerprint)?;
    safe_error(&row["last_error_json"])?;
    truth["state"] = row["state"].clone();
    Ok(truth)
}
fn packets(mission: &Value) -> Result<Vec<Value>, ()> {
    let packets = mission["packets"].as_array().ok_or(())?;
    let mut seen = std::collections::HashSet::new();
    for packet in packets {
        let id = trimmed(&packet["id"]);
        let id = id.as_str().ok_or(())?;
        if !seen.insert(id.to_owned())
            || !packet["branchTarget"].is_string()
            || (!packet["workspaceTargetPath"].is_null()
                && !packet["workspaceTargetPath"].is_string())
            || packet.get("mergeHold").is_some_and(|v| !v.is_boolean())
        {
            return Err(());
        }
        for field in ["reviewSource", "repairSource"] {
            let source = &packet[field];
            if !source.is_null()
                && !(number(&source["pullRequest"]).is_ok_and(|n| n > 0)
                    && source["headSha"].as_str().is_some_and(|s| {
                        [40, 64].contains(&s.len())
                            && s.bytes()
                                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    }))
            {
                return Err(());
            }
        }
    }
    let mut normalized = packets.clone();
    for p in &mut normalized {
        p["id"] = trimmed(&p["id"]);
        p["projectId"] = trimmed(&p["projectId"]);
        if trimmed(&p["workspaceTargetPath"]).is_null() {
            p["workspaceTargetPath"] = Value::Null;
        }
        p["orchestratorThreadId"] = trimmed(&p["orchestratorThreadId"]);
        let c = &p["launchContext"];
        let valid = ["desktop", "cli", "mcp", "agent"]
            .contains(&c["source"].as_str().unwrap_or(""))
            && ["tab", "split"].contains(&c["presentation"].as_str().unwrap_or(""))
            && ["registered", "transient"].contains(&c["repoContext"].as_str().unwrap_or(""))
            && (c.get("workMode").is_none()
                || ["edit", "read-only"].contains(&c["workMode"].as_str().unwrap_or("")));
        let parent = if valid {
            trimmed(&c["parentThreadId"])
        } else {
            Value::Null
        };
        let parent = parent
            .as_str()
            .map(|s| {
                String::from_utf16(&s.encode_utf16().take(200).collect::<Vec<_>>()).map_err(|_| ())
            })
            .transpose()?;
        p["launchContext"] = json!({"parentThreadId":parent});
    }
    Ok(normalized)
}
fn release(packet: &Value) -> bool {
    let p = &packet["releaseStatePayload"];
    let source = trimmed(&p["source"]);
    let kind = trimmed(&p["evidenceKind"]);
    match source.as_str().unwrap_or("") {
        "read_only_completed" => kind.is_null() || kind == "read_only_no_merge_required",
        "headless_released" => {
            kind == "pull_request_merged"
                && !trimmed(&p["mergeCommit"]).is_null()
                && !trimmed(&p["headSha"]).is_null()
        }
        "approve_and_merge" | "heal_bot_auto_release" | "merged_by_ancestry_reconcile" => {
            !trimmed(&p["mergeCommit"]).is_null()
        }
        _ => false,
    }
}
fn resolved(v: &Value) -> Result<PathBuf, ()> {
    Ok(thread_context::resolve(Path::new(v.as_str().ok_or(())?)))
}
pub(super) fn context(
    store: &ReadContext<'_>,
    db: &Connection,
) -> Result<HashMap<String, Vec<Value>>, ()> {
    let snapshots=rows(db,"SELECT * FROM workspace_snapshots WHERE state = 'parked' ORDER BY repository_uuid,packet_id",&[])?;
    let mut result = HashMap::<String, Vec<Value>>::new();
    if snapshots.is_empty() {
        return Ok(result);
    }
    // Validate all immutable rows before counting packet membership. A corrupt
    // second receipt must not turn a valid parked checkout into a false absence.
    let mut verified = Vec::new();
    for row in snapshots {
        let receipts=rows(db,"SELECT * FROM workspace_snapshot_transitions WHERE repository_uuid=? AND packet_id=? ORDER BY resulting_version ASC,transition_id ASC",&[row["repository_uuid"].as_str().ok_or(())?,row["packet_id"].as_str().ok_or(())?])?;
        let snapshot = snapshot(&row, &receipts)?;
        verified.push((row, snapshot, receipts));
    }
    let mut canonical = Vec::<Value>::new();
    for row in rows(
        db,
        "SELECT mission_state_json FROM missions ORDER BY created_at ASC",
        &[],
    )? {
        // Registry rows with no snapshot are omitted, even in the strict reader.
        if !truthy(&row["mission_state_json"])
            || row["mission_state_json"]
                .as_str()
                .is_some_and(|s| s.trim().is_empty())
        {
            continue;
        }
        for p in packets(&parse(&row["mission_state_json"])?)? {
            if let Some(i) = canonical
                .iter()
                .position(|v| trimmed(&v["id"]) == trimmed(&p["id"]))
            {
                canonical[i] = p;
            } else {
                canonical.push(p);
            }
        }
    }
    if let Some(current) = file(store, &store.directory.join("orchestrator-state.json"))? {
        for p in packets(&current["mission"])? {
            if let Some(i) = canonical
                .iter()
                .position(|v| trimmed(&v["id"]) == trimmed(&p["id"]))
            {
                canonical[i] = p;
            } else {
                canonical.push(p);
            }
        }
    }
    let packet_ids = verified
        .iter()
        .filter_map(|(row, _, _)| row["packet_id"].as_str())
        .filter(|id| canonical.iter().any(|p| p["id"] == *id))
        .collect::<std::collections::HashSet<_>>();
    let lanes = rows(db, "SELECT * FROM lanes ORDER BY created_at ASC", &[])?;
    for (row, snapshot, receipts) in &verified {
        let packet_id = row["packet_id"].as_str().ok_or(())?;
        if verified
            .iter()
            .filter(|(r, _, _)| r["packet_id"] == packet_id)
            .count()
            != 1
        {
            continue;
        }
        let Some(packet) = canonical.iter().find(|p| trimmed(&p["id"]) == packet_id) else {
            continue;
        };
        let Some(lane) = lanes.iter().find(|l| l["id"] == snapshot["laneId"]) else {
            continue;
        };
        let binding = &packet["lane"];
        if !binding["tileId"].is_string() || !binding["tabId"].is_string() {
            continue;
        }
        if lane["status"] != "completed"
            || lane["ownership"] != "managed"
            || !truthy(&lane["session_key"])
            || packet["status"] != "released"
            || packet["releaseState"] != "released"
            || !release(packet)
            || packet["queueState"] != "held"
            || binding["laneId"] != lane["id"]
            || binding["sessionKey"] != lane["session_key"]
            || !truthy(&binding["worktreePath"])
            || !truthy(&binding["repoPath"])
        {
            continue;
        }
        if resolved(&binding["repoPath"])? != resolved(&lane["repo_path"])?
            || (!lane["worktree_path"].is_null()
                && resolved(&binding["worktreePath"])? != resolved(&lane["worktree_path"])?)
            || resolved(&snapshot["originalPath"])? != resolved(&binding["worktreePath"])?
            || snapshot["branch"] != lane["branch"]
            || !snapshot["sessionIdentities"]
                .as_array()
                .ok_or(())?
                .iter()
                .any(|v| v["kind"] == "owned-session" && v["identity"] == lane["session_key"])
        {
            continue;
        }
        let head = trimmed(&packet["releaseStatePayload"]["headSha"]);
        if !head.is_null() && head != snapshot["headCommit"] {
            continue;
        }
        // runtimeInboxIdentity chooses the newest matching lane among parked
        // packet candidates. Equal ordering is conservatively deferred.
        let mut matching = lanes
            .iter()
            .filter(|l| {
                l["session_key"] == lane["session_key"]
                    && l["packet_id"]
                        .as_str()
                        .is_some_and(|id| packet_ids.contains(id))
            })
            .collect::<Vec<_>>();
        matching.sort_by(|a, b| {
            b["created_at"]
                .as_str()
                .cmp(&a["created_at"].as_str())
                .then_with(|| b["updated_at"].as_str().cmp(&a["updated_at"].as_str()))
        });
        if matching.len() > 1
            && matching[0]["created_at"] == matching[1]["created_at"]
            && matching[0]["updated_at"] == matching[1]["updated_at"]
        {
            return Err(());
        }
        let lane = matching.first().ok_or(())?;
        let Some(parent_packet) = canonical.iter().find(|p| p["id"] == lane["packet_id"]) else {
            continue;
        };
        let parent = trimmed(&parent_packet["orchestratorThreadId"]);
        let parent = if parent.is_null() {
            trimmed(&parent_packet["launchContext"]["parentThreadId"])
        } else {
            parent
        };
        let subject = if let Some(parent) = parent.as_str() {
            let history = chat_context::read(store, parent)?;
            let repo = history
                .get("repoPath")
                .filter(|v| !v.is_null())
                .or_else(|| {
                    parent_packet
                        .get("workspaceTargetPath")
                        .filter(|v| !v.is_null())
                })
                .unwrap_or(&lane["repo_path"]);
            subject(&json!(parent), repo, &history["projectId"])
        } else {
            let workspace = resolved(&lane["repo_path"])?;
            json!({"kind":"runtime","id":lane["session_key"],"workspace":workspace,"projectId":trimmed(&lane["project_id"])})
        };
        let parked = receipts.iter().rev().find(|r| {
            r["to_state"] == "parked"
                && r["from_state"] == "hibernating"
                && r["snapshot_generation"] == row["snapshot_generation"]
        });
        let bytes = parked
            .and_then(|r| parse(&r["receipt_json"]).ok())
            .and_then(|v| v["reclaimedAvailableBytes"].as_i64())
            .filter(|n| n.unsigned_abs() <= 9_007_199_254_740_991);
        result.entry(key(&subject)).or_default().push(json!({"packetId":packet_id,"repositoryUuid":snapshot["repositoryUuid"],"reclaimedAvailableBytes":bytes}));
    }
    Ok(result)
}
