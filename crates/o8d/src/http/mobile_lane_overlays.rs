use super::mobile_lane_events::{self as events, Event};
use super::*;
const QUEUED_NOTE: &str = "Queued. o8 will deliver this message when the worker is ready.";
fn failures(events: &[Event]) -> HashMap<String, usize> {
    let intents: Vec<_> = events
        .iter()
        .filter(|e| e.verb == "steered_packet")
        .collect();
    let mut failures = HashMap::new();
    for (index, failure) in events
        .iter()
        .enumerate()
        .filter(|(_, e)| e.verb == "steer_failed")
    {
        let payload = &failure.payload;
        let intent = if payload["steerEventId"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
        {
            intents
                .iter()
                .find(|event| event.id == payload["steerEventId"].as_str().unwrap())
        } else {
            intents.iter().rev().find(|event| {
                if payload["clientMutationId"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
                {
                    event.payload.get("clientMutationId") == payload.get("clientMutationId")
                } else {
                    event.timestamp <= failure.timestamp
                        && event.payload.get("message") == payload.get("message")
                }
            })
        };
        if let Some(intent) = intent {
            failures.insert(intent.id.clone(), index);
        }
    }
    failures
}
fn entry(id: String, role: &str, text: String, ms: i64, label: String) -> Value {
    json!({"id":id,"role":role,"text":text,"timestamp":ms,"timestampLabel":label})
}
pub(super) fn merge(
    store: &ReadContext<'_>,
    lane: &str,
    transcript: Vec<Value>,
) -> Result<Vec<Value>, ()> {
    let mut inputs = events::load(store, lane)?;
    let mut extra = Vec::new();
    for (index, event) in inputs
        .recent
        .iter()
        .filter(|e| e.verb == "agent_report" && e.payload["event"] == "huddle")
        .enumerate()
    {
        let message = events::text(&event.payload, &["message"]);
        let message = if message.is_empty() {
            "Huddle plan posted."
        } else {
            &message
        };
        extra.push(entry(
            format!("huddle-{}", index + 1),
            "assistant",
            format!("Huddling — plan posted\n\n{message}"),
            event.millis,
            mobile_history::time_label(event.millis)?,
        ));
    }
    let failures = failures(&inputs.steers);
    let mut seq = 0;
    for event in inputs.steers.iter().filter(|e| {
        e.verb == "steered_packet"
            || (e.verb == "steer_failed"
                && !failures.values().any(|&i| inputs.steers[i].id == e.id))
    }) {
        seq += 1;
        let mut source = events::text(&event.payload, &["source", "actor"]);
        if source.is_empty() {
            source = event.actor.clone();
        }
        let text = events::text(&event.payload, &["message", "text"]);
        let receipt = events::receipt(store, lane, event, &mut inputs.budget)?;
        let failure = failures.get(&event.id).map(|&i| &inputs.steers[i]);
        let failed = event.verb == "steer_failed"
            || receipt.as_ref().is_some_and(|r| r["state"] == "failed")
            || failure.is_some();
        let note = if let Some(note) = receipt
            .as_ref()
            .and_then(|r| r.get("note"))
            .filter(|v| !v.is_null())
        {
            note.as_str().ok_or(())?.to_owned()
        } else if event.payload["deliveryState"] == "queued" {
            QUEUED_NOTE.to_owned()
        } else {
            let payload = failure.map_or(&event.payload, |f| &f.payload);
            [
                events::text(payload, &["note", "error"]),
                events::text(payload, &["stderrHead"]),
            ]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
        };
        let note = events::operator_failure(note);
        let text = if !text.is_empty() {
            text
        } else if !note.is_empty() {
            note.clone()
        } else {
            "Steer requested.".to_owned()
        };
        let label = mobile_history::time_label(event.millis)?;
        let suffix = if !note.is_empty() && note != text {
            format!("\n\n{note}")
        } else {
            String::new()
        };
        extra.push(entry(
            format!("steer-{seq}"),
            "user",
            format!(
                "{} · {label}\n\n{text}{suffix}",
                if failed {
                    "Steer failed to start"
                } else {
                    &source
                }
            ),
            event.millis,
            label,
        ));
    }
    if extra.is_empty() {
        return Ok(transcript);
    }
    let mut merged = Vec::new();
    let mut positions = HashMap::new();
    // JS Map distinguishes missing and null ids. Last value wins without
    // changing the first insertion position used to break timestamp ties.
    for row in transcript.into_iter().chain(extra) {
        let key = match row.get("id") {
            None => (0, String::new()),
            Some(Value::Null) => (1, String::new()),
            Some(Value::String(id)) => (2, id.clone()),
            _ => return Err(()),
        };
        if let Some(&index) = positions.get(&key) {
            merged[index] = row;
        } else {
            positions.insert(key, merged.len());
            merged.push(row);
        }
    }
    let timestamp = |row: &Value| row["timestamp"].as_f64().filter(|n| n.is_finite());
    merged.sort_by(|a, b| match (timestamp(a), timestamp(b)) {
        (Some(a), Some(b)) => a.partial_cmp(&b).unwrap(),
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Less,
        (Some(_), None) => std::cmp::Ordering::Greater,
    });
    Ok(merged)
}
