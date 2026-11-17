//! ID ordering and revision authority from transcripts/merge-ordered.ts.
use crate::model::Entry;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

fn timestamp(entry: &Entry) -> Option<f64> {
    let value = entry.extra.get("timestamp")?;
    if let Some(n) = value.as_f64() {
        return n.is_finite().then_some(n);
    }
    parse_date(value.as_str()?)
}

// Wire dates use the ECMAScript ISO date-time format. Keep milliseconds,
// signed epochs and explicit offsets; numeric JSON values are already epochs.
fn parse_date(value: &str) -> Option<f64> {
    let (year_end, year_start) = if value.starts_with(['+', '-']) {
        (7, 1)
    } else {
        (4, 0)
    };
    let number = |a, b| {
        let digits = value.get(a..b)?;
        if !digits.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        digits.parse::<i64>().ok()
    };
    let mut year = number(year_start, year_end)? * if value.starts_with('-') { -1 } else { 1 };
    let tail = value.get(year_end..)?;
    let month = if tail.is_empty() {
        1
    } else {
        if !tail.starts_with('-') {
            return None;
        }
        number(year_end + 1, year_end + 3)?
    };
    let day = if tail.len() <= 3 {
        1
    } else {
        if tail.as_bytes().get(3) != Some(&b'-') {
            return None;
        }
        number(year_end + 4, year_end + 6)?
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    year -= i64::from(month <= 2);
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    let days =
        era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + (153 * mp + 2) / 5 + day - 1 - 719468;
    let mut millis = days as f64 * 86_400_000.;
    if tail.len() > 6 {
        if tail.as_bytes().get(6) != Some(&b'T') {
            return None;
        }
        let start = year_end + 7;
        let h = number(start, start + 2)?;
        let m = number(start + 3, start + 5)?;
        if value.as_bytes().get(start + 2) != Some(&b':') || h > 24 || m > 59 {
            return None;
        }
        let mut rest = value.get(start + 5..)?;
        let mut s = 0;
        if rest.starts_with(':') {
            s = rest.get(1..3)?.parse::<i64>().ok()?;
            rest = rest.get(3..)?;
        }
        if s > 59 {
            return None;
        }
        let mut fraction = 0.;
        if let Some(digits) = rest.strip_prefix('.') {
            let end = digits
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(digits.len());
            if end == 0 {
                return None;
            }
            fraction = format!("{:0<3}", &digits[..end.min(3)])
                .parse::<f64>()
                .ok()?;
            rest = &digits[end..];
        }
        if h == 24 && (m != 0 || s != 0 || fraction != 0.) {
            return None;
        }
        millis += (h * 3600 + m * 60 + s) as f64 * 1000. + fraction;
        if rest == "Z" {
        } else if rest.starts_with(['+', '-']) {
            let zone = rest[1..].replace(':', "");
            if zone.len() != 4 || !zone.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let h = zone[..2].parse::<i64>().ok()?;
            let m = zone[2..].parse::<i64>().ok()?;
            if h > 23 || m > 59 {
                return None;
            }
            millis -= (h * 60 + m) as f64 * 60_000. * if rest.starts_with('-') { -1. } else { 1. };
        } else if !rest.is_empty() {
            return None;
        }
    } else if ![0, 3, 6].contains(&tail.len()) {
        return None;
    }
    (millis.abs() <= 8.64e15).then_some(millis)
}

fn voice(entry: &Entry) -> Option<(&str, f64)> {
    let v = entry.extra.get("voice")?;
    let session = v["sessionId"].as_str().filter(|s| !s.is_empty())?;
    if !matches!(v["direction"].as_str(), Some("input" | "output")) {
        return None;
    }
    let revision = v["revision"].as_f64()?;
    let start = v["startMs"].as_f64()?;
    let end = v["endMs"].as_f64()?;
    (revision >= 1.
        && revision <= 9_007_199_254_740_991.
        && revision.fract() == 0.
        && start.is_finite()
        && start >= 0.
        && end.is_finite()
        && end >= start)
        .then_some((session, revision))
}

fn update(prior: &Entry, next: &Entry) -> Entry {
    let version = |entry: &Entry| {
        entry
            .extra
            .get("persistedVersion")
            .and_then(Value::as_f64)
            .unwrap_or(0.)
    };
    let mut newest = if version(prior) > version(next) {
        prior
    } else {
        next
    };
    if let Some((session, revision)) = voice(prior) {
        if voice(newest).is_none_or(|(s, r)| s == session && revision > r) {
            newest = prior;
        }
    }
    let mut result = newest.clone();
    if prior.extra.get("deliveryConfirmed") == Some(&Value::Bool(true)) {
        result
            .extra
            .insert("deliveryConfirmed".into(), Value::Bool(true));
    }
    result
}

/// Unbounded source merge. Retention belongs to the caller so loaded pages stay.
pub fn sources(current: &[Entry], incoming: Vec<Entry>) -> Vec<Entry> {
    if incoming.is_empty() {
        return current.to_vec();
    }
    if current.is_empty() {
        return incoming;
    }
    let positions: HashMap<&str, usize> = current
        .iter()
        .enumerate()
        .map(|(i, e)| (e.id.as_str(), i))
        .collect();
    let mut values: HashMap<&str, Entry> =
        current.iter().map(|e| (e.id.as_str(), e.clone())).collect();
    let mut additions = Vec::new();
    let mut seen = HashSet::new();
    for entry in &incoming {
        let value = values
            .get(entry.id.as_str())
            .map(|prior| update(prior, entry))
            .unwrap_or_else(|| entry.clone());
        values.insert(&entry.id, value);
        if seen.insert(&entry.id) {
            additions.push(entry);
        }
    }
    let overlap = additions
        .iter()
        .any(|e| positions.contains_key(e.id.as_str()));
    let mut next_shared = vec![None; additions.len()];
    let mut next = None;
    for i in (0..additions.len()).rev() {
        next_shared[i] = next;
        next = positions.get(additions[i].id.as_str()).copied().or(next);
    }
    let mut buckets = vec![Vec::new(); current.len() + 1];
    let mut previous_slot = 0;
    let mut previous_shared = None;
    for (i, entry) in additions.iter().enumerate() {
        if let Some(&shared) = positions.get(entry.id.as_str()) {
            previous_shared = Some(previous_shared.map_or(shared, |p: usize| p.max(shared)));
            continue;
        }
        let slot =
            if overlap && next_shared[i].is_some_and(|n| previous_shared.is_none_or(|p| n > p)) {
                next_shared[i].unwrap()
            } else {
                timestamp(entry)
                    .and_then(|time| {
                        current.iter().enumerate().position(|(j, prior)| {
                            previous_shared.is_none_or(|p| j > p)
                                && timestamp(prior).is_some_and(|t| t > time)
                        })
                    })
                    .unwrap_or(current.len())
            }
            .max(previous_slot);
        previous_slot = slot;
        buckets[slot].push(entry.id.as_str());
    }
    let mut result = Vec::new();
    let mut emitted = HashSet::new();
    for (i, bucket) in buckets.iter().enumerate() {
        for id in bucket
            .iter()
            .copied()
            .chain(current.get(i).map(|e| e.id.as_str()))
        {
            if emitted.insert(id) {
                result.push(values[id].clone());
            }
        }
    }
    result
}

/// Dashboard entry point, including its 200-entry retention rule.
#[cfg(test)]
pub fn entries(current: &[Entry], incoming: Vec<Entry>) -> Vec<Entry> {
    if incoming.is_empty() {
        return current.to_vec();
    }
    let mut result = sources(current, incoming);
    if result.len() > 200 {
        result.drain(..result.len() - 200);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn iso_dates_keep_milliseconds_and_offsets() {
        assert_eq!(parse_date("1970-01-01T00:00:00.125Z"), Some(125.));
        assert_eq!(parse_date("1970-01-01T01:00:00.125+01:00"), Some(125.));
        assert_eq!(parse_date("1969-12-31T23:59:59Z"), Some(-1000.));
        for invalid in ["invalid", "2026-13-01", "2026-01-32", "2026-01-01T25:00Z"] {
            assert_eq!(parse_date(invalid), None);
        }
    }

    #[test]
    fn source_retention_and_dashboard_retention_are_separate() {
        let current: Vec<Entry> = (0..250)
            .map(|i| {
                serde_json::from_value(serde_json::json!({
                    "id":i.to_string(),"role":"user","text":"same"
                }))
                .unwrap()
            })
            .collect();
        let incoming = vec![current[100].clone()];
        assert_eq!(sources(&current, incoming.clone()).len(), 250);
        assert_eq!(entries(&current, incoming).len(), 200);
        assert_eq!(entries(&current, vec![]).len(), 250);
    }

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
