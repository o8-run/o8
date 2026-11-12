//! Desktop sequence/capture rules + the dashboard transcript merger.
use crate::model::{Entry, History, Row, keep_working_row, render_tree_cached};
use serde::Deserialize;
use serde_json::Value;
use std::{
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

static CONTEXT_EPOCH: AtomicU64 = AtomicU64::new(1);

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
    context_busy: bool,
    context_epoch: u64,
    /// How much of the reply being written is on screen.
    reveal: Option<Reveal>,
    paced: bool,
}

/// The reply reaches the screen word by word at a pace that follows the stream,
/// however the network bunches it; each step fades in, staggered across its words.
struct Reveal {
    id: String,
    shown: usize,
    next: Instant,
    length: usize,
    grew: Instant,
    steps: Vec<RevealStep>,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct RevealStep {
    pub chars: usize,
    pub at: Instant,
}
const REVEAL_TICK: Duration = Duration::from_millis(24);
/// One tick shows this share of what is waiting, so the wait stays near 250ms.
const REVEAL_SHARE: usize = 10;
/// Words shown without a break wait no longer than this much text.
const REVEAL_WORD: usize = 48;
/// A last word with no space after it shows once the stream is this quiet.
const REVEAL_QUIET: Duration = Duration::from_millis(400);
pub(crate) const REVEAL_FADE: Duration = Duration::from_millis(280);
pub(crate) const REVEAL_STAGGER: Duration = Duration::from_millis(70);

/// A live reply's tools sit where they ran: under the words before them, not
/// above the whole reply. Each stretch of words becomes its own entry.
fn split_at_tools(entries: Vec<Entry>) -> Vec<Entry> {
    let at = |tool: &Value, text: &str| {
        text.floor_char_boundary(tool["textAt"].as_u64().unwrap_or(0) as usize)
    };
    entries
        .into_iter()
        .flat_map(|entry| {
            let tools = entry.tools.clone().unwrap_or_default();
            let mut cuts: Vec<usize> = tools
                .iter()
                .map(|tool| at(tool, &entry.text))
                .filter(|cut| *cut > 0)
                .collect();
            cuts.sort_unstable();
            cuts.dedup();
            if cuts.is_empty() {
                return vec![entry];
            }
            cuts.insert(0, 0);
            let last = cuts.len() - 1;
            (0..cuts.len())
                .map(|part| {
                    let start = cuts[part];
                    let end = cuts.get(part + 1).copied().unwrap_or(entry.text.len());
                    let mut extra = entry.extra.clone();
                    if part > 0 {
                        extra.remove("thinking");
                    }
                    if part < last {
                        extra.remove("thinkingActive");
                        extra.remove("receipt");
                    }
                    Entry {
                        id: if part == 0 {
                            entry.id.clone()
                        } else {
                            format!("{}:part{part}", entry.id)
                        },
                        role: entry.role.clone(),
                        text: entry.text[start..end].to_owned(),
                        tools: Some(
                            tools
                                .iter()
                                .filter(|t| at(t, &entry.text) == start)
                                .cloned()
                                .collect(),
                        ),
                        extra,
                    }
                })
                .collect()
        })
        .collect()
}
impl Transcript {
    pub(crate) fn shown_entries(&self) -> &[Entry] {
        &self.shown
    }

