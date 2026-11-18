//! Fresh SQLite projection inputs only. This path never calls the cached
//! getRecentLaneEvents equivalent or the runtime steer delivery machinery.
use super::chat_context_json::trim;
use super::*;
use chrono::DateTime;
use rusqlite::OptionalExtension;
#[derive(Clone)]
pub(super) struct Event {
    pub id: String,
    pub verb: String,
    pub actor: String,
    pub payload: Value,
    pub timestamp: String,
    pub millis: i64,
}
fn millis(timestamp: &str) -> Result<i64, ()> {
    // All canonical lane writers emit this fixed-width ISO UTC spelling.
    // It also makes localeCompare and UTF-16 lexical comparisons identical.
    let bytes = timestamp.as_bytes();
    if bytes.len() != 24
        || bytes.iter().enumerate().any(|(i, c)| match i {
            4 | 7 => *c != b'-',
            10 => *c != b'T',
            13 | 16 => *c != b':',
            19 => *c != b'.',
            23 => *c != b'Z',
            _ => !c.is_ascii_digit(),
        })
    {
        return Err(());
    }
    Ok(DateTime::parse_from_rfc3339(timestamp)
        .map_err(|_| ())?
        .timestamp_millis())
}
fn validate(verb: &str, payload: &Value) -> Result<(), ()> {
    let object = payload.as_object().ok_or(())?;
    let allowed: &[&str] = match verb {
        "agent_report" => &["event", "message", "reason", "metadata"],
        "steered_packet" | "steer_failed" => &[
            "packetId",
            "message",
            "text",
            "source",
            "actor",
            "note",
            "error",
            "stderrHead",
            "steerEventId",
            "clientMutationId",
            "deliveryState",
            "sessionKey",
            "stopVersion",
        ],
        "steer_delivery" => &["steerEventId", "state", "note", "ownerPid", "ownerIdentity"],
        "open_lane" => &[
            "projectId",
            "repoPath",
            "branch",
            "baseBranch",
            "baseCommit",
            "baseCommitPinned",
            "runtime",
            "packetId",
            "sessionKey",
        ],
        "attach_session" => &["sessionKey"],
        "detach_session" => &["previousSessionKey"],
        "status_change" => &["status", "eventLabel", "reason"],
        "update" => &[
            "status",
            "outcome",
            "outcomeNote",
            "model",
            "sessionKey",
            "worktreePath",
            "writerToken",
            "label",
            "lastHeartbeatAt",
            "lastEventAt",
            "lastEventLabel",
            "packetId",
            "prNumber",
            "eventLabel",
            "reason",
        ],
        _ => return Err(()),
    };
    for (key, value) in object {
        if !allowed.contains(&key.as_str()) {
            return Err(());
        }
        let valid = match key.as_str() {
            "metadata" | "ownerIdentity" => value.is_null() || value.is_object(),
            "stopVersion" | "ownerPid" | "prNumber" => value.is_null() || value.as_i64().is_some(),
            "baseCommitPinned" => value.is_boolean(),
            _ => value.is_null() || value.is_string(),
        };
        if !valid {
            return Err(());
        }
    }
    if verb == "agent_report" && payload["event"] != "huddle" {
        return Err(());
    }
    if let Some(state) = payload.get("deliveryState").filter(|v| !v.is_null()) {
        if !["queued", "immediate"].iter().any(|s| state == s) {
            return Err(());
        }
    }
    if verb == "steer_delivery"
        && (payload["steerEventId"].as_str().is_none_or(str::is_empty)
            || !["queued", "sending", "delivered", "failed"]
                .iter()
                .any(|s| payload["state"] == *s))
    {
        return Err(());
    }
    Ok(())
}
fn parse(
    id: String,
    verb: String,
    actor: String,
    raw: String,
    timestamp: String,
    budget: &mut usize,
) -> Result<Event, ()> {
    *budget = budget
        .checked_add(raw.len() + id.len() + timestamp.len())
        .ok_or(())?;
    if *budget > RESPONSE_LIMIT
        || id.is_empty()
        || !["user", "orchestrator", "system"].contains(&actor.as_str())
    {
        return Err(());
    }
    let payload = serde_json::from_str(&raw).map_err(|_| ())?;
    validate(&verb, &payload)?;
    let ms = millis(&timestamp)?;
    Ok(Event {
        id,
        verb,
        actor,
        payload,
        timestamp,
        millis: ms,
    })
}
pub(super) fn lane(store: &ReadContext<'_>, key: &str) -> Result<Option<String>, ()> {
    let db = store.database()?;
    // listLanes orders only by created_at ASC before find(sessionKey). Do not
    // invent a tie breaker: equally early matching rows defer as ambiguous.
    let mut statement = db.prepare("SELECT id, created_at FROM lanes WHERE session_key = ? ORDER BY created_at ASC LIMIT 2").map_err(|_| ())?;
    let rows = statement
        .query_map([key], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|_| ())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ())?;
    if rows.len() == 2 && rows[0].1 == rows[1].1 {
        return Err(());
    }
    match rows.first() {
        Some((id, _)) if id.is_empty() => Err(()),
        Some((id, _)) => Ok(Some(id.clone())),
        None => Ok(None),
    }
}
pub(super) struct Inputs {
    pub recent: Vec<Event>,
    pub steers: Vec<Event>,
    pub budget: usize,
}
pub(super) fn load(store: &ReadContext<'_>, lane: &str) -> Result<Inputs, ()> {
    let db = store.database()?;
    let mut budget = 0;
    let mut statement = db.prepare("SELECT id,verb,actor,payload_json,timestamp FROM lane_events WHERE lane_id = ? ORDER BY timestamp DESC LIMIT 500").map_err(|_| ())?;
    let mut rows = statement.query([lane]).map_err(|_| ())?;
    let mut recent = Vec::new();
    while let Some(row) = rows.next().map_err(|_| ())? {
        recent.push(parse(
            row.get(0).map_err(|_| ())?,
            row.get(1).map_err(|_| ())?,
            row.get(2).map_err(|_| ())?,
            row.get(3).map_err(|_| ())?,
            row.get(4).map_err(|_| ())?,
            &mut budget,
        )?);
    }
    recent.reverse();
    // Preserve original intents independently of the recent-event window.
    let mut statement = db.prepare("SELECT id,payload_json,timestamp FROM lane_events WHERE lane_id = ? AND verb = 'steered_packet' AND json_extract(payload_json, '$.deliveryState') = 'queued' ORDER BY rowid DESC LIMIT 100").map_err(|_| ())?;
    let mut rows = statement.query([lane]).map_err(|_| ())?;
    let mut steers = recent.clone();
    let mut positions: HashMap<_, _> = steers
        .iter()
        .enumerate()
        .map(|(i, event)| (event.id.clone(), i))
        .collect();
    while let Some(row) = rows.next().map_err(|_| ())? {
        // The TS queued projection explicitly stamps actor=orchestrator.
        let event = parse(
            row.get(0).map_err(|_| ())?,
            "steered_packet".to_owned(),
            "orchestrator".to_owned(),
            row.get(1).map_err(|_| ())?,
            row.get(2).map_err(|_| ())?,
            &mut budget,
        )?;
        if let Some(index) = positions.get(&event.id) {
            steers[*index] = event;
        } else {
            positions.insert(event.id.clone(), steers.len());
            steers.push(event);
        }
    }
    steers.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
    Ok(Inputs {
        recent,
        steers,
        budget,
    })
}
pub(super) fn receipt(
    store: &ReadContext<'_>,
    lane: &str,
    event: &Event,
    budget: &mut usize,
) -> Result<Option<Value>, ()> {
    if event.payload["deliveryState"] != "queued" {
        return Ok(None);
    }
    // Same persisted receipt_json derived by the TS queue reader: never probe
    // owner liveness, claim work, reconcile a send, or update delivery here.
    let raw: Option<String> = store.database()?.query_row("SELECT payload_json FROM lane_events WHERE lane_id = ? AND verb = 'steer_delivery' AND json_extract(payload_json, '$.steerEventId') = ? ORDER BY rowid DESC LIMIT 1",[lane,&event.id],|r| r.get(0)).optional().map_err(|_| ())?;
    raw.map(|raw| {
        *budget = budget.checked_add(raw.len()).ok_or(())?;
        if *budget > RESPONSE_LIMIT {
            return Err(());
        }
        let value: Value = serde_json::from_str(&raw).map_err(|_| ())?;
        validate("steer_delivery", &value)?;
        Ok(value)
    })
    .transpose()
}
pub(super) fn text(payload: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| payload[*key].as_str().map(trim).filter(|s| !s.is_empty()))
        .unwrap_or("")
        .to_owned()
}
pub(super) fn operator_failure(note: String) -> String {
    // /artifact|admission|accounting/i is an unanchored, non-u JS regex: ASCII
    // folding preserves its semantics, without Unicode normalization.
    let lower = note.to_ascii_lowercase();
    if ["artifact", "admission", "accounting"]
        .iter()
        .any(|s| lower.contains(s))
    {
        "The worker could not start another turn. Inspect its retained session and storage before sending a new message.".to_owned()
    } else {
        note
    }
}
