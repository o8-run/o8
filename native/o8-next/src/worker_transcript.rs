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

/// Only unfinished calls and the current answer travel with the cursor. Completed
/// history belongs to Transcript, not to the polling thread.
#[derive(Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct State {
    key: String,
    pub(crate) cursor: u64,
    #[serde(default)]
    cursor_token: Option<String>,
    calls: HashMap<String, Entry>,
    pending: HashMap<String, Vec<String>>,
    answer: Option<Entry>,
    pub(crate) done: bool,
    pub(crate) active: bool,
}

fn upsert(entries: &mut Vec<Entry>, entry: Entry) {
    if let Some(old) = entries.iter_mut().find(|e| e.id == entry.id) {
        *old = entry;
    } else {
        entries.push(entry);
    }
}

impl State {
    pub(crate) fn from_history(history: &History) -> Option<Self> {
        serde_json::from_value(
            history
                .transcript
                .last()?
                .extra
                .get("nativeWorkerReadback")?
                .clone(),
        )
        .ok()
    }
    fn marker(&self) -> Entry {
        let mut row = entry(
            format!("{}:worker-state", self.key),
            "assistant",
            String::new(),
            &Value::Null,
        );
        row.extra
            .insert("nativeWorkerActive".into(), json!(self.active));
        row.extra.insert("nativeWorkerReadback".into(), json!(self));
        row
    }
    fn apply(&mut self, events: &[Value], entries: &mut Vec<Entry>) {
        for event in events {
            let seq = event["seq"].as_u64().unwrap_or(0);
            if seq <= self.cursor {
                continue;
            }
            self.cursor = seq;
            let kind = event["type"].as_str().unwrap_or("");
            let text = event["text"].as_str().unwrap_or("");
            if kind == "steer" && text.trim().is_empty() {
                continue;
            }
            if !(kind == "steer" && event["failed"] == true) {
                self.done = kind == "done";
                let recent = timestamp(event).as_u64().is_none_or(|at| {
                    (crate::clock::now().saturating_mul(1000).saturating_sub(at) as f64)
                        < crate::model::LIVE_WINDOW_MS
                });
                self.active = !self.done && recent;
            }
            let id = format!("{}:event:{}", self.key, event_id(event));
            let tool = event["tool"].as_str().unwrap_or("tool");
            match kind {
                "tool_call" => {
                    let call = event["callId"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&id)
                        .to_owned();
                    let args = event["args"].as_str().unwrap_or("");
                    let args = serde_json::from_str::<Value>(args)
                        .ok()
                        .filter(Value::is_object)
                        .unwrap_or_else(|| {
                            if event["summary"]
                                .as_str()
                                .is_some_and(|s| s.starts_with("Running ") || s.starts_with("Run "))
                            {
                                json!({})
                            } else {
                                json!({"input":args})
                            }
                        });
                    let tool_id = format!("{id}:call");
                    let mut row = entry(id, "tool", String::new(), event);
                    row.tools = Some(vec![json!({"id":tool_id,"name":tool,"args":args,
                        "nativeWorkerTrace":true,"preview":event["summary"],"status":"running","startedAt":row.extra["timestamp"]})]);
                    if !self.calls.contains_key(&call) {
                        self.pending
                            .entry(tool.into())
                            .or_default()
                            .push(call.clone());
                    }
                    self.calls.insert(call, row.clone());
                    upsert(entries, row);
                }
                "tool_result" => {
                    let call = event["callId"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                        .or_else(|| self.pending.get(tool).and_then(|ids| ids.first().cloned()));
                    if let Some(mut row) = call.as_ref().and_then(|call| self.calls.remove(call)) {
                        let result = &mut row.tools.as_mut().unwrap()[0];
                        result["status"] =
                            json!(if event["ok"] == true { "done" } else { "error" });
                        result["result"] = event["summary"].clone();
                        result["finishedAt"] = timestamp(event);
                        if let Some(ids) = self.pending.get_mut(tool) {
                            ids.retain(|id| Some(id) != call.as_ref());
                        }
                        upsert(entries, row);
                    } else {
                        upsert(
                            entries,
                            entry(
                                id,
                                "system",
                                event["summary"].as_str().unwrap_or("").into(),
                                event,
                            ),
                        );
                    }
                }
                "assistant" => {
                    let row = entry(id, "assistant", text.into(), event);
                    self.answer = Some(row.clone());
                    upsert(entries, row);
                }
                "steer" => {
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
                        upsert(entries, entry(id, "user", text, event));
                    }
                    self.answer = None;
                }
                "error" => upsert(
                    entries,
                    entry(
                        id,
                        "system",
                        event["message"].as_str().unwrap_or("Worker failed").into(),
                        event,
                    ),
                ),
                "done" => {
                    let outcome = if event["exitCode"].as_i64().unwrap_or(1) == 0 {
                        "completed"
                    } else {
                        "failed"
                    };
                    for (_, mut row) in self.calls.drain() {
                        for t in row.tools.iter_mut().flatten() {
                            t["status"] = json!(if outcome == "completed" {
                                "done"
                            } else {
                                "error"
                            });
                            t["finishedAt"] = timestamp(event);
                        }
                        upsert(entries, row);
                    }
                    let mut answer = self
                        .answer
                        .take()
                        .unwrap_or_else(|| entry(id, "assistant", String::new(), event));
                    answer.extra.insert(
                        "receipt".into(),
                        json!({"terminal":{"outcome":outcome,"completedAt":timestamp(event)}}),
                    );
                    upsert(entries, answer);
                    self.pending.clear();
                }
                _ => {}
            }
        }
    }
    pub(crate) fn poll(&mut self, client: &Client) -> Result<Vec<Entry>, ReadbackError> {
        // Read a complete batch before advancing state, so a later page failure
        // retries the same cursor without losing events.
        let from = if self.cursor_token.is_some() {
            self.cursor
        } else {
            0
        };
        let batch = client.worker_events(&self.key, from, self.cursor_token.as_deref())?;
        if batch.events.is_empty() && !batch.reset && batch.cursor == self.cursor {
            return Ok(vec![]);
        }
        if batch.reset || from == 0 {
            // Replay a changed snapshot with stable row identities. Retain calls
            // that slid out of a tail so a later result can still finish them.
            self.calls.retain(|call, _| {
                !batch
                    .events
                    .iter()
                    .any(|e| e["type"] == "tool_call" && e["callId"].as_str() == Some(call))
            });
            self.pending
                .values_mut()
                .for_each(|ids| ids.retain(|id| self.calls.contains_key(id)));
            self.answer = None;
            self.cursor = 0;
        }
        let mut entries = vec![];
        self.apply(&batch.events, &mut entries);
        self.cursor = batch.cursor;
        self.cursor_token = batch.token;
        entries.push(self.marker());
        Ok(entries)
    }
}

