//! Desktop sequence/capture rules + the dashboard transcript merger.
use crate::model::{Entry, History, Row, render_tree_cached};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub struct Replay {
    pub initial: History,
    pub frames: Vec<Value>,
}

pub struct Transcript {
    pub key: String,
    pub entries: Vec<Entry>,
    pub rows: Vec<Row>,
    pub seq: u64,
    pub page: Option<crate::model::Page>,
    backfilled: bool,
    boot: Option<String>,
    /// The in-flight reply built from orchestrator events, shown until saved
    /// history carries that turn's work.
    live: Option<Entry>,
    /// Entries as last rendered, with the live reply applied.
    shown: Vec<Entry>,
    live_seq: u64,
    live_backend: Option<String>,
}
impl Transcript {
    /// The existing sync cursor excludes its last id, even when that assistant
    /// is still streaming. Refresh the saved tail without dropping backfilled
    /// rows or racing a newer WebSocket checkpoint. HTTP never advances seq.
    pub fn checkpoint(&self) -> (u64, Option<String>) {
        (self.seq, self.boot.clone())
    }
    pub fn saved_tail(&mut self, history: History, captured: (u64, Option<String>)) -> bool {
        if history.session_key != self.key || self.checkpoint() != captured {
            return false;
        }
        let mut next = self.entries.clone();
        for entry in history.transcript {
            if let Some(index) = next.iter().position(|current| current.id == entry.id) {
                next[index] = entry;
            } else {
                let timestamp = entry.extra.get("timestamp").and_then(Value::as_f64);
                let index = timestamp
                    .and_then(|time| {
                        next.iter().position(|current| {
                            current
                                .extra
                                .get("timestamp")
                                .and_then(Value::as_f64)
                                .is_some_and(|current| current > time)
                        })
                    })
                    .unwrap_or(next.len());
                next.insert(index, entry);
            }
        }
        self.merge(next, true)
    }
    /// HTTP send receipts can expose a persisted operator echo before the next
    /// WebSocket batch. Merge only operators so an older HTTP snapshot cannot
    /// overwrite newer streamed agent content or advance its sequence fence.
    pub fn operator_echoes(&mut self, history: History) -> bool {
        if history.session_key != self.key {
            return false;
        }
        let mut next = self.entries.clone();
        for entry in history
            .transcript
            .into_iter()
            .filter(|entry| entry.role == "user")
        {
            if next.iter().any(|current| current.id == entry.id) {
                continue;
            }
            let timestamp = entry.extra.get("timestamp").and_then(Value::as_f64);
            let index = timestamp
                .and_then(|timestamp| {
                    next.iter().position(|current| {
                        current
                            .extra
                            .get("timestamp")
                            .and_then(Value::as_f64)
                            .is_some_and(|time| time > timestamp)
                    })
                })
                .unwrap_or(next.len());
            next.insert(index, entry);
        }
        self.merge(next, true)
    }
    pub fn new(history: History) -> Self {
        let mut this = Self {
            key: history.session_key,
            entries: vec![],
            rows: vec![],
            seq: 0,
            page: history.page,
            backfilled: false,
            boot: None,
            live: None,
            shown: vec![],
            live_seq: 0,
            live_backend: None,
        };
        this.merge(history.transcript, true);
        this
    }
    fn merge(&mut self, incoming: Vec<Entry>, replace: bool) -> bool {
        let prefix = if self.backfilled && !replace {
            incoming
                .first()
                .and_then(|first| self.entries.iter().position(|entry| entry.id == first.id))
                .map(|index| self.entries[..index].to_vec())
                .unwrap_or_else(|| self.entries.clone())
        } else {
            vec![]
        };
        let mut next = if replace {
            incoming
        } else {
            crate::merge::entries(&self.entries, incoming)
        };
        if self.backfilled && !replace {
            let mut retained = prefix;
            retained.retain(|entry| !next.iter().any(|current| current.id == entry.id));
            retained.extend(next);
            next = retained;
        } else if !self.backfilled && next.len() > 200 {
            next.drain(..next.len() - 200);
        }
        if next == self.entries {
            return false;
        }
        self.rows = self.render(&next);
        self.entries = next;
        true
    }
    /// Rows for `entries` with the live reply over its saved placeholder; a saved
    /// reply with text or tools replaces the live one.
    fn render(&mut self, entries: &[Entry]) -> Vec<Row> {
        if let Some(live) = &self.live
            && entries.iter().any(|entry| {
                entry.id == live.id
                    && (!entry.text.trim().is_empty()
                        || entry.tools.as_ref().is_some_and(|tools| !tools.is_empty()))
            })
        {
            self.live = None;
        }
        let mut shown = entries.to_vec();
        if let Some(live) = &self.live {
            match shown.iter_mut().find(|entry| entry.id == live.id) {
                Some(saved) => {
                    saved.text = live.text.clone();
                    saved.tools = live.tools.clone();
                    // The saved placeholder keeps its turn-start timestamp.
                    for (key, value) in &live.extra {
                        if key != "timestamp" || !saved.extra.contains_key(key) {
                            saved.extra.insert(key.clone(), value.clone());
                        }
                    }
                }
                None => shown.push(live.clone()),
            }
        }
        let rows = render_tree_cached(&shown, &self.shown, &self.rows);
        self.shown = shown;
        rows
    }
    /// Desktop socket.ts: thinking markers, tool calls and reply text for this
    /// thread's in-flight turn, de-duplicated by the stream's seq.
    fn orchestrator(&mut self, message: &Value) -> bool {
        let data = &message["data"];
        let thread = self.key.strip_prefix("llm-chat:").unwrap_or(&self.key);
        if data["threadId"].as_str().is_some_and(|id| id != thread) {
            return false;
        }
        let event = message["event"].as_str().unwrap_or("");
        if data["snapshot"] == true {
            // A subscribe snapshot reporting an idle session settles a stale reply.
            return matches!(data["status"].as_str(), Some("ready" | "dead"))
                && self.settle("completed");
        }
        if let Some(backend) = data["backend"].as_str()
            && self.live_backend.as_deref() != Some(backend)
        {
            self.live_seq = 0;
            self.live_backend = Some(backend.into());
        }
        if let Some(seq) = message["seq"].as_u64() {
            if seq <= self.live_seq {
                return false;
            }
            self.live_seq = seq;
        }
        match event {
            "output" => {
                let text = data["text"].as_str().unwrap_or("");
                let thinking = data["thinking"] == true;
                if text.is_empty() && !thinking {
                    return false;
                }
                let Some(live) = self.reply(data) else {
                    return false;
                };
                if thinking {
                    live.extra
                        .insert("thinkingActive".into(), Value::Bool(true));
                    if !text.is_empty() {
                        let mut thought = live
                            .extra
                            .get("thinking")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned();
                        thought.push_str(text);
                        live.extra.insert("thinking".into(), Value::String(thought));
                    }
                } else {
                    live.extra
                        .insert("thinkingActive".into(), Value::Bool(false));
                    live.text.push_str(text);
                }
            }
            "tool-use" => {
                let id = data["toolUseId"].as_str().map(str::to_owned);
                let name = data["name"].as_str().unwrap_or("unknown").to_owned();
                let args = data["args"].clone();
                let Some(live) = self.reply(data) else {
                    return false;
                };
                live.extra
                    .insert("thinkingActive".into(), Value::Bool(false));
                let tools = live.tools.get_or_insert_with(Vec::new);
                match tools
                    .iter_mut()
                    .find(|tool| id.is_some() && tool["id"].as_str() == id.as_deref())
                {
                    Some(tool) => {
                        tool["name"] = Value::String(name);
                        if args.is_object() {
                            tool["args"] = args;
                        }
                    }
                    None => {
                        // A call that starts while another still runs joins its batch.
                        let batch = tools
                            .iter()
                            .rev()
                            .find(|tool| tool["status"] == "running")
                            .and_then(|tool| tool["batch"].as_str())
                            .map(str::to_owned)
                            .or_else(|| id.clone());
                        if let (Some(id), Some(batch)) = (&id, &batch) {
                            crate::activity::note_batch(id, batch);
                        }
                        tools.push(serde_json::json!({
                            "id":id,"name":name,"args":args,"status":"running","batch":batch
                        }));
                    }
                }
            }
            "tool-result" => {
                let Some(live) = self.live.as_mut() else {
                    return false;
                };
                let id = data["toolUseId"].as_str();
                let name = data["name"].as_str().unwrap_or("");
                let Some(tool) = live.tools.iter_mut().flatten().rev().find(|tool| match id {
                    Some(id) => tool["id"].as_str() == Some(id),
                    None => {
                        (name.is_empty() || tool["name"] == name) && tool["status"] == "running"
                    }
                }) else {
                    return false;
                };
                tool["status"] = Value::String(
                    if data["isError"] == true {
                        "error"
                    } else {
                        "done"
                    }
                    .into(),
                );
                tool["result"] = data["output"].clone();
            }
            "status" if matches!(data["status"].as_str(), Some("ready" | "dead")) => {
                return self.settle("completed");
            }
            "error" => return self.settle("failed"),
            _ => return false,
        }
        self.refresh()
    }
    /// The live reply for this event's assistant message, started on first sight.
    fn reply(&mut self, data: &Value) -> Option<&mut Entry> {
        let id = data["assistantMessageId"]
            .as_str()
            .filter(|id| !id.is_empty());
        if self
            .live
            .as_ref()
            .is_none_or(|live| id.is_some_and(|id| live.id != id))
        {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0., |d| d.as_millis() as f64);
            self.live = Some(Entry {
                id: id?.to_owned(),
                role: "assistant".into(),
                text: String::new(),
                tools: Some(vec![]),
                extra: [("timestamp".to_owned(), serde_json::json!(now))].into(),
            });
        }
        self.live.as_mut()
    }
    /// The turn ended: stop the marker, close open tools and record the outcome
    /// until saved history arrives.
    fn settle(&mut self, outcome: &str) -> bool {
        let Some(live) = self.live.as_mut() else {
            return false;
        };
        live.extra
            .insert("thinkingActive".into(), Value::Bool(false));
        live.extra.insert(
            "receipt".into(),
            serde_json::json!({"terminal":{"outcome":outcome}}),
        );
        for tool in live.tools.iter_mut().flatten() {
            if tool["status"] == "running" {
                tool["status"] = Value::String("done".into());
            }
        }
        self.refresh()
    }
    fn refresh(&mut self) -> bool {
        let entries = std::mem::take(&mut self.entries);
        let rows = self.render(&entries);
        self.entries = entries;
        let changed = rows != self.rows;
        self.rows = rows;
        changed
    }
    pub fn prepend(&mut self, history: History) -> bool {
        if history.session_key != self.key {
            return false;
        }
        self.page = history.page;
        let mut next = history.transcript;
        next.retain(|entry| !self.entries.iter().any(|current| current.id == entry.id));
        next.extend(self.entries.clone());
        self.backfilled = true;
        self.rows = self.render(&next);
        self.entries = next;
        true
    }
    fn history(&mut self, payload: &Value) -> bool {
        if payload["sessionKey"].as_str() != Some(&self.key) {
            return false;
        }
        let Ok(entries) = serde_json::from_value::<Vec<Entry>>(payload["entries"].clone()) else {
            return false;
        };
        let replace = payload["replace"].as_bool().unwrap_or(false);
        let overlaps = entries
            .iter()
            .any(|entry| self.entries.iter().any(|current| current.id == entry.id));
        if replace && !overlaps {
            self.backfilled = false;
            self.page = None;
        }
        if entries.is_empty() && !replace {
            return false;
        }
        // A bootstrap/reconnect checkpoint replaces its live window. Earlier
        // explicitly loaded pages remain outside that window while ids overlap.
        self.merge(entries, replace && !(self.backfilled && overlaps))
    }
    pub fn apply(&mut self, message: &Value) -> bool {
        let data = &message["data"];
        match (message["channel"].as_str(), message["event"].as_str()) {
            (Some("system"), Some("connected")) => {
                if let Some(boot) = data["bootId"].as_str() {
                    if self.boot.as_deref().is_some_and(|old| old != boot) {
                        self.seq = 0;
                        self.live_seq = 0;
                    }
                    self.boot = Some(boot.into());
                }
                false
            }
            (Some("realtime"), Some("batch")) => {
                let mut changed = false;
                if let Some(events) = data["events"].as_array() {
                    for event in events {
                        if event["stream"].as_str() != Some(&format!("session:{}", self.key)) {
                            continue;
                        }
                        let Some(seq) = event["seq"].as_u64() else {
                            continue;
                        };
                        let previous = self.seq;
                        self.seq = self.seq.max(seq);
                        if seq <= previous
                            || event["capturedSeq"].as_u64().is_some_and(|s| previous > s)
                        {
                            continue;
                        }
                        if event["event"] == "history.snapshot" {
                            changed |= self.history(&event["data"]);
                        }
                    }
                }
                changed
            }
            (Some("history"), Some("update")) => self.history(data),
            (Some("orchestrator"), Some(_)) => self.orchestrator(message),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_tail_keeps_older_rows_and_yields_to_newer_websocket_history() {
        let history = |text: &str| {
            serde_json::from_value::<History>(
                serde_json::json!({"sessionKey":"llm-chat:test","transcript":[
                    {"id":"tail","role":"assistant","text":text,"timestamp":2}
                ]}),
            )
            .unwrap()
        };
        let mut transcript = Transcript::new(
            serde_json::from_value(
                serde_json::json!({"sessionKey":"llm-chat:test","transcript":[
                    {"id":"older","role":"user","text":"Backfilled context","timestamp":1},
                    {"id":"tail","role":"assistant","text":"Partial","timestamp":2}
                ]}),
            )
            .unwrap(),
        );
        transcript.seq = 7;
        assert!(transcript.saved_tail(history("Streaming reply"), transcript.checkpoint()));
        assert_eq!(transcript.entries[0].id, "older");
        assert_eq!(transcript.entries[1].text, "Streaming reply");
        assert_eq!(transcript.seq, 7);
        transcript.apply(&serde_json::json!({"channel":"realtime","event":"batch","data":{"events":[{
            "stream":"session:llm-chat:test","seq":8,"event":"history.snapshot","data":{"sessionKey":"llm-chat:test","replace":true,"entries":[
                {"id":"tail","role":"assistant","text":"New checkpoint"}
            ]}
        }]}}));
        assert!(!transcript.saved_tail(history("Stale HTTP response"), (7, None)));
        assert_eq!(transcript.entries[0].text, "New checkpoint");
        let old_boot = transcript.checkpoint();
        transcript.apply(&serde_json::json!({"channel":"system","event":"connected","data":{"bootId":"new-fixture-boot"}}));
        assert!(!transcript.saved_tail(history("Old boot response"), old_boot));
    }
    #[test]
    fn recorded_streams_match_web() {
        for case in ["stream", "stream-edges"] {
            let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures");
            let replay: Replay = serde_json::from_slice(
                &std::fs::read(base.join(format!("{case}.replay.json"))).unwrap(),
            )
            .unwrap();
            let mut transcript = Transcript::new(replay.initial);
            for message in replay.frames {
                transcript.apply(&message);
            }
            let expected: Value = serde_json::from_slice(
                &std::fs::read(base.join(format!("{case}.tree.json"))).unwrap(),
            )
            .unwrap();
            assert_eq!(
                serde_json::to_value(&transcript.rows).unwrap(),
                expected,
                "{case}"
            );
        }
    }
    #[test]
    fn orchestrator_events_build_the_live_trace_until_history_carries_the_turn() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .to_string();
        let mut transcript = Transcript::new(
            serde_json::from_value(
                serde_json::json!({"sessionKey":"llm-chat:thoughts-live","transcript":[
                    {"id":"ask","role":"user","text":"Look around","timestamp":now},
                    {"id":"reply","role":"assistant","text":"","timestamp":now}
                ]}),
            )
            .unwrap(),
        );
        let event = |seq: u64, event: &str, data: Value| {
            let mut data = data;
            data["threadId"] = "thoughts-live".into();
            data["assistantMessageId"] = "reply".into();
            serde_json::json!({"channel":"orchestrator","event":event,"seq":seq,"data":data})
        };
        let trace = |transcript: &Transcript| {
            transcript.rows.iter().find_map(|row| match row {
                Row::Activity { steps, trace, .. } => Some((steps.clone(), trace.clone())),
                _ => None,
            })
        };
        let activity_id = |transcript: &Transcript| {
            transcript
                .rows
                .iter()
                .find_map(|row| match row {
                    Row::Activity { id, .. } => Some(id.clone()),
                    _ => None,
                })
                .unwrap()
        };
        assert!(
            trace(&transcript).is_none(),
            "an empty placeholder has no trace"
        );
        assert!(transcript.apply(&event(
            1,
            "output",
            serde_json::json!({"text":"","thinking":true})
        )));
        let (steps, live) = trace(&transcript).expect("the thinking marker opens a trace");
        assert!(steps.is_empty() && live.live && live.thinking);
        assert_eq!(activity_id(&transcript), "reply:trace");
        assert!(transcript.apply(&event(
            2,
            "tool-use",
            serde_json::json!({
            "toolUseId":"t1","name":"Read","args":{"file_path":"src/a.rs"}})
        )));
        let (steps, live) = trace(&transcript).unwrap();
        assert_eq!((steps.len(), steps[0].status.as_str()), (1, "running"));
        assert_eq!(steps[0].subject.as_deref(), Some("src/a.rs"));
        assert!(live.live);
        assert_eq!(activity_id(&transcript), "reply:trace");
        assert!(
            !transcript.apply(&event(
                2,
                "tool-result",
                serde_json::json!({"toolUseId":"t1"})
            )),
            "replayed seq"
        );
        assert!(transcript.apply(&event(
            3,
            "tool-result",
            serde_json::json!({"toolUseId":"t1","output":"ok"})
        )));
        assert_eq!(trace(&transcript).unwrap().0[0].status, "ok");
        assert_eq!(activity_id(&transcript), "reply:trace");
        let other = serde_json::json!({"channel":"orchestrator","event":"tool-use","seq":4,
            "data":{"threadId":"thoughts-other","assistantMessageId":"x","toolUseId":"t9","name":"Bash"}});
        assert!(
            !transcript.apply(&other),
            "another thread's events are ignored"
        );
        for (seq, id) in [(5, "t2"), (6, "t3")] {
            assert!(transcript.apply(&event(
                seq,
                "tool-use",
                serde_json::json!({"toolUseId":id,"name":"WebFetch",
                    "args":{"url":format!("https://example.com/{id}")}})
            )));
        }
        let (steps, _) = trace(&transcript).unwrap();
        assert_eq!(
            steps.iter().map(|s| s.batch.as_deref()).collect::<Vec<_>>(),
            [Some("t1"), Some("t2"), Some("t2")],
            "a call that starts while another runs joins its batch"
        );
        assert!(transcript.apply(&event(7, "status", serde_json::json!({"status":"ready"}))));
        assert!(
            !trace(&transcript).unwrap().1.live,
            "ready settles the trace"
        );
        assert_eq!(activity_id(&transcript), "reply:trace");
        // Saved history with the reply's work replaces the live copy.
        assert!(transcript.history(&serde_json::json!({"sessionKey":"llm-chat:thoughts-live","entries":[
            {"id":"reply","role":"assistant","text":"Done.","timestamp":now,
             "toolCalls":[{"id":"t1","name":"Read","args":{"file_path":"src/a.rs"},"status":"done"},
                          {"id":"t2","name":"Read","args":{"file_path":"src/b.rs"},"status":"done"}],
             "receipt":{"terminal":{"outcome":"completed"}}}
        ]})));
        assert!(transcript.live.is_none());
        assert_eq!(trace(&transcript).unwrap().0.len(), 2);
        assert_eq!(activity_id(&transcript), "reply:trace");
    }
    #[test]
    fn a_tool_first_trace_keeps_its_first_step_id_until_history_carries_the_turn() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .to_string();
        let mut transcript = Transcript::new(
            serde_json::from_value(
                serde_json::json!({"sessionKey":"llm-chat:thoughts-live","transcript":[
                    {"id":"ask","role":"user","text":"Look around","timestamp":now},
                    {"id":"reply","role":"assistant","text":"","timestamp":now}
                ]}),
            )
            .unwrap(),
        );
        let event = |seq: u64, event: &str, data: Value| {
            let mut data = data;
            data["threadId"] = "thoughts-live".into();
            data["assistantMessageId"] = "reply".into();
            serde_json::json!({"channel":"orchestrator","event":event,"seq":seq,"data":data})
        };
        let activity_id = |transcript: &Transcript| {
            transcript.rows.iter().find_map(|row| match row {
                Row::Activity { id, .. } => Some(id.clone()),
                _ => None,
            })
        };
        // No thinking marker: the block takes the web renderer's first-step id
        // and keeps it through the result, ready and the saved history.
        assert!(transcript.apply(&event(
            1,
            "tool-use",
            serde_json::json!({"toolUseId":"t1","name":"Read","args":{"file_path":"src/a.rs"}})
        )));
        assert_eq!(activity_id(&transcript).as_deref(), Some("t1"));
        assert!(transcript.apply(&event(
            2,
            "tool-result",
            serde_json::json!({"toolUseId":"t1","output":"ok"})
        )));
        assert_eq!(activity_id(&transcript).as_deref(), Some("t1"));
        assert!(transcript.apply(&event(3, "status", serde_json::json!({"status":"ready"}))));
        assert_eq!(activity_id(&transcript).as_deref(), Some("t1"));
        assert!(transcript.history(&serde_json::json!({"sessionKey":"llm-chat:thoughts-live","entries":[
            {"id":"reply","role":"assistant","text":"Done.","timestamp":now,
             "toolCalls":[{"id":"t1","name":"Read","args":{"file_path":"src/a.rs"},"status":"done"}],
             "receipt":{"terminal":{"outcome":"completed"}}}
        ]})));
        assert!(transcript.live.is_none());
        assert_eq!(activity_id(&transcript).as_deref(), Some("t1"));
    }

    #[test]
    fn retention_matches_web_store() {
        let mut transcript = Transcript::new(History {
            session_key: "llm-chat:test".into(),
            transcript: vec![],
            page: None,
        });
        let entries: Vec<Entry> = (0..205)
            .map(|i| {
                serde_json::from_value(
                    serde_json::json!({"id":i.to_string(),"role":"user","text":"x"}),
                )
                .unwrap()
            })
            .collect();
        transcript.merge(entries, true);
        assert_eq!(transcript.entries.len(), 200);
        assert_eq!(transcript.entries[0].id, "5");
    }
}
