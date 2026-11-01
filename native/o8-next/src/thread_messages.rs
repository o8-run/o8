//! Messages between threads (o8_msg_send / o8_msg_inbox) as attributed
//! bubbles under the trace that sent or read them. Display only.
use crate::theme::current as theme;
use gpui::{AnyElement, div, prelude::*, px};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub struct Bubble {
    pub from: Option<String>,
    pub to: Option<String>,
    pub text: String,
    /// Sent by this thread, rather than read from its inbox.
    pub outgoing: bool,
}

const MAX: usize = 20;

fn text_of(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(|t| t.chars().take(2000).collect())
}

/// Bubbles for one tool call; `name` is the bare, lower-case tool name.
pub fn parse(name: &str, args: &Value, result: &str) -> Vec<Bubble> {
    if name.ends_with("msg_send") {
        return text_of(&args["text"])
            .map(|text| Bubble {
                from: None,
                to: text_of(&args["to"]),
                text,
                outgoing: true,
            })
            .into_iter()
            .collect();
    }
    if !name.ends_with("msg_inbox") {
        return vec![];
    }
    let Ok(value) = serde_json::from_str::<Value>(result.trim()) else {
        return vec![];
    };
    value["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            Some(Bubble {
                from: text_of(&m["from"]),
                to: text_of(&m["to"]),
                text: text_of(&m["text"])?,
                outgoing: false,
            })
        })
        .take(MAX)
        .collect()
}

/// "To @reviewer" or "From @planner".
pub fn header(bubble: &Bubble) -> String {
    let at = |name: &str| {
        if name.starts_with('@') {
            name.to_owned()
        } else {
            format!("@{name}")
        }
    };
    match (bubble.outgoing, &bubble.from, &bubble.to) {
        (true, _, Some(to)) => format!("To {}", at(to)),
        (true, _, None) => "Sent".into(),
        (false, Some(from), _) => format!("From {}", at(from)),
        (false, None, _) => "Message".into(),
    }
}

pub fn element(bubble: &Bubble, key: String) -> AnyElement {
    div()
        .debug_selector(move || key.clone())
        .w_full()
        .flex()
        .when(bubble.outgoing, |row| row.justify_end())
        .child(
            div()
                .max_w(px(460.))
                .mt(px(6.))
                .px(px(12.))
                .py(px(8.))
                .rounded(px(12.))
                .bg(theme().hover)
                .flex()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .text_size(px(11.5))
                        .text_color(theme().text_muted)
                        .child(crate::text::sanitize(&header(bubble))),
                )
                .child(
                    div()
                        .text_color(theme().text)
                        .child(crate::text::sanitize(&bubble.text)),
                ),
        )
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn send_is_an_outgoing_bubble_to_its_recipient() {
        let b = parse("o8_msg_send", &json!({"to": "reviewer", "text": " Look at api "}), "");
        assert_eq!(b.len(), 1);
        assert!(b[0].outgoing);
        assert_eq!(b[0].text, "Look at api");
        assert_eq!(header(&b[0]), "To @reviewer");
        assert!(parse("o8_msg_send", &json!({"to": "x"}), "").is_empty());
    }

    #[test]
    fn inbox_reads_messages_with_their_sender() {
        let result = json!({"schema": "o8/agents.inbox/v1", "messages": [
            {"from": "@planner", "to": "me", "text": "Done"},
            {"from": "z", "text": ""}
        ]})
        .to_string();
        let b = parse("o8_msg_inbox", &json!({"agent": "me"}), &result);
        assert_eq!(b.len(), 1);
        assert_eq!(header(&b[0]), "From @planner");
        assert!(parse("o8_msg_inbox", &json!({}), "not json").is_empty());
        assert!(parse("read", &json!({"text": "x"}), "").is_empty());
    }
}
