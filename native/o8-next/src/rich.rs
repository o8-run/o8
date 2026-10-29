//! Rich events use MobileTranscriptEntry metadata, never guessed text receipts.
use crate::{
    model::Entry,
    text::{Node, markdown},
};
use serde_json::Value;

pub fn system_event(node: &Node) -> bool {
    matches!(node.kind.as_str(), "handoff" | "compaction") && node.data.is_some()
}

pub fn event_summary(kind: &str, data: &Value) -> String {
    let title = if kind == "handoff" {
        format!(
            "Handed off to {}",
            data["to"]["model"]
                .as_str()
                .or(data["to"]["backend"].as_str())
                .unwrap_or("another model")
        )
    } else {
        "Context compacted".into()
    };
    let tokens = |value: u64| {
        if value >= 1000 && value % 1000 == 0 {
            format!("{}k", value / 1000)
        } else {
            value.to_string()
        }
    };
    match (data["tokensBefore"].as_u64(), data["tokensAfter"].as_u64()) {
        (Some(before), Some(after)) => format!(
            "{title} · context {} → {} tokens",
            tokens(before),
            tokens(after)
        ),
        _ => title,
    }
}

/// Keep every supplied field accessible, including nested and future metadata.
pub fn event_fields(data: &Value) -> Vec<String> {
    fn visit(path: String, value: &Value, lines: &mut Vec<String>) {
        match value {
            Value::Object(fields) if !fields.is_empty() => {
                for (key, value) in fields {
                    visit(
                        if path.is_empty() {
                            key.clone()
                        } else {
                            format!("{path}.{key}")
                        },
                        value,
                        lines,
                    );
                }
            }
            Value::Array(values) if !values.is_empty() => {
                for (index, value) in values.iter().enumerate() {
                    visit(format!("{path}[{index}]"), value, lines);
                }
            }
            _ => lines.push(format!(
                "{path}: {}",
                value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string())
            )),
        }
    }
    let mut lines = vec![];
    visit(String::new(), data, &mut lines);
    lines
}

pub fn packet_prompt(text: &str) -> bool {
    text.chars().count() >= 400 && regex::Regex::new(r"(?im)##\s*Project\s+(Brief|Scope|Directives)\b|(^|\n)\s*Packet:\s|(^|\n)\s*STRICT SCOPE:").unwrap().is_match(text)
}
pub fn nodes(entry: &Entry) -> Vec<Node> {
    let kind = entry
        .extra
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("message");
    let mut nodes = if matches!(kind, "handoff" | "compaction")
        && entry.extra.get(kind).is_some_and(Value::is_object)
    {
        vec![Node {
            kind: kind.into(),
            runs: vec![],
            language: None,
            data: entry.extra.get(kind).cloned(),
        }]
    } else if entry.text.is_empty() {
        vec![]
    } else {
        markdown(&entry.text)
    };
    for media in entry
        .extra
        .get("media")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        nodes.push(Node {
            kind: "media".into(),
            runs: vec![],
            language: None,
            data: Some(media.clone()),
        });
    }
    for reference in crate::visualizations::protocol::references(entry.tools.as_ref()) {
        nodes.push(Node {
            kind: "visualization".into(),
            runs: vec![],
            language: None,
            data: serde_json::to_value(reference).ok(),
        });
    }
    nodes
}
