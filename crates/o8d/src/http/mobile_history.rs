//! Ordinary phone transcripts. Live network/card admission and every writer
//! stay with Node; lane overlays and uncertain shapes always defer.
use super::chat_context_json::trim;
use super::*;
use chrono::{DateTime, Local, Utc};
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn clock(message: &Value) -> Result<Value, ()> {
    if let Some(label) = message.get("timestampLabel").filter(|v| !v.is_null()) {
        return Ok(label.clone());
    }
    let timestamp = &message["timestamp"];
    if !truthy(timestamp) {
        return Ok(json!(""));
    }
    let number = timestamp
        .as_f64()
        .filter(|n| n.is_finite() && n.abs() <= 8.64e15)
        .ok_or(())?;
    let date = DateTime::<Utc>::from_timestamp_millis(number.trunc() as i64).ok_or(())?;
    Ok(json!(date
        .with_timezone(&Local)
        .format("%-I:%M %p")
        .to_string()))
}
fn valid(message: &Value) -> bool {
    message.is_object()
        && message["role"]
            .as_str()
            .is_some_and(|s| ["user", "assistant", "system", "tool"].contains(&s))
        && message["content"].is_string()
        && message
            .get("id")
            .is_none_or(|v| v.is_null() || v.is_string())
        && message.get("toolCalls").is_none_or(|tools| {
            tools.is_null()
                || tools.as_array().is_some_and(|tools| {
                    tools.iter().all(|tool| {
                        tool.is_object()
                            && tool["name"].is_string()
                            && tool
                                .get("args")
                                .is_none_or(|v| v.is_null() || v.is_object())
                            && tool.get("status").is_none_or(|v| {
                                v.is_null()
                                    || v.as_str().is_some_and(|s| {
                                        ["calling", "running", "done", "error", "stopped"]
                                            .contains(&s)
                                    })
                            })
                    })
                })
        })
        && message
            .get("receipt")
            .is_none_or(|v| v.is_null() || v.is_object())
}
fn workers(value: &Value) -> Result<&[Value], ()> {
    let rows = value.as_array().ok_or(())?;
    if rows
        .iter()
        .any(|w| !w.is_object() || !w["packetId"].is_string())
    {
        return Err(());
    }
    Ok(rows)
}
fn consume(record: &mut Value) -> Result<(), ()> {
    let mut pending = match record.get("pendingTurnWorkers").filter(|v| !v.is_null()) {
        Some(v) => v.as_object().ok_or(())?.clone(),
        None => return Ok(()),
    };
    if pending.is_empty() {
        return Ok(());
    }
    for value in pending.values() {
        workers(value)?;
    }
    let messages = record["messages"].as_array_mut().ok_or(())?;
    for message in messages {
        let Some(id) = message["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
        else {
            continue;
        };
        // nextPending is a normal JS object: inherited function properties can
        // be interpreted as workers. Leave these unsupported ids to TS.
        if [
            "__proto__",
            "constructor",
            "hasOwnProperty",
            "isPrototypeOf",
            "propertyIsEnumerable",
            "toLocaleString",
            "toString",
            "valueOf",
            "__defineGetter__",
            "__defineSetter__",
            "__lookupGetter__",
            "__lookupSetter__",
        ]
        .contains(&id.as_str())
        {
            return Err(());
        }
        if !message["receipt"].is_object() {
            continue;
        }
        let Some(incoming) = pending.get(&id) else {
            continue;
        };
        let incoming = workers(incoming)?;
        if incoming.is_empty() {
            continue;
        }
        let mut merged = Vec::<Value>::new();
        // Map keeps the first insertion position and the last value per packet.
        for worker in message["receipt"]
            .get("workers")
            .filter(|v| !v.is_null())
            .map(workers)
            .transpose()?
            .unwrap_or_default()
            .iter()
            .chain(incoming)
        {
            if let Some(index) = merged
                .iter()
                .position(|w| w["packetId"] == worker["packetId"])
            {
                merged[index] = worker.clone();
            } else {
                merged.push(worker.clone());
            }
        }
        message["receipt"]["workers"] = json!(merged);
        pending.remove(&id);
    }
    Ok(())
}
fn tail_limit(params: &Params) -> usize {
    // Unpaged readHistory uses parseInt, not Number, with default 6 and cap 100.
    let raw = value(params, "limit");
    if raw.is_empty() {
        return 6;
    }
    let raw = trim(raw);
    let (negative, raw) = if let Some(s) = raw.strip_prefix('-') {
        (true, s)
    } else {
        (false, raw.strip_prefix('+').unwrap_or(raw))
    };
    let digits: String = raw.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return 6;
    }
    let n = digits.parse::<f64>().unwrap_or(f64::INFINITY);
    if !n.is_finite() {
        6
    } else if negative {
        1
    } else {
        n.clamp(1.0, 100.0) as usize
    }
}
fn map(record: &mut Value, count: usize) -> Result<Vec<Value>, ()> {
    let messages = record["messages"].as_array().ok_or(())?;
    if messages.iter().any(|m| !valid(m)) {
        return Err(());
    }
    consume(record)?;
    let filtered: Vec<_> = record["messages"]
        .as_array()
        .ok_or(())?
        .iter()
        .filter(|m| !truthy(&m["isPartial"]))
        .collect();
    let mut transcript = Vec::new();
    for message in filtered.iter().skip(filtered.len().saturating_sub(count)) {
        let kind = message
            .get("type")
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| {
                json!(
                    if truthy(&message["compaction"]) || truthy(&message["isCompaction"]) {
                        "compaction"
                    } else {
                        "message"
                    }
                )
            });
        let mut row = json!({"type":kind,"timestampLabel":clock(message)?});
        for key in [
            "id",
            "role",
            "author",
            "network",
            "runtime",
            "persistedVersion",
            "steerAnchor",
            "mentions",
            "media",
            "timestamp",
            "backend",
            "model",
            "receipt",
            "tokens",
            "costUsd",
            "toolCalls",
            "sources",
            "thinking",
            "thinkingSteps",
            "thinkingDurationMs",
            "recalledFacts",
            "command",
            "handoff",
            "compaction",
        ] {
            if let Some(v) = message.get(key) {
                row[key] = v.clone();
            }
        }
        row["text"] = message["content"].clone();
        transcript.push(row);
    }
    Ok(transcript)
}
fn response(status: StatusCode, body: Value) -> Response {
    let mut response = chat_context::respond(status, body);
    response.headers_mut().insert(
        "cache-control",
        axum::http::HeaderValue::from_static("no-store, max-age=0"),
    );
    response
}
pub(super) fn transcript(store: &ReadContext<'_>, params: &Params) -> Response {
    let key = trim(value(params, "sessionKey"));
    let Some(id) = key.strip_prefix("llm-chat:") else {
        return unavailable();
    };
    let Ok(db) = store.database() else {
        return unavailable();
    };
    let bound: Result<bool, _> = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM lanes WHERE session_key = ?)",
        [key],
        |r| r.get(0),
    );
    if bound != Ok(false) {
        return unavailable();
    }
    let Ok(mut record) = chat_context::read(store, id) else {
        return unavailable();
    };
    if !record.is_object() || record["source"] == "bot-network" {
        return unavailable();
    }
    let paged = value(params, "page") == "1";
    let Ok(transcript) = map(
        &mut record,
        if paged {
            usize::MAX
        } else {
            tail_limit(params)
        },
    ) else {
        return unavailable();
    };
    let mut payload = json!({"sessionKey":key,"transcript":transcript});
    if paged {
        let mut page_record = json!({"messages":transcript});
        if chat_context::stable(page_record["messages"].as_array_mut().unwrap()).is_err() {
            return unavailable();
        }
        let mut paging = params.clone();
        paging
            .entry("limit".to_owned())
            .or_insert_with(|| "100".to_owned());
        if let Err(response) = chat_context::page(&mut page_record, &paging, true) {
            return response_with_cache(response);
        }
        payload["transcript"] = page_record["messages"].take();
        payload["page"] = page_record["page"].take();
    }
    response(StatusCode::OK, payload)
}
fn response_with_cache(mut response: Response) -> Response {
    response.headers_mut().insert(
        "cache-control",
        axum::http::HeaderValue::from_static("no-store, max-age=0"),
    );
    response
}
