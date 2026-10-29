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
    },
}

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
    let flush = |rows: &mut Vec<Row>, pending: &mut Vec<usize>, steps: &[Step]| {
        if !pending.is_empty() {
            rows.push(Row::Activity {
                id: steps[pending[0]].id.clone(),
                steps: pending.drain(..).map(|i| steps[i].clone()).collect(),
            });
        }
    };
    // Retain step indices until all result-only updates have arrived.
    let mut blocks = Vec::<(usize, Vec<usize>)>::new();
    for (entry_index, entry) in entries.iter().enumerate() {
        for (index, tool) in entry.tools.as_deref().unwrap_or(&[]).iter().enumerate() {
            let id = tool["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("{}:tool:{index}", entry.id));
            let step = activity(&id, tool, &entry.text);
            if let Some(&i) = indices.get(&id) {
                if tool["args"].is_object() {
                    steps[i] = step;
                } else {
                    steps[i].status = step.status;
                    steps[i].reason = step.reason;
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
            flush(&mut rows, &mut pending, &steps);
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
    flush(&mut rows, &mut pending, &steps);
    for (row, ids) in blocks {
        if let Row::Activity { steps: target, .. } = &mut rows[row] {
            *target = ids.into_iter().map(|i| steps[i].clone()).collect();
        }
    }
    for row in &mut rows {
        if let Row::Activity { steps, .. } = row {
            crate::activity::group(steps);
        }
    }
    rows
}