    /// The same visible residency used to render the transcript, including live content.
    pub(crate) fn context_snapshot(&self) -> (&[Entry], bool) {
        (&self.shown, self.context_busy)
    }
    pub(crate) fn context_epoch(&self) -> u64 {
        self.context_epoch
    }
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
            context_busy: false,
            context_epoch: CONTEXT_EPOCH.fetch_add(1, Ordering::Relaxed),
            reveal: None,
            paced: !cfg!(test),
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
        // A stopped reply belongs under its own prompt; a newer prompt retires it.
        if let Some(live) = &self.live
            && live
                .extra
                .get("receipt")
                .is_some_and(|receipt| receipt["terminal"]["outcome"] == "interrupted")
        {
            let anchor = live.id.strip_suffix(":stopped").unwrap_or(&live.id);
            let at = entries.iter().position(|entry| entry.id == anchor);
            let ask = entries.iter().rposition(|entry| entry.role == "user");
            if matches!((at, ask), (Some(at), Some(ask)) if ask > at) {
                self.live = None;
            }
        }
        if let Some(live) = &self.live
            && entries.iter().any(|entry| {
                let tools = |entry: &Entry| entry.tools.as_ref().map_or(0, Vec::len);
                entry.id == live.id
                    && (!entry.text.trim().is_empty() || tools(entry) > 0)
                    // A save during the turn lags the stream it came from.
                    && (!self.context_busy
                        || entry.text.len() >= live.text.len() && tools(entry) >= tools(live))
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
        if let Some(reveal) = &self.reveal
            && let Some(entry) = shown.iter_mut().rfind(|entry| entry.id == reveal.id)
        {
            let cut = entry.text.floor_char_boundary(reveal.shown);
            entry.text.truncate(cut);
            for tool in entry.tools.iter_mut().flatten() {
                if tool["textAt"].as_u64().is_some_and(|at| at as usize > cut) {
                    tool["textAt"] = cut.into();
                }
            }
        }
        let shown = split_at_tools(shown);
        let mut rows = render_tree_cached(&shown, &self.shown, &self.rows);
        if self.context_busy {
            keep_working_row(&mut rows, &shown);
        }
        self.shown = shown;
        rows
    }
    /// Desktop socket.ts: thinking markers, tool calls and reply text for this
    /// thread's in-flight turn, de-duplicated by the stream's seq.
    fn orchestrator(&mut self, message: &Value) -> bool {
        let was_running = self.context_busy;
        let changed = self.orchestrator_event(message);
        // The working row follows the turn, whichever event moved it.
        if was_running != self.context_busy {
            return self.refresh() || changed;
        }
        changed
    }
    fn orchestrator_event(&mut self, message: &Value) -> bool {
        let data = &message["data"];
        let thread = self.key.strip_prefix("llm-chat:").unwrap_or(&self.key);
        if data["threadId"].as_str().is_some_and(|id| id != thread) {
            return false;
        }
        let event = message["event"].as_str().unwrap_or("");
        if data["snapshot"] == true {
            let changed = self.context_busy != (data["status"] == "busy");
            self.context_busy = data["status"] == "busy";
            // A subscribe snapshot reporting an idle session settles a stale reply.
            let settled = matches!(data["status"].as_str(), Some("ready" | "dead" | "stopped"))
                && self.settle("completed");
            return settled || changed;
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
        let was_running = self.context_busy;
        if matches!(event, "output" | "tool-use") || (event == "status" && data["status"] == "busy")
        {
            self.context_busy = true;
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
                    let id = live.id.clone();
                    if self.paced && self.reveal.as_ref().is_none_or(|r| r.id != id) {
                        self.reveal = Some(Reveal {
                            id,
                            shown: 0,
                            next: Instant::now(),
                            length: 0,
                            grew: Instant::now(),
                            steps: vec![],
                        });
                    }
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
                let text_at = live.text.len();
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
                            "id":id,"name":name,"args":args,"status":"running","batch":batch,
                            "textAt":text_at
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
            // A stopped lead ends its turn too; without it a replayed "busy"
            // kept Stop showing on a finished chat.
            "status" if data["status"] == "stopped" => {
                self.context_busy = false;
                return self.settle("interrupted") || was_running;
            }
            "status" if matches!(data["status"].as_str(), Some("ready" | "dead")) => {
                self.context_busy = false;
                // Retain the classic terminal usage fields before history catches up.
                let mut usage_changed = false;
                if let Some(usage) =
                    crate::composer::controls::context::terminal_usage(&data["usage"])
                {
                    let id = data["assistantMessageId"].as_str();
                    for entry in self
                        .entries
                        .iter_mut()
                        .chain(self.live.iter_mut())
                        .filter(|entry| Some(entry.id.as_str()) == id)
                    {
                        entry.extra.insert("tokens".into(), usage.clone());
                        usage_changed = true;
                    }
                }
                let settled = self.settle("completed");
                if usage_changed {
                    self.refresh();
                }
                return settled || usage_changed || was_running;
            }
            "error" => {
                self.context_busy = false;
                return self.settle("failed") || was_running;
            }
            _ => return was_running != self.context_busy,
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
        let live = self.live.as_mut()?;
        for key in ["backend", "model"] {
            if let Some(value) = data.get(key).filter(|v| v.is_string()) {
                live.extra.insert(key.into(), value.clone());
            }
        }
        Some(live)
    }
    /// A stop before the first frame leaves no reply to settle; an empty one
    /// stands in under the prompt so the stop shows. The server's saved
    /// placeholder for the turn, when it has one, is that reply.
    fn stopped_before_output(&mut self) {
        let id = match self.entries.last() {
            Some(ask) if ask.role == "user" => format!("{}:stopped", ask.id),
            Some(reply)
                if reply.role == "assistant"
                    && reply.text.trim().is_empty()
                    && reply.tools.as_ref().is_none_or(Vec::is_empty) =>
            {
                reply.id.clone()
            }
            _ => return,
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0., |d| d.as_millis() as f64);
        self.live = Some(Entry {
            id,
            role: "assistant".into(),
            text: String::new(),
            tools: Some(vec![]),
            extra: [("timestamp".to_owned(), serde_json::json!(now))].into(),
        });
    }
    /// Moves the reply on by one step when one is due; true when the rows changed.
    pub fn pace(&mut self) -> bool {
        let now = Instant::now();
        let Some(reveal) = &mut self.reveal else {
            return false;
        };
        reveal
            .steps
            .retain(|step| now - step.at < REVEAL_FADE + REVEAL_STAGGER);
        let text = self
            .live
            .iter()
            .chain(self.entries.iter().rev())
            .find(|entry| entry.id == reveal.id)
            .map_or("", |entry| entry.text.as_str());
        // Saved text can replace the live reply and shift its offsets.
        reveal.shown = text.floor_char_boundary(reveal.shown);
        if text.len() != reveal.length {
            reveal.length = text.len();
            reveal.grew = now;
        }
        if reveal.shown >= text.len() {
            if self.live.is_none() && reveal.steps.is_empty() {
                self.reveal = None;
            }
            return false;
        }
        if now < reveal.next {
            return false;
        }
        reveal.next = now + REVEAL_TICK;
        let waiting = text.len() - reveal.shown;
        let target = text.ceil_char_boundary(reveal.shown + (waiting / REVEAL_SHARE).max(1));
        // A step ends between words, so a word never wraps as it arrives.
        let end = text[target..]
            .find(char::is_whitespace)
            .map(|at| target + at + 1)
            .filter(|end| text.is_char_boundary(*end));
        let streaming = self.live.is_some() && self.context_busy;
        let end = match end {
            Some(end) => end,
            None if streaming && waiting < REVEAL_WORD && now - reveal.grew < REVEAL_QUIET => {
                return false;
            }
            None => text.len(),
        };
        let chars = text[reveal.shown..end].chars().count();
        reveal.steps.push(RevealStep { chars, at: now });
        reveal.shown = end;
        self.refresh()
    }
    /// The steps still fading in, oldest first.
    pub(crate) fn fading(&self) -> Vec<RevealStep> {
        self.reveal
            .as_ref()
            .map_or_else(Vec::new, |reveal| reveal.steps.clone())
    }
    /// The server confirmed a stop: the stream to this client never reports
    /// it, so the turn settles here, as the desktop stop pill does.
    pub fn interrupted(&mut self) -> bool {
        let was_running = std::mem::replace(&mut self.context_busy, false);
        self.settle("interrupted") | self.refresh() || was_running
    }
    /// The turn ended: stop the marker, close open tools and record the outcome
    /// until saved history arrives.
    fn settle(&mut self, outcome: &str) -> bool {
        if self.live.is_none() && outcome == "interrupted" {
            self.stopped_before_output();
        }
        let Some(id) = self.live.as_ref().map(|live| live.id.clone()) else {
            return false;
        };
        // A replayed stop keeps the time the server saved for the turn.
        let ended = self
            .entries
            .iter()
            .find(|entry| entry.id == id)
            .and_then(|entry| entry.extra.get("receipt"))
            .and_then(|receipt| receipt["terminal"]["completedAt"].as_f64())
            .unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0., |d| d.as_millis() as f64)
            });
        let Some(live) = self.live.as_mut() else {
            return false;
        };
        live.extra
            .insert("thinkingActive".into(), Value::Bool(false));
        live.extra.insert(
            "receipt".into(),
            // Only a stop is timed here; other outcomes keep their saved stamps.
            if outcome == "interrupted" {
                serde_json::json!({"terminal":{"outcome":outcome,"completedAt":ended}})
            } else {
                serde_json::json!({"terminal":{"outcome":outcome}})
            },
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
        // A send's echo can arrive as a one-turn window: one that is shorter and
        // shares nothing with this chat extends it rather than wiping it.
        if !overlaps && !entries.is_empty() && entries.len() < self.entries.len() {
            let mut next = self.entries.clone();
            next.extend(entries);
            return self.merge(next, true);
        }
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
    fn a_confirmed_stop_settles_the_running_turn() {
        let mut transcript = Transcript::new(
            serde_json::from_value(
                serde_json::json!({"sessionKey":"llm-chat:thoughts-stop","transcript":[
                    {"id":"reply","role":"assistant","text":"","timestamp":1}
                ]}),
            )
            .unwrap(),
        );
        assert!(transcript.apply(
            &serde_json::json!({"channel":"orchestrator","event":"tool-use","seq":1,
            "data":{"threadId":"thoughts-stop","assistantMessageId":"reply",
                    "toolUseId":"t1","name":"Bash","args":{"command":"sleep 60"}}})
        ));
        assert!(
            transcript.context_snapshot().1,
            "a tool call marks the turn running"
        );
        // The server answers the stop only on the stop request's socket.
        assert!(transcript.interrupted());
        assert!(!transcript.context_snapshot().1);
        let live = transcript.live.as_ref().unwrap();
        assert_eq!(live.extra["receipt"]["terminal"]["outcome"], "interrupted");
        assert!(
            live.tools
                .iter()
                .flatten()
                .all(|tool| tool["status"] != "running")
        );
        assert!(!transcript.interrupted(), "a second stop changes nothing");
    }
    #[test]
    fn a_stop_before_any_output_still_leaves_a_stopped_row() {
        // #5202: Esc eight seconds into a turn that hadn't streamed anything.
        let mut transcript = Transcript::new(
            serde_json::from_value(serde_json::json!({"sessionKey":"llm-chat:thoughts-early",
                "transcript":[{"id":"ask","role":"user","text":"Run sleep 25","timestamp":1}]}))
            .unwrap(),
        );
        transcript.apply(
            &serde_json::json!({"channel":"orchestrator","event":"status","seq":1,
            "data":{"threadId":"thoughts-early","status":"busy"}}),
        );
        assert!(transcript.interrupted());
        let live = transcript.live.as_ref().expect("a stand-in reply");
        assert_eq!(live.extra["receipt"]["terminal"]["outcome"], "interrupted");
        assert!(transcript.rows.iter().any(|row| matches!(row,
            crate::model::Row::Activity { steps, trace, .. } if steps.is_empty() && trace.stopped && !trace.live)));
        assert!(!transcript.interrupted(), "a second stop changes nothing");
    }
    #[test]
    fn a_stop_stand_in_retires_when_the_next_prompt_arrives() {
        let mut transcript = Transcript::new(
            serde_json::from_value(serde_json::json!({"sessionKey":"llm-chat:thoughts-next",
                "transcript":[{"id":"ask","role":"user","text":"First","timestamp":1}]}))
            .unwrap(),
        );
        assert!(transcript.interrupted());
        transcript.history(
            &serde_json::json!({"sessionKey":"llm-chat:thoughts-next","replace":true,
            "entries":[{"id":"ask","role":"user","text":"First","timestamp":1},
                       {"id":"ask2","role":"user","text":"Second","timestamp":5}]}),
        );
        assert!(transcript.live.is_none(), "the old stop's stand-in is gone");
        assert!(
            matches!(transcript.rows.last(), Some(crate::model::Row::Message { role, .. }) if role == "user"),
            "nothing stopped sits under the new prompt"
        );
        assert!(transcript.interrupted());
        assert_eq!(transcript.live.as_ref().unwrap().id, "ask2:stopped");
    }
    #[test]
    fn a_stop_settles_the_servers_empty_placeholder_reply() {
        // The server saves an empty reply when the turn starts (seen 2026-11-07).
        let mut transcript = Transcript::new(
            serde_json::from_value(serde_json::json!({"sessionKey":"llm-chat:thoughts-held",
                "transcript":[{"id":"ask","role":"user","text":"Run sleep 40","timestamp":1},
                              {"id":"reply","role":"assistant","text":"","timestamp":2}]}))
            .unwrap(),
        );
        assert!(transcript.interrupted());
        assert_eq!(transcript.live.as_ref().unwrap().id, "reply");
        assert!(
            transcript.rows.iter().any(|row| matches!(row,
            crate::model::Row::Activity { steps, trace, .. } if steps.is_empty() && trace.stopped))
        );
    }
    #[test]
    fn a_replayed_stopped_turn_is_not_left_running() {
        // The frames a reopened chat received (2026-10-31): an idle snapshot,
        // then the since-0 replay of a turn that ended "stopped".
        let mut transcript = Transcript::new(
            serde_json::from_value(
                serde_json::json!({"sessionKey":"llm-chat:thoughts-replay","transcript":[]}),
            )
            .unwrap(),
        );
        let frame = |seq: u64, event: &str, data: Value| {
            let mut data = data;
            data["threadId"] = "thoughts-replay".into();
            data["assistantMessageId"] = "reply".into();
            serde_json::json!({"channel":"orchestrator","event":event,"seq":seq,"data":data})
        };
        transcript.apply(
            &serde_json::json!({"channel":"orchestrator","event":"status",
            "data":{"threadId":"thoughts-replay","status":"ready","snapshot":true}}),
        );
        transcript.apply(&frame(1, "status", serde_json::json!({"status":"busy"})));
        transcript.apply(&frame(
            2,
            "tool-use",
            serde_json::json!({"toolUseId":"t1","name":"Read"}),
        ));
        assert!(transcript.context_snapshot().1);
        assert!(transcript.apply(&frame(3, "status", serde_json::json!({"status":"stopped"}))));
        assert!(!transcript.context_snapshot().1, "Stop must not stay up");
        let live = transcript.live.as_ref().unwrap();
        assert_eq!(live.extra["receipt"]["terminal"]["outcome"], "interrupted");
    }

    #[test]
    fn a_one_turn_replace_keeps_the_chat_it_arrives_in() {
        let mut transcript = Transcript::new(
            serde_json::from_value(
                serde_json::json!({"sessionKey":"llm-chat:window","transcript":[
                    {"id":"a","role":"user","text":"One","timestamp":1},
                    {"id":"b","role":"assistant","text":"Two","timestamp":2}
                ]}),
            )
            .unwrap(),
        );
        let snapshot = |entries: Value| serde_json::json!({"sessionKey":"llm-chat:window","replace":true,"entries":entries});
        assert!(transcript.history(&snapshot(serde_json::json!([
            {"id":"c","role":"user","text":"Three","timestamp":3}
        ]))));
        assert_eq!(transcript.rows.len(), 3, "the send joins the chat");
        // A window that overlaps still rules, so a shortened chat stays short.
        assert!(transcript.history(&snapshot(serde_json::json!([
            {"id":"a","role":"user","text":"One","timestamp":1}
        ]))));
        assert_eq!(transcript.rows.len(), 1);
    }
    fn live(key: &str) -> Transcript {
        Transcript::new(
            serde_json::from_value(serde_json::json!({"sessionKey":key,"transcript":[]})).unwrap(),
        )
    }
    fn frame(thread: &str, seq: u64, event: &str, mut data: Value) -> Value {
        data["threadId"] = thread.into();
        data["assistantMessageId"] = "reply".into();
        serde_json::json!({"channel":"orchestrator","event":event,"seq":seq,"data":data})
    }

    #[test]
    fn a_tool_that_starts_after_words_stays_under_them() {
        let mut t = live("llm-chat:order");
        t.apply(&frame(
            "order",
            1,
            "status",
            serde_json::json!({"status":"busy"}),
        ));
        t.apply(&frame(
            "order",
            2,
            "output",
            serde_json::json!({"text":"First words"}),
        ));
        t.apply(&frame(
            "order",
            3,
            "tool-use",
            serde_json::json!({"toolUseId":"t","name":"Read","args":{"path":"a"}}),
        ));
        let kinds: Vec<&str> = t
            .rows
            .iter()
            .map(|row| match row {
                Row::Message { .. } => "words",
                _ => "trace",
            })
            .collect();
        assert_eq!(kinds, ["words", "trace"], "the words must not move down");
        t.apply(&frame(
            "order",
            4,
            "output",
            serde_json::json!({"text":" then more"}),
        ));
        let shown: Vec<String> = t.shown.iter().map(|e| e.text.clone()).collect();
        assert_eq!(shown, ["First words", " then more"]);
        assert!(matches!(t.rows.last(), Some(Row::Activity { trace, .. }) if trace.live));
    }

    #[test]
    fn a_tool_position_inside_a_character_does_not_panic() {
        let entry = Entry {
            id: "e".into(),
            role: "assistant".into(),
            text: "\u{2014} first second".into(),
            tools: Some(vec![
                serde_json::json!({"id":"t1","textAt":1}),
                serde_json::json!({"id":"t2","textAt":9}),
            ]),
            extra: Default::default(),
        };
        let split = split_at_tools(vec![entry]);
        let tools: usize = split
            .iter()
            .filter_map(|e| e.tools.as_ref())
            .map(Vec::len)
            .sum();
        assert_eq!(tools, 2, "both tools survive the split");
    }

    #[test]
    fn a_saved_reply_with_shifted_offsets_keeps_pacing() {
        let mut t = live("llm-chat:shift");
        t.paced = true;
        let text = format!("\n\n{}", "\u{2014} word ".repeat(60));
        t.apply(&frame(
            "shift",
            1,
            "status",
            serde_json::json!({"status":"busy"}),
        ));
        t.apply(&frame(
            "shift",
            2,
            "output",
            serde_json::json!({"text":text}),
        ));
        let mut step = |t: &mut Transcript| {
            if let Some(reveal) = &mut t.reveal {
                reveal.next = Instant::now();
            }
            t.pace();
        };
        for _ in 0..4 {
            step(&mut t);
        }
        let id = t.reveal.as_ref().unwrap().id.clone();
        t.entries.retain(|entry| entry.id != id);
        t.entries.push(Entry {
            id,
            role: "assistant".into(),
            text: text.trim_start().to_owned(),
            tools: None,
            extra: Default::default(),
        });
        t.live = None;
        for _ in 0..400 {
            step(&mut t);
        }
    }

    #[test]
    fn a_burst_of_text_reaches_the_screen_in_steps_between_words() {
        let mut t = live("llm-chat:pace");
        t.paced = true;
        let text = "word ".repeat(60);
        t.apply(&frame(
            "pace",
            1,
            "status",
            serde_json::json!({"status":"busy"}),
        ));
        t.apply(&frame(
            "pace",
            2,
            "output",
            serde_json::json!({"text":text}),
        ));
        assert!(t.shown.iter().all(|e| e.text.len() < text.len()));
        let mut steps = Vec::new();
        for _ in 0..4000 {
            if let Some(reveal) = &mut t.reveal {
                reveal.next = Instant::now();
            }
            if t.pace() {
                let on_screen = t.shown.last().unwrap().text.clone();
                assert!(
                    on_screen.ends_with(' '),
                    "{on_screen:?} stops inside a word"
                );
                steps.push(on_screen.len());
            }
            if steps.last() == Some(&text.len()) {
                break;
            }
        }
        assert_eq!(steps.last(), Some(&text.len()));
        assert!(
            steps.len() >= 12,
            "only {} steps: still a burst",
            steps.len()
        );
        assert!(!t.fading().is_empty());
    }

    #[test]
    fn subagents_report_at_the_bottom_of_the_running_reply() {
        let mut t = live("llm-chat:helpers");
        t.apply(&frame(
            "helpers",
            1,
            "status",
            serde_json::json!({"status":"busy"}),
        ));
        t.apply(&frame(
            "helpers",
            2,
            "tool-use",
            serde_json::json!({"toolUseId":"a","name":"Task","args":{"description":"Sort fruit","prompt":"Sort"}}),
        ));
        t.apply(&frame(
            "helpers",
            3,
            "output",
            serde_json::json!({"text":"Started it."}),
        ));
        let live: Vec<(usize, bool)> = t
            .rows
            .iter()
            .filter_map(|row| match row {
                Row::Activity { trace, .. } => Some((trace.helpers.len(), trace.helpers_below)),
                _ => None,
            })
            .collect();
        assert_eq!(live, [(0, true), (1, false)], "one line, on the last row");
        assert!(matches!(t.rows.last(), Some(Row::Activity { trace, .. }) if trace.live));
    }

    #[test]
    fn a_working_row_stays_under_every_message_of_the_turn() {
        let mut transcript = Transcript::new(
            serde_json::from_value(
                serde_json::json!({"sessionKey":"llm-chat:working","transcript":[]}),
            )
            .unwrap(),
        );
        let frame = |seq: u64, event: &str, mut data: Value| {
            data["threadId"] = "working".into();
            data["assistantMessageId"] = "reply".into();
            serde_json::json!({"channel":"orchestrator","event":event,"seq":seq,"data":data})
        };
        let live_last = |transcript: &Transcript| matches!(transcript.rows.last(), Some(Row::Activity { trace, .. }) if trace.live);
        transcript.apply(&frame(1, "status", serde_json::json!({"status":"busy"})));
        assert!(live_last(&transcript), "shows before the first word");
        transcript.apply(&frame(2, "output", serde_json::json!({"text":"First"})));
        assert!(live_last(&transcript), "stays under the reply");
        transcript.apply(&frame(
            3,
            "tool-use",
            serde_json::json!({"toolUseId":"t","name":"Read"}),
        ));
        transcript.apply(&frame(
            4,
            "tool-result",
            serde_json::json!({"toolUseId":"t","status":"ok"}),
        ));
        transcript.apply(&frame(5, "output", serde_json::json!({"text":"Second"})));
        assert!(live_last(&transcript), "stays under the next message");
        let live = transcript
            .rows
            .iter()
            .filter(|row| matches!(row, Row::Activity { trace, .. } if trace.live))
            .count();
        assert_eq!(live, 1, "one indicator at a time");
        transcript.apply(&frame(6, "status", serde_json::json!({"status":"stopped"})));
        assert!(!live_last(&transcript), "the turn's end clears it");
    }
    #[test]
    fn a_held_turn_shows_its_last_word_once_the_stream_goes_quiet() {
        let mut t = live("llm-chat:quiet");
        t.paced = true;
        t.apply(&frame(
            "quiet",
            1,
            "status",
            serde_json::json!({"status":"busy"}),
        ));
        t.apply(&frame(
            "quiet",
            2,
            "output",
            serde_json::json!({"text":"reports back."}),
        ));
        let mut step = |t: &mut Transcript| {
            if let Some(reveal) = &mut t.reveal {
                reveal.next = Instant::now();
                reveal.grew = Instant::now();
            }
            t.pace();
        };
        for _ in 0..40 {
            step(&mut t);
        }
        assert_eq!(t.reveal.as_ref().unwrap().shown, "reports ".len());
        let reveal = t.reveal.as_mut().unwrap();
        reveal.next = Instant::now();
        reveal.grew = Instant::now() - REVEAL_QUIET;
        t.pace();
        assert_eq!(t.reveal.as_ref().unwrap().shown, "reports back.".len());
    }

    #[test]
    fn a_save_during_the_turn_keeps_the_live_reply_and_its_tools() {
        let mut t = live("llm-chat:lag");
        t.apply(&frame(
            "lag",
            1,
            "status",
            serde_json::json!({"status":"busy"}),
        ));
        t.apply(&frame(
            "lag",
            2,
            "output",
            serde_json::json!({"text":"The whole reply so far"}),
        ));
        let id = t.live.as_ref().unwrap().id.clone();
        t.live.as_mut().unwrap().tools = Some(vec![serde_json::json!({"id":"t1"})]);
        let saved = serde_json::from_value::<History>(serde_json::json!({
            "sessionKey":"llm-chat:lag",
            "transcript":[{"id":id,"role":"assistant","text":"The whole"}]
        }))
        .unwrap();
        let checkpoint = t.checkpoint();
        t.saved_tail(saved, checkpoint);
        let live = t
            .live
            .as_ref()
            .expect("the live reply survives a partial save");
        assert_eq!(live.text, "The whole reply so far");
        assert_eq!(live.tools.as_ref().map(Vec::len), Some(1));
    }

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