fn event_id(event: &Value) -> String {
    if let Some(id) = event["eventId"].as_str() {
        return id.into();
    }
    // Compatibility with older servers: call identity, timestamp and content,
    // never the mutable position in a normalized list.
    use std::hash::{Hash, Hasher};
    let mut content = event.clone();
    content.as_object_mut().unwrap().remove("seq");
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    content.to_string().hash(&mut hash);
    format!("{:016x}", hash.finish())
}

fn adapt(mut history: History, batch: Readback) -> History {
    if batch.events.is_empty() {
        return history;
    }
    let mut entries: Vec<_> = history
        .transcript
        .into_iter()
        .filter(|e| {
            e.role == "user"
                || e.extra.get("type").is_some_and(|t| t == "card")
                || (!batch.complete
                    && e.extra
                        .get("timestamp")
                        .and_then(Value::as_u64)
                        .zip(batch.earliest)
                        .is_none_or(|(at, first)| at < first))
        })
        .collect();
    let mut state = State {
        key: history.session_key.clone(),
        ..Default::default()
    };
    state.apply(&batch.events, &mut entries);
    state.cursor = batch.cursor;
    state.cursor_token = batch.token;
    entries.sort_by_key(|e| {
        e.extra
            .get("timestamp")
            .and_then(Value::as_u64)
            .unwrap_or(u64::MAX)
    });
    entries.push(state.marker());
    history.transcript = entries;
    history
}

struct Readback {
    events: Vec<Value>,
    bytes: usize,
    cursor: u64,
    token: Option<String>,
    reset: bool,
    complete: bool,
    earliest: Option<u64>,
}

const MAX_READBACK_BYTES: usize = 64 * 1024 * 1024;
const MAX_READBACK_EVENTS: usize = 100_000;

