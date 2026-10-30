//! Display-only messages shared with the sandboxed transcript frame.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;

pub const MIN_HEIGHT: f64 = 80.;
pub const MAX_HEIGHT: f64 = 1800.;
pub const UNAVAILABLE: &str = "This visualization is unavailable.";
pub const RETRY: &str = "Retry visualization";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub height: f64,
    pub created_at: String,
    pub root_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u64>,
}
pub fn valid_id(id: &str) -> bool {
    static ID: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"^vis-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
            .unwrap()
    });
    ID.is_match(id)
}
impl Reference {
    pub fn parse(value: &Value) -> Option<Self> {
        let reference: Self = serde_json::from_value(value.clone()).ok()?;
        (reference.kind == "o8-visualization"
            && valid_id(&reference.id)
            && reference.title.chars().count() <= 120
            && reference.height.is_finite()
            && (MIN_HEIGHT..=MAX_HEIGHT).contains(&reference.height)
            && !reference.created_at.is_empty()
            && reference.root_id.as_deref().is_none_or(valid_id)
            && reference
                .version
                .is_none_or(|v| (1..=9_007_199_254_740_991).contains(&v)))
        .then_some(reference)
    }
    pub fn state_id(&self) -> &str {
        self.root_id.as_deref().unwrap_or(&self.id)
    }
}
pub fn references(tools: Option<&Vec<Value>>) -> Vec<Reference> {
    let mut refs = Vec::new();
    let mut insert = |value: &Value| {
        if let Some(reference) = Reference::parse(value) {
            if let Some(index) = refs.iter().position(|r: &Reference| r.id == reference.id) {
                refs[index] = reference;
            } else {
                refs.push(reference);
            }
        }
    };
    for tool in tools.into_iter().flatten() {
        let name = if tool["name"] == "o8_run" {
            &tool["args"]["name"]
        } else {
            &tool["name"]
        };
        if !name.as_str().is_some_and(|name| {
            name == "o8_html_render"
                || name.ends_with(".o8_html_render")
                || name.ends_with("_o8_html_render")
        }) || tool["status"] == "error"
        {
            continue;
        }
        let Some(result) = tool["result"].as_str().filter(|s| s.len() <= 40_000) else {
            continue;
        };
        let Ok(result) = serde_json::from_str::<Value>(result) else {
            continue;
        };
        insert(
            result
                .get("visualization")
                .unwrap_or(&result["result"]["visualization"]),
        );
        for part in result["content"].as_array().into_iter().flatten() {
            if part["type"] != "text" {
                continue;
            }
            if let Some(nested) = part["text"]
                .as_str()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
            {
                insert(&nested["visualization"]);
            }
        }
    }
    refs
}

pub fn valid_state(value: &Value) -> bool {
    fn visit(value: &Value, depth: usize, nodes: &mut usize) -> bool {
        *nodes += 1;
        if *nodes > 1200 || depth > 12 {
            return false;
        }
        match value {
            Value::Null | Value::Bool(_) => true,
            Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
            Value::String(s) => s.len() <= 8192,
            Value::Array(items) => {
                items.len() <= 500 && items.iter().all(|v| visit(v, depth + 1, nodes))
            }
            Value::Object(fields) => {
                fields.len() <= 100
                    && fields.iter().all(|(key, v)| {
                        key.len() <= 120
                            && !matches!(key.as_str(), "__proto__" | "constructor" | "prototype")
                            && visit(v, depth + 1, nodes)
                    })
            }
        }
    }
    value.is_object() && value.to_string().len() <= 16 * 1024 && visit(value, 0, &mut 0)
}
#[derive(Debug)]
pub enum Message {
    Height(f64),
    State(Value),
}
pub fn message(value: &Value, nonce: &str) -> Option<Message> {
    if value["nonce"].as_str() != Some(nonce) {
        return None;
    }
    match value["type"].as_str()? {
        "o8-visualization:height" => value["height"]
            .as_f64()
            .filter(|h| h.is_finite())
            .map(|h| Message::Height(h.ceil().clamp(MIN_HEIGHT, MAX_HEIGHT))),
        "o8-visualization:state" if valid_state(&value["value"]) => {
            Some(Message::State(value["value"].clone()))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn bridge_accepts_only_bounded_resize_and_state_for_its_nonce() {
        assert!(matches!(
            message(
                &json!({"type":"o8-visualization:height","nonce":"this","height":320.2}),
                "this"
            ),
            Some(Message::Height(321.))
        ));
        assert!(matches!(
            message(
                &json!({"type":"o8-visualization:height","nonce":"this","height":9000}),
                "this"
            ),
            Some(Message::Height(1800.))
        ));
        for value in [
            json!({"type":"o8-visualization:height","nonce":"other","height":320}),
            json!({"type":"o8-visualization:height","nonce":"this","height":"320"}),
            json!({"type":"o8-visualization:question","nonce":"this","value":"act"}),
            json!({"type":"o8-visualization:state","nonce":"this","value":{"__proto__":{}}}),
            json!({"type":"o8-visualization:state","nonce":"this","value":[]}),
        ] {
            assert!(message(&value, "this").is_none(), "{value}");
        }
        assert!(
            message(
                &json!({"type":"o8-visualization:state","nonce":"this","value":{"week":"2"}}),
                "this"
            )
            .is_some()
        );
        assert!(!valid_state(&json!({"x":"x".repeat(8193)})));
    }
}
