//! Presentation of the existing MobileHistoryResponse. No server state is written.
use crate::{
    activity::{Step, activity},
    text::Node,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Entry {
    pub id: String,
    pub role: String,
    pub text: String,
    #[serde(rename = "toolCalls", default)]
    pub tools: Option<Vec<Value>>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

#[derive(Debug, Deserialize)]
pub struct History {
    #[serde(rename = "sessionKey")]
    pub session_key: String,
    pub transcript: Vec<Entry>,
    #[serde(default)]
    pub page: Option<Page>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub has_more: bool,
    pub before_cursor: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Row {
    PacketHeader {
        id: String,
        prompt: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<Value>,
    },
    Message {
        id: String,
        role: String,
        nodes: Vec<Node>,
    },
    Activity {
        id: String,
        steps: Vec<Step>,
        #[serde(skip)]
        trace: Trace,
    },
}

/// When a block of steps ran and whether it is still running, for the trace.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Trace {
    /// Epoch milliseconds from the block's first entry to the answer that ended it.
    pub started: Option<f64>,
    pub ended: Option<f64>,
    /// The model reasoned in this block, with streamed text or only the live marker.
    pub thinking: bool,
    /// A step runs, the model is reasoning, or the turn has no outcome yet.
    pub live: bool,
}

impl Trace {
    fn include(&mut self, stamp: Option<f64>) {
        if let Some(stamp) = stamp {
            self.started = Some(self.started.map_or(stamp, |s| s.min(stamp)));
            self.ended = Some(self.ended.map_or(stamp, |e| e.max(stamp)));
        }
    }
}

/// Epoch milliseconds; saved history stores them as numbers or as text.
fn stamp(entry: &Entry) -> Option<f64> {
    match entry.extra.get("timestamp")? {
        Value::String(text) => text.parse().ok(),
        value => value.as_f64(),
    }
}

/// When the server recorded the turn's outcome, epoch ms.
fn completed(entry: &Entry) -> Option<f64> {
    entry
        .extra
        .get("receipt")?
        .get("terminal")?
        .get("completedAt")?
        .as_f64()
}

/// The turn's work counts as live this long after its last entry without an outcome.
const LIVE_WINDOW_MS: f64 = 15. * 60_000.;

impl Row {
    pub fn id(&self) -> &str {
        match self {
            Self::Message { id, .. }
            | Self::Activity { id, .. }
            | Self::PacketHeader { id, .. } => id,
        }
    }
}

/// The ordering/deduplication boundary in workerTranscriptBlocks. Tools preceding
/// prose form a block; a result with the same id updates its original step.
pub fn render_tree(entries: &[Entry]) -> Vec<Row> {
    render_tree_cached(entries, &[], &[])
}

/// Completed prose keeps its parsed nodes while tools can still receive results.
pub fn render_tree_cached(entries: &[Entry], previous: &[Entry], old_rows: &[Row]) -> Vec<Row> {
    let previous: HashMap<_, _> = previous.iter().map(|e| (&e.id, e)).collect();
    let cached: HashMap<_, _> = old_rows.iter().map(|r| (r.id(), r)).collect();
    let mut rows = Vec::new();
    let mut pending = Vec::new();
    let mut indices = HashMap::<String, usize>::new();
    let mut steps = Vec::<Step>::new();
    let mut trace = Trace::default();
    let mut trace_id = String::new();
    let mut reasoning = false;
    let flush = |rows: &mut Vec<Row>,
                 pending: &mut Vec<usize>,
                 steps: &[Step],
                 trace: &mut Trace,
                 trace_id: &str,
                 ended: Option<f64>| {
        if !pending.is_empty() || trace.thinking {
            let mut trace = std::mem::take(trace);
            if let Some(ended) = ended {
                trace.ended = Some(trace.ended.map_or(ended, |e| e.max(ended)));
            }
            rows.push(Row::Activity {
                // Named for the block's first entry, so the id holds while steps arrive.
                id: if trace_id.is_empty() {
                    steps[pending[0]].id.clone()
                } else {
                    format!("{trace_id}:trace")
                },
                steps: pending.drain(..).map(|i| steps[i].clone()).collect(),
                trace,
            });
        }
    };
    // Retain step indices until all result-only updates have arrived.
    let mut blocks = Vec::<(usize, Vec<usize>)>::new();
    for (entry_index, entry) in entries.iter().enumerate() {
        let thought = entry
            .extra
            .get("thinking")
            .and_then(Value::as_str)
            .is_some_and(|t| !t.trim().is_empty());
        let marker = entry.extra.get("thinkingActive") == Some(&Value::Bool(true));
        let tools = entry.tools.as_deref().is_some_and(|t| !t.is_empty());
        if thought || marker || tools {
            if !trace.thinking && pending.is_empty() {
                trace_id = entry.id.clone();
            }
            trace.thinking |= thought || marker;
            trace.include(stamp(entry));
            reasoning = marker;
        }
        for (index, tool) in entry.tools.as_deref().unwrap_or(&[]).iter().enumerate() {
            if crate::activity::internal(tool) {
                continue;
            }
            let id = tool["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{}:tool:{index}", entry.id));
            let step = activity(&id, tool, &entry.text);
            trace.include(step.finished);
            if let Some(&i) = indices.get(&id) {
                if tool["args"].is_object() {
                    steps[i] = step;
                } else {
                    steps[i].status = step.status;
                    steps[i].reason = step.reason;
                    steps[i].finished = step.finished.or(steps[i].finished);
                }
            } else {
                indices.insert(id, steps.len());
                pending.push(steps.len());
                steps.push(step);
            }
        }
        let extras = ["media", "claudeCodeEvents"].iter().any(|key| {
            entry
                .extra
                .get(*key)
                .and_then(Value::as_array)
                .is_some_and(|v| !v.is_empty())
        });
        let receipt = entry
            .extra
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| kind == "handoff" || kind == "compaction");
        let visualizations =
            !crate::visualizations::protocol::references(entry.tools.as_ref()).is_empty();
        if (entry.role != "tool" || visualizations)
            && (!entry.text.trim().is_empty() || extras || receipt || visualizations)
        {
            if !pending.is_empty() {
                blocks.push((rows.len(), pending.clone()));
            }
            // An answer ends the block it follows; the marker belongs to this entry.
            let answer = !entry.text.trim().is_empty() && entry.role != "user";
            if answer {
                reasoning = false;
            }
            flush(
                &mut rows,
                &mut pending,
                &steps,
                &mut trace,
                &trace_id,
                answer.then(|| completed(entry).or(stamp(entry))).flatten(),
            );
            if previous.get(&entry.id).is_some_and(|old| **old == *entry)
                && let Some(row @ Row::Message { .. }) = cached.get(entry.id.as_str())
            {
                rows.push((*row).clone());
                continue;
            }
            if entry_index == 0
                && entry.role == "user"
                && (crate::rich::packet_prompt(&entry.text)
                    || entry
                        .extra
                        .get("packetHeader")
                        .is_some_and(|header| header["enabled"] == true))
            {
                rows.push(Row::PacketHeader {
                    id: entry.id.clone(),
                    prompt: entry.text.clone(),
                    details: entry.extra.get("packetHeader").cloned(),
                });
                continue;
            }
            let special = entry
                .extra
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|t| t != "message");
            let mut nodes = crate::rich::nodes(entry);
            if (special && !receipt)
                || entry
                    .extra
                    .get("claudeCodeEvents")
                    .and_then(Value::as_array)
                    .is_some_and(|v| !v.is_empty())
            {
                // Never silently discard unsupported receipts/media in this slice.
                nodes.push(Node::notice(
                    "Additional event or media details are available in the web transcript.",
                ));
            }
            rows.push(Row::Message {
                id: entry.id.clone(),
                role: entry.role.clone(),
                nodes,
            });
        }
    }
    if !pending.is_empty() {
        blocks.push((rows.len(), pending.clone()));
    }
    flush(&mut rows, &mut pending, &steps, &mut trace, &trace_id, None);
    for (row, ids) in blocks {
        if let Row::Activity { steps: target, .. } = &mut rows[row] {
            *target = ids.into_iter().map(|i| steps[i].clone()).collect();
        }
    }
    // The latest turn is still working until an outcome arrives, while its
    // entries are recent; history without receipts settles on its own.
    let last_turn = entries
        .iter()
        .rposition(|e| e.role == "user")
        .map_or(0, |i| i + 1);
    let settled = entries[last_turn.min(entries.len())..].iter().any(|e| {
        e.extra
            .get("receipt")
            .is_some_and(|receipt| receipt.get("terminal").is_some())
    });
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0., |d| d.as_millis() as f64);
    let recent = entries
        .last()
        .and_then(stamp)
        .is_some_and(|t| now - t < LIVE_WINDOW_MS);
    // The latest turn's last block is the one that can still be working, even
    // after its reply has started streaming.
    let turn_rows = rows
        .iter()
        .rposition(|row| matches!(row, Row::Message { role, .. } if role == "user"))
        .map_or(0, |i| i + 1);
    let open_block = rows
        .iter()
        .rposition(|row| matches!(row, Row::Activity { .. }))
        .filter(|&i| i >= turn_rows);
    for (index, row) in rows.iter_mut().enumerate() {
        if let Row::Activity { steps, trace, .. } = row {
            crate::activity::group(steps);
            crate::activity::batch_by_time(steps);
            trace.live = steps.iter().any(|s| s.status == "running")
                || (Some(index) == open_block && (reasoning || (!settled && recent)));
        }
    }
    rows
}