#[derive(Debug)]
pub(crate) enum ReadbackError {
    Unavailable(String),
    Invalid(String),
    Limit,
}
impl ReadbackError {
    fn request(error: String) -> Self {
        if error.ends_with("HTTP 401") || error.ends_with("HTTP 403") {
            Self::Invalid(error)
        } else {
            Self::Unavailable(error)
        }
    }
    pub(crate) fn notice(&self) -> &'static str {
        match self {
            Self::Unavailable(_) => "Reconnecting · saved history retained",
            Self::Invalid(_) => "Invalid transcript response · saved history retained",
            Self::Limit => "Transcript readback limit reached · saved history retained",
        }
    }
    fn reason(&self) -> &str {
        match self {
            Self::Unavailable(reason) | Self::Invalid(reason) => reason,
            Self::Limit => "Worker transcript readback limit reached",
        }
    }
}
fn warning(mut history: History, reason: &str) -> History {
    let reason: String = crate::text::sanitize(reason)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect();
    let mut row = entry(
        format!("{}:readback-warning", history.session_key),
        "system",
        format!("Structured work unavailable · saved history retained ({reason})"),
        &Value::Null,
    );
    if let Some(at) = history
        .transcript
        .iter()
        .rev()
        .find_map(|e| e.extra.get("timestamp").filter(|t| t.is_number()))
    {
        row.extra.insert("timestamp".into(), at.clone());
    }
    let at = history.transcript.len().saturating_sub(usize::from(
        history
            .transcript
            .last()
            .is_some_and(|e| e.extra.contains_key("nativeWorkerReadback")),
    ));
    history.transcript.insert(at, row);
    history
}
impl Client {
    fn worker_events(
        &self,
        key: &str,
        mut cursor: u64,
        token: Option<&str>,
    ) -> Result<Readback, ReadbackError> {
        let mut batch = Readback {
            events: vec![],
            bytes: 0,
            cursor,
            token: token.map(str::to_owned),
            reset: false,
            complete: false,
            earliest: None,
        };
        let mut resets = 0;
        loop {
            let (page, size): (Value, usize) = self
                .get_counted(
                    "/api/orchestrator/packet-transcript",
                    &[
                        ("sessionKey", key),
                        ("cursor", &cursor.to_string()),
                        ("cursorToken", batch.token.as_deref().unwrap_or("")),
                        ("limit", "200"),
                    ],
                )
                .map_err(ReadbackError::request)?;
            batch.bytes = batch.bytes.saturating_add(size);
            if page["sessionKey"].as_str() != Some(key) {
                return Err(ReadbackError::Invalid(
                    "Server returned events for a different session".into(),
                ));
            }
            let events = page["events"]
                .as_array()
                .ok_or_else(|| ReadbackError::Invalid("Invalid worker transcript events".into()))?;
            let next = page["nextCursor"].as_u64().unwrap_or(cursor);
            if page["cursorReset"] == true || next < cursor {
                resets += 1;
                if resets > 3 {
                    return Err(ReadbackError::Unavailable(
                        "Worker transcript changed during readback".into(),
                    ));
                }
                batch.events.clear();
                batch.reset = true;
                if events.is_empty() && next < cursor {
                    cursor = 0;
                    batch.token = None;
                    continue;
                }
            }
            if batch.bytes > MAX_READBACK_BYTES
                || batch.events.len().saturating_add(events.len()) > MAX_READBACK_EVENTS
            {
                return Err(ReadbackError::Limit);
            }
            batch.events.extend(events.iter().cloned());
            batch.complete = page["historyComplete"] == true;
            batch.earliest = timestamp(&json!({"ts":page["earliestEventTime"]})).as_u64();
            batch.token = page["cursorToken"].as_str().map(str::to_owned);
            batch.cursor = next;
            if events.len() < 200 {
                return Ok(batch);
            }
            if next <= cursor && !batch.reset {
                return Err(ReadbackError::Invalid(
                    "Worker transcript cursor did not advance".into(),
                ));
            }
            cursor = next;
        }
    }
    pub(crate) fn worker_history(&self, history: History) -> Result<(History, usize), String> {
        let batch = match self.worker_events(&history.session_key, 0, None) {
            Ok(batch) => batch,
            Err(ReadbackError::Unavailable(reason))
                if reason.ends_with("HTTP 404") || reason.ends_with("HTTP 501") =>
            {
                return Ok((history, 0));
            }
            Err(ReadbackError::Invalid(reason)) => return Err(reason),
            Err(error) => return Ok((warning(history, error.reason()), 0)),
        };
        let bytes = batch.bytes;
        // The first saved page can paint now. Pane loads older saved pages in
        // the background, retaining its scroll anchor and the pagination token.
        Ok((adapt(history, batch), bytes))
    }
}
