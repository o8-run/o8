//! Historical content-signature transcript merger. The current TypeScript
//! oracle uses ID ordering; fixture exceptions track that drift in #6328.
use crate::model::Entry;
use serde_json::Value;

fn trim(text: &str) -> &str {
    // ECMAScript String.trim whitespace, including BOM but excluding NEL.
    text.trim_matches(|c:char| matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
fn index(key: &str) -> Option<u32> {
    let n = key.parse::<u32>().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}
// JSON.stringify preserves insertion order after integer property names, and
// compares numbers as JavaScript doubles. Preserve both in tool signatures.
fn json_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            let mut a: Vec<_> = a.iter().collect();
            let mut b: Vec<_> = b.iter().collect();
            a.sort_by_key(|(k, _)| index(k).map(|n| (0, n)).unwrap_or((1, 0)));
            b.sort_by_key(|(k, _)| index(k).map(|n| (0, n)).unwrap_or((1, 0)));
            a.len() == b.len()
                && a.into_iter()
                    .zip(b)
                    .all(|((ak, av), (bk, bv))| ak == bk && json_equal(av, bv))
        }
        _ => a == b,
    }
}
fn same(a: &Entry, b: &Entry) -> bool {
    if a.role != b.role || trim(&a.text) != trim(&b.text) {
        return false;
    }
    let a = a.tools.as_deref().unwrap_or(&[]);
    let b = b.tools.as_deref().unwrap_or(&[]);
    a.len() == b.len()
        && a.iter().zip(b).all(|(a, b)| {
            let empty = serde_json::json!({});
            let aa = if a["args"].is_null() {
                &empty
            } else {
                &a["args"]
            };
            let ba = if b["args"].is_null() {
                &empty
            } else {
                &b["args"]
            };
            a["name"] == b["name"] && json_equal(aa, ba)
        })
}
fn timestamp(entry: &Entry) -> f64 {
    entry
        .extra
        .get("timestamp")
        .and_then(Value::as_f64)
        .unwrap_or(0.)
}
pub fn entries(current: &[Entry], incoming: Vec<Entry>) -> Vec<Entry> {
    if incoming.is_empty() {
        return current.to_vec();
    }
    let mut unused = current.to_vec();
    let mut merged = Vec::with_capacity(incoming.len());
    for mut entry in incoming {
        if let Some(index) = unused.iter().position(|old| same(old, &entry)) {
            let old = unused.remove(index);
            for key in [
                "model",
                "tokens",
                "costUsd",
                "sources",
                "thinking",
                "thinkingSteps",
                "thinkingDurationMs",
                "recalledFacts",
                "packetHeader",
            ] {
                if entry.extra.get(key).is_none_or(Value::is_null)
                    && let Some(value) = old.extra.get(key)
                {
                    entry.extra.insert(key.into(), value.clone());
                }
            }
            if entry.tools.is_none() {
                entry.tools = old.tools;
            }
        }
        merged.push(entry);
    }
    let latest = merged.iter().map(timestamp).fold(0., f64::max);
    let mut trailing: Vec<_> = unused
        .into_iter()
        .filter(|e| {
            e.id.starts_with("msg-")
                || e.id.starts_with("stream:")
                || (latest > 0. && timestamp(e) >= latest)
        })
        .filter(|e| !merged.iter().any(|other| same(e, other)))
        .collect();
    trailing.sort_by(|a, b| timestamp(a).total_cmp(&timestamp(b)));
    merged.extend(trailing);
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn production_web_merge_cases() {
        let fixture = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/merge-cases.json");
        let cases: Vec<Value> =
            serde_json::from_str(&std::fs::read_to_string(fixture).unwrap()).unwrap();
        let record = std::env::var("O8_MERGE_RECORD_DIFFERENCES").as_deref() == Ok("1");
        let mut recorded = cases.clone();
        for (index, case) in cases.iter().enumerate() {
            let name = case["name"].as_str().unwrap();
            let seed = name
                .strip_prefix("generated seed=")
                .and_then(|rest| rest.split_whitespace().next())
                .unwrap_or("6327");
            let current: Vec<Entry> = serde_json::from_value(case["current"].clone()).unwrap();
            let incoming: Vec<Entry> = serde_json::from_value(case["incoming"].clone()).unwrap();
            let expected: Vec<Entry> = serde_json::from_value(case["expected"].clone()).unwrap();
            let actual = entries(&current, incoming);
            if record && actual != expected {
                let mut rust = serde_json::to_value(&actual).unwrap();
                for entry in rust.as_array_mut().unwrap() {
                    if entry["toolCalls"].is_null() {
                        entry.as_object_mut().unwrap().remove("toolCalls");
                    }
                }
                recorded[index]["knownDifference"] = serde_json::json!({
                    "issue": "https://github.com/o8-run/o8/issues/6328", "rust": rust
                });
                continue;
            }
            let target = if let Some(known) = case.get("knownDifference") {
                assert_eq!(known["issue"], "https://github.com/o8-run/o8/issues/6328");
                assert_ne!(
                    actual, expected,
                    "resolved known difference: {}",
                    case["name"]
                );
                serde_json::from_value(known["rust"].clone()).unwrap()
            } else {
                expected
            };
            let actual_json = serde_json::to_value(&actual).unwrap();
            let target_json = serde_json::to_value(&target).unwrap();
            assert_eq!(
                actual,
                target,
                "seed={seed} fixture case={index} {} first difference={}",
                case["name"],
                first_difference(&actual_json, &target_json, "").unwrap_or_default()
            );
        }
        eprintln!(
            "merge corpus: {} cases, {} known differences (#6328)",
            cases.len(),
            recorded
                .iter()
                .filter(|case| case.get("knownDifference").is_some())
                .count()
        );
        if record {
            std::fs::write(
                concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/merge-cases.json"),
                format!(
                    "[\n{}\n]\n",
                    recorded
                        .iter()
                        .enumerate()
                        .map(|(i, case)| {
                            if i < 5 {
                                serde_json::to_string_pretty(case).unwrap()
                            } else {
                                serde_json::to_string(case).unwrap()
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(",\n")
                ),
            )
            .unwrap();
        }
    }

    #[test]
    fn empty_window_keeps_history() {
        let current: Vec<Entry> = serde_json::from_value(serde_json::json!([
            { "id": "saved", "role": "assistant", "text": "history", "timestamp": 1 }
        ]))
        .unwrap();
        assert_eq!(entries(&current, vec![]), current);
    }

    #[test]
    fn reports_first_mutated_field() {
        assert_eq!(
            first_difference(
                &serde_json::json!([{ "text": "oracle" }]),
                &serde_json::json!([{ "text": "mutation" }]),
                ""
            ),
            Some("/0/text".into())
        );
    }

    fn first_difference(a: &Value, b: &Value, path: &str) -> Option<String> {
        if a == b {
            return None;
        }
        match (a, b) {
            (Value::Array(a), Value::Array(b)) => {
                for i in 0..a.len().max(b.len()) {
                    let p = format!("{path}/{i}");
                    match (a.get(i), b.get(i)) {
                        (Some(a), Some(b)) => {
                            if let Some(p) = first_difference(a, b, &p) {
                                return Some(p);
                            }
                        }
                        _ => return Some(p),
                    }
                }
            }
            (Value::Object(a), Value::Object(b)) => {
                for k in a.keys().chain(b.keys()) {
                    let p = format!("{path}/{}", k.replace('~', "~0").replace('/', "~1"));
                    match (a.get(k), b.get(k)) {
                        (Some(a), Some(b)) => {
                            if let Some(p) = first_difference(a, b, &p) {
                                return Some(p);
                            }
                        }
                        _ => return Some(p),
                    }
                }
            }
            _ => (),
        }
        Some(if path.is_empty() {
            "/".into()
        } else {
            path.into()
        })
    }
}
