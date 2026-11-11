//! Adapt the server's normalized worker events to chat Entries. Rendering stays
//! in transcript_view / RetainedRow; no worker-specific paragraph renderer.
use crate::{
    client::Client,
    model::{Entry, History},
};
use serde_json::{Value, json};
use std::collections::HashMap;

fn timestamp(event: &Value) -> Value {
    let Some(text) = event["ts"].as_str() else {
        return Value::Null;
    };
    let Some(seconds) = crate::clock::timestamp(text) else {
        return Value::Null;
    };
    let fraction = text
        .get(19..)
        .and_then(|s| s.strip_prefix('.'))
        .unwrap_or("");
    let digits: String = fraction
        .chars()
        .take_while(char::is_ascii_digit)
        .take(3)
        .collect();
    let millis = digits.parse::<u64>().unwrap_or(0) * 10u64.pow(3 - digits.len() as u32);
    json!(seconds * 1000 + millis)
}

fn entry(id: String, role: &str, text: String, event: &Value) -> Entry {
    Entry {
        id,
        role: role.into(),
        text,
        tools: None,
        extra: HashMap::from([("timestamp".into(), timestamp(event))]),
    }
}

/// Keep prompts and durable cards from mobile history; normalized events own
/// the answer and work. In particular, never infer calls from prose prefixes.
fn adapt(mut history: History, events: &[Value]) -> History {
    let mut entries: Vec<_> = history
        .transcript
        .into_iter()
        .filter(|e| e.role == "user" || e.extra.get("type").is_some_and(|t| t == "card"))
        .collect();
    let mut calls: HashMap<String, usize> = HashMap::new();
    let mut pending: HashMap<String, Vec<String>> = HashMap::new();
    let mut last_answer = None;
    let mut turn = 0;
    let mut run = 0;
    for event in events {
        let seq = event["seq"].as_u64().unwrap_or(0);
        let id = format!("{}:event:{seq}", history.session_key);
        let tool = event["tool"].as_str().unwrap_or("tool");
        match event["type"].as_str().unwrap_or("") {
            "tool_call" => {
                let call = event["callId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| id.clone());
                let args = event["args"].as_str().unwrap_or("");
                let args = serde_json::from_str::<Value>(args)
                    .ok()
                    .filter(Value::is_object)
                    .unwrap_or_else(|| {
                        // The server caps argument strings. A truncated JSON
                        // command still has its authoritative tool preview.
                        if event["summary"]
                            .as_str()
                            .is_some_and(|s| s.starts_with("Running ") || s.starts_with("Run "))
                        {
                            json!({})
                        } else {
                            json!({"input":args})
                        }
                    });
                let mut row = entry(id, "tool", String::new(), event);
                let tool_id = format!("{}:call:{run}:{call}", history.session_key);
                row.tools = Some(vec![json!({"id":tool_id,"name":tool,"args":args,
                    "preview":event["summary"],"status":"running","startedAt":row.extra["timestamp"]})]);
                if let Some(index) = calls.get(&call).copied() {
                    entries[index] = row;
                } else {
                    calls.insert(call.clone(), entries.len());
                    pending.entry(tool.into()).or_default().push(call);
                    entries.push(row);
                }
            }
            "tool_result" => {
                // Older normalizers omit callId. Pair results FIFO by tool,
                // never by command text (two identical invocations are real).
                let call = event["callId"]
                    .as_str()
                    .map(str::to_owned)
                    .or_else(|| pending.get(tool).and_then(|ids| ids.first().cloned()));
                if let Some(index) = call.as_ref().and_then(|call| calls.get(call)).copied() {
                    let result = &mut entries[index].tools.as_mut().unwrap()[0];
                    result["status"] = json!(if event["ok"] == true { "done" } else { "error" });
                    result["result"] = event["summary"].clone();
                    result["finishedAt"] = timestamp(event);
                    if let Some(ids) = pending.get_mut(tool) {
                        ids.retain(|id| Some(id) != call.as_ref());
                    }
                } else {
                    entries.push(entry(
                        id,
                        "system",
                        event["summary"].as_str().unwrap_or("").into(),
                        event,
                    ));
                }
            }
            "assistant" => {
                entries.push(entry(
                    id,
                    "assistant",
                    event["text"].as_str().unwrap_or("").into(),
                    event,
                ));
                last_answer = Some(entries.len() - 1);
            }
            "steer" => {
                let text = event["text"].as_str().unwrap_or("");
                // The mobile endpoint also carries durable steers.
                let at = timestamp(event);
                let note = event["note"]
                    .as_str()
                    .filter(|s| !s.is_empty() && *s != text);
                if let Some(saved) = entries.iter_mut().find(|e| {
                    e.role == "user"
                        && e.text.contains(text)
                        && at.is_number()
                        && e.extra.get("timestamp") == Some(&at)
                }) {
                    if event["failed"] != true && note.is_none() {
                        saved.text = text.into();
                    }
                } else {
                    let mut text = if event["failed"] == true {
                        format!("Steer failed to start\n\n{text}")
                    } else {
                        text.into()
                    };
                    if let Some(note) = note {
                        text.push_str(&format!("\n\n{note}"));
                    }
                    entries.push(entry(id, "user", text, event));
                }
                turn = entries.len();
                last_answer = None;
            }
            "error" => entries.push(entry(
                id,
                "system",
                event["message"].as_str().unwrap_or("Worker failed").into(),
                event,
            )),
            "done" => {
                let outcome = if event["exitCode"].as_i64().unwrap_or(1) == 0 {
                    "completed"
                } else {
                    "failed"
                };
                for e in &mut entries[turn..] {
                    for t in e.tools.iter_mut().flatten() {
                        if t["status"] == "running" {
                            t["status"] = json!(if outcome == "completed" {
                                "done"
                            } else {
                                "error"
                            });
                        }
                    }
                }
                let index = last_answer.unwrap_or_else(|| {
                    entries.push(entry(id, "assistant", String::new(), event));
                    entries.len() - 1
                });
                entries[index].extra.insert(
                    "receipt".into(),
                    json!({"terminal":{"outcome":outcome,"completedAt":timestamp(event)}}),
                );
                last_answer = None;
                turn = entries.len();
                run = seq;
                calls.clear();
                pending.clear();
            }
            _ => {}
        }
    }
    entries.sort_by_key(|e| {
        e.extra
            .get("timestamp")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    });
    // The live marker uses the chat merger's working row, including the
    // interval before the first call and after commentary. It is not prose.
    let last = events.last().cloned().unwrap_or(Value::Null);
    let mut state = entry(
        format!("{}:worker-state", history.session_key),
        "assistant",
        String::new(),
        &last,
    );
    state.extra.insert(
        "nativeWorkerActive".into(),
        json!(
            events
                .iter()
                .rev()
                .find(|e| !(e["type"] == "steer" && e["failed"] == true))
                .is_some_and(|e| {
                    // Saved sources that omit done settle by the chat's existing
                    // recency rule, rather than presenting an old verdict as live.
                    let recent = timestamp(e).as_u64().is_none_or(|at| {
                        (crate::clock::now().saturating_mul(1000).saturating_sub(at) as f64)
                            < crate::model::LIVE_WINDOW_MS
                    });
                    e["type"] != "done" && recent
                })
        ),
    );
    entries.push(state);
    history.transcript = entries;
    history
}

impl Client {
    pub(crate) fn worker_history(&self, mut history: History) -> Result<(History, usize), String> {
        let mut cursor = 0u64;
        let mut events = Vec::new();
        let mut bytes = 0;
        loop {
            let page: Result<(Value, usize), _> = self.get_counted(
                "/api/orchestrator/packet-transcript",
                &[
                    ("sessionKey", &history.session_key),
                    ("cursor", &cursor.to_string()),
                    ("limit", "200"),
                ],
            );
            let (page, size) = match page {
                // Older hosts and runtimes without normalized readback retain
                // their existing history. Other failures must remain visible.
                Err(e) if cursor == 0 && (e.ends_with("HTTP 501") || e.ends_with("HTTP 404")) => {
                    return Ok((history, bytes));
                }
                other => other?,
            };
            bytes += size;
            if bytes > 16 * 1024 * 1024 {
                return Err("Worker transcript exceeds 16 MiB".into());
            }
            if page["sessionKey"].as_str() != Some(&history.session_key) {
                return Err("Server returned events for a different session".into());
            }
            let batch = page["events"]
                .as_array()
                .ok_or("Invalid worker transcript events")?;
            events.extend(batch.iter().cloned());
            if batch.len() < 200 {
                break;
            }
            let next = page["nextCursor"]
                .as_u64()
                .filter(|next| *next > cursor)
                .ok_or("Worker transcript cursor did not advance")?;
            cursor = next;
        }
        // Normalized events are complete, so include every prompt too. Keeping
        // a mobile cursor here would later mix legacy paragraphs into the list.
        let mut before = None;
        while let Some(cursor) = history
            .page
            .as_ref()
            .filter(|p| p.has_more)
            .and_then(|p| p.before_cursor.clone())
        {
            if before.as_ref() == Some(&cursor) {
                return Err("Worker prompt cursor did not advance".into());
            }
            let older: Result<(History, usize), String> = self.get_counted(
                "/api/mobile/history",
                &[
                    ("sessionKey", &history.session_key),
                    ("limit", "100"),
                    ("page", "1"),
                    ("before", &cursor),
                ],
            );
            let (older, size) = match older {
                // A live append can invalidate the prompt cursor. Keep the
                // coherent normalized work; the next poll retries prompts.
                Err(error) if error.ends_with("HTTP 409") => break,
                result => result?,
            };
            if older.session_key != history.session_key {
                return Err("Server returned history for a different session".into());
            }
            bytes += size;
            if bytes > 16 * 1024 * 1024 {
                return Err("Worker transcript exceeds 16 MiB".into());
            }
            history.transcript.splice(0..0, older.transcript);
            history.page = older.page;
            before = Some(cursor);
        }
        history.page = None;
        Ok((adapt(history, &events), bytes))
    }
}
