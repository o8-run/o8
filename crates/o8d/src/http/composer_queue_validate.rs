//! Queue payload validation and JSON.stringify field order from the existing
//! TypeScript store. Selection values are carried, never defaulted here.
use super::chat_context_json::trim;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
type Result<T> = std::result::Result<T, String>;
const ROUTING: &str = "The queued message needs a complete routing snapshot.";
fn text(v: &Value, max: usize, empty: bool) -> bool {
    v.as_str()
        .is_some_and(|s| s.encode_utf16().count() <= max && (empty || !trim(s).is_empty()))
}
fn quote(v: &Value) -> String {
    serde_json::to_string(v).expect("JSON scalar")
}
fn object(fields: Vec<(&str, String)>) -> String {
    format!(
        "{{{}}}",
        fields
            .into_iter()
            .map(|(k, v)| format!("{}:{v}", quote(&Value::String(k.into()))))
            .collect::<Vec<_>>()
            .join(",")
    )
}
fn array(values: Vec<String>) -> String {
    format!("[{}]", values.join(","))
}
fn backend(v: &Value) -> bool {
    let ids: Vec<String> =
        serde_json::from_str(include_str!("../../orchestrator-backend-ids.json"))
            .expect("backend id table");
    v.as_str().is_some_and(|v| ids.iter().any(|id| id == v))
}
fn member(v: &Value, options: &[&str]) -> bool {
    v.as_str().is_some_and(|s| options.contains(&s))
}
fn images(value: &Value) -> Result<Vec<String>> {
    let images = value
        .as_array()
        .filter(|a| a.len() <= 8)
        .ok_or("Attach at most 8 images before sending.")?;
    images
        .iter()
        .enumerate()
        .map(|(index, image)| {
            let n = index + 1;
            if !image.is_object() {
                return Err(format!("Image {n} is invalid. Reattach it before sending."));
            }
            let uri = image["dataUri"].as_str().unwrap_or("");
            let invalid = format!("Image {n} must be PNG, JPEG, GIF, or WebP and under 5 MB.");
            let (head, encoded) = uri.split_once(',').ok_or_else(|| invalid.clone())?;
            let head = head.to_ascii_lowercase();
            let mime = head
                .strip_prefix("data:")
                .and_then(|s| s.strip_suffix(";base64"))
                .filter(|m| ["image/png", "image/jpeg", "image/gif", "image/webp"].contains(m))
                .ok_or_else(|| invalid.clone())?;
            if uri.encode_utf16().count() >= 5_000_000
                || encoded.is_empty()
                || encoded.trim_end_matches('=').is_empty()
                || encoded.len() - encoded.trim_end_matches('=').len() > 2
                || !encoded
                    .trim_end_matches('=')
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"+/".contains(&b))
            {
                return Err(invalid);
            }
            let bytes = STANDARD
                .decode(encoded)
                .map_err(|_| format!("Image {n} has invalid data. Reattach it before sending."))?;
            if STANDARD.encode(bytes) != encoded {
                return Err(format!(
                    "Image {n} has invalid data. Reattach it before sending."
                ));
            }
            let name = if let Some(name) = image.get("name") {
                let name = name.as_str().ok_or_else(|| {
                    format!("Image {n} has an invalid name. Reattach it before sending.")
                })?;
                String::from_utf16(&trim(name).encode_utf16().take(500).collect::<Vec<_>>())
                    .map_err(|_| {
                        format!("Image {n} has an invalid name. Reattach it before sending.")
                    })?
            } else {
                "Image".into()
            };
            Ok(object(vec![
                ("name", quote(&Value::String(name))),
                (
                    "dataUri",
                    quote(&Value::String(format!("data:{mime};base64,{encoded}"))),
                ),
            ]))
        })
        .collect()
}
fn mentions(value: Option<&Value>) -> Vec<String> {
    let Some(value) = value else {
        return vec![];
    };
    let input = match value.as_array() {
        Some(values) => values.iter().collect::<Vec<_>>(),
        None => vec![value],
    };
    input
        .into_iter()
        .filter_map(|m| {
            if !text(&m["label"], 200, false) || !text(&m["title"], 4096, false) {
                return None;
            }
            let lines = m["lines"]
                .as_array()
                .filter(|a| a.len() <= 6 && a.iter().all(|v| text(v, 400, true)))?;
            if m.get("open").is_some_and(|v| !text(v, 200, false)) {
                return None;
            }
            let jump = if let Some(jump) = m.get("jump") {
                if !member(&jump["kind"], &["worktree", "script", "terminal"])
                    || !text(&jump["target"], 4096, false)
                    || jump["kind"] == "terminal" && !lines.is_empty()
                {
                    return None;
                }
                Some(object(vec![
                    ("kind", quote(&jump["kind"])),
                    ("target", quote(&jump["target"])),
                ]))
            } else {
                None
            };
            let mut fields = vec![
                ("label", quote(&m["label"])),
                ("title", quote(&m["title"])),
                ("lines", quote(&m["lines"])),
            ];
            if let Some(open) = m.get("open") {
                fields.push(("open", quote(open)));
            }
            if let Some(jump) = jump {
                fields.push(("jump", jump));
            }
            Some(object(fields))
        })
        .take(20)
        .collect()
}
pub(crate) fn normalize(payload: &Value, ingress: bool) -> Result<String> {
    let r = &payload["routing"];
    if !text(&payload["text"], 200_000, false)
        || !text(&payload["wireMessage"], 250_000, false)
        || !backend(&r["backend"])
        || !text(&r["model"], 500, false)
        || !member(
            &r["effort"],
            &[
                "adaptive", "none", "minimal", "low", "medium", "high", "max", "xhigh", "ultra",
            ],
        )
        || r.get("serviceTier")
            .is_some_and(|v| !member(v, &["default", "fast", "priority", "ultrafast"]))
        || !member(&r["permissionMode"], &["full", "plan", "outside-workspace"])
        || !member(&r["mode"], &["single", "fleet", "fusion"])
        || !member(
            &r["pickedMode"],
            &["solo", "multitask", "fast", "moa", "fusion"],
        )
        || !r["collide"].is_boolean()
        || r.get("projectId").is_some_and(|v| !text(v, 256, true))
    {
        return Err(ROUTING.into());
    }
    let effective = if r["collide"] == true && r["mode"] != "single" {
        "collide"
    } else {
        r["backend"].as_str().unwrap()
    };
    if r["permissionMode"] == "outside-workspace" && !["pi", "o8"].contains(&effective) {
        return Err("Outside workspace commands require the built-in lead.".into());
    }
    let image_values = images(&payload["images"])?;
    if payload.get("afterTaskId").is_some_and(|v| {
        v.as_str().is_none_or(|s| {
            s.is_empty()
                || s.len() > 160
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        }) || r["pinBackend"] != true
    }) || r.get("pinBackend").is_some_and(|v| v != true)
        || r["pinBackend"] == true && r["collide"] == true
    {
        return Err("A bound follow-up requires an exact task and runtime.".into());
    }
    if r.get("handoffMode").is_some_and(|v| v != "handoff") {
        return Err("Unknown handoff mode.".into());
    }
    if !image_values.is_empty() && !member(&r["backend"], &["codex", "claude", "fable", "collide"])
    {
        return Err("The selected runtime cannot receive these images.".into());
    }
    let mut fields = vec![
        ("text", quote(&payload["text"])),
        ("wireMessage", quote(&payload["wireMessage"])),
    ];
    let mention_values = mentions(payload.get("mentions"));
    if !mention_values.is_empty() {
        fields.push(("mentions", array(mention_values)));
    }
    if let Some(after) = payload.get("afterTaskId") {
        fields.push(("afterTaskId", quote(after)));
    }
    fields.push(("images", array(image_values)));
    let mut route = vec![
        ("backend", quote(&r["backend"])),
        ("model", quote(&r["model"])),
        ("effort", quote(&r["effort"])),
    ];
    for key in ["pinBackend", "handoffMode"] {
        if let Some(v) = r.get(key) {
            route.push((key, quote(v)));
        }
    }
    for key in ["permissionMode", "mode", "pickedMode", "collide"] {
        route.push((key, quote(&r[key])));
    }
    for key in ["serviceTier", "projectId"] {
        if let Some(v) = r
            .get(key)
            .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
        {
            route.push((key, quote(v)));
        }
    }
    fields.push(("routing", object(route)));
    super::composer_queue_payload::validate_selection(payload, ingress)
        .map_err(|_| ROUTING.to_owned())?;
    if let Some(selection) = payload.get("wsSelection") {
        let mut ordered = vec![];
        for key in [
            "backend",
            "model",
            "thinkingEffort",
            "permissionMode",
            "orchestrationMode",
            "pickedMode",
            "serviceTier",
            "projectId",
            "handoffMode",
            "pinBackend",
            "collideBaseBackend",
        ] {
            if let Some(v) = selection.get(key) {
                ordered.push((key, quote(v)));
            }
        }
        fields.push(("wsSelection", object(ordered)));
    }
    Ok(object(fields))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalization_matches_the_typescript_fixture_bytes() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/o8d-composer-ledger-vectors.json"
        ))
        .unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let raw = fixture["serialized"].as_str().unwrap();
            let parsed: Value = serde_json::from_str(raw).unwrap();
            assert_eq!(
                normalize(&parsed, parsed.get("wsSelection").is_some()).unwrap(),
                raw
            );
        }
    }
}
