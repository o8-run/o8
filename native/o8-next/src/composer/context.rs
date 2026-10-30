//! Classic ContextMeter, ContextCacheSection and prompt-cache/observations math.
//! Estimates never become provider-reported category counts.
use crate::model::Entry;
use serde_json::{Value, json};
use std::{cell::RefCell, collections::HashMap};

#[path = "context_store.rs"]
mod store;

pub const LIMIT: f64 = 1_000_000.;
pub const SYSTEM: f64 = 5_200.;
pub const TOOLS: f64 = 6_400.;

#[derive(Clone, Debug, PartialEq)]
pub struct Projection {
    pub reported: bool,
    pub active: f64,
    pub conversation: f64,
    pub other: f64,
}
fn count(value: f64) -> f64 {
    if value.is_finite() {
        value.max(0.).floor()
    } else {
        0.
    }
}
pub fn project(running: f64, conversation: f64) -> Projection {
    let (running, conversation) = (count(running), count(conversation));
    let estimate = SYSTEM + TOOLS + conversation;
    Projection {
        reported: running > 0.,
        active: if running > 0. { running } else { estimate },
        conversation,
        other: if running > 0. {
            (running - estimate).max(0.)
        } else {
            0.
        },
    }
}
impl Projection {
    pub fn percent(&self) -> f64 {
        (self.active.clamp(0., LIMIT) / LIMIT * 100.).round()
    }
}
fn approx(text: &str) -> f64 {
    (text.trim().encode_utf16().count() as f64 / 4.).ceil()
}
fn payload(value: &Value) -> f64 {
    match value {
        Value::Null => 0.,
        Value::String(text) => approx(text),
        _ => approx(&value.to_string()),
    }
}
pub fn conversation(entries: &[Entry]) -> f64 {
    entries
        .iter()
        .map(|entry| {
            if let Some(tokens) = entry
                .extra
                .get("compaction")
                .and_then(|c| c["tokensAfter"].as_f64())
            {
                return tokens;
            }
            let tools: f64 = entry
                .tools
                .iter()
                .flatten()
                .map(|call| {
                    approx(call["name"].as_str().unwrap_or(""))
                        + payload(&call["args"])
                        + payload(&call["preview"])
                        + payload(&call["result"])
                })
                .sum();
            (approx(&entry.text) + entry.extra.get("thinking").map_or(0., payload) + tools).max(1.)
        })
        .sum()
}
fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite() && *v >= 0.)
}
fn lifetime(value: &Value) -> Option<f64> {
    number(value).filter(|v| *v > 0. && *v <= 86_400_000.)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Reuse {
    pub prompt: f64,
    pub read: f64,
    pub write: f64,
    pub percent: f64,
}
pub fn latest_reuse(entries: &[Entry]) -> Option<Reuse> {
    let usage = entries
        .iter()
        .rev()
        .find(|e| e.role == "assistant" && e.extra.get("tokens").is_some_and(Value::is_object))?
        .extra
        .get("tokens")?;
    if usage.get("cacheRead").is_none() && usage.get("cacheWrite").is_none() {
        return None;
    }
    let read = count(number(&usage["cacheRead"]).unwrap_or(0.));
    let write = count(number(&usage["cacheWrite"]).unwrap_or(0.));
    let prompt = count(number(&usage["input"]).unwrap_or(0.)) + read + write;
    (prompt > 0.).then(|| Reuse {
        prompt,
        read,
        write,
        percent: (read / prompt * 100.).round(),
    })
}

/// The exact terminal-receipt normalization used by the classic stream.
pub(crate) fn terminal_usage(usage: &Value) -> Option<Value> {
    if !usage.is_object() {
        return None;
    }
    let mut out = json!({"input": count(number(&usage["inputTokens"]).unwrap_or(0.)), "output": count(number(&usage["outputTokens"]).unwrap_or(0.))});
    for (source, target) in [
        ("cacheReadTokens", "cacheRead"),
        ("cacheWriteTokens", "cacheWrite"),
    ] {
        if let Some(value) = number(&usage[source]) {
            out[target] = json!(value);
        }
    }
    if usage["cacheObserved"] == false {
        out["cacheObserved"] = json!(false);
    }
    if let Some(value) = lifetime(&usage["cacheRetentionMs"]) {
        out["cacheRetentionMs"] = json!(value);
    }
    Some(out)
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Observation {
    pub id: String,
    pub session: String,
    pub runtime: String,
    pub model: String,
    pub start: f64,
    pub end: f64,
    pub input: Option<f64>,
    pub read: Option<f64>,
    pub write: Option<f64>,
    pub ttl: Option<f64>,
    pub idle: Option<f64>,
}
pub fn supported(runtime: &str) -> bool {
    matches!(runtime, "codex" | "claude-code")
}
fn resumes(rows: &[Observation]) -> Vec<Observation> {
    let mut rows = rows.to_vec();
    rows.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut previous = HashMap::new();
    for row in &mut rows {
        if let Some(end) = previous.insert(
            (row.session.clone(), row.runtime.clone(), row.model.clone()),
            row.end,
        ) {
            row.idle = Some((row.start - end).max(0.));
        }
    }
    rows
}
#[derive(Clone, Debug, PartialEq)]
pub struct Estimate {
    pub remaining: f64,
    pub requested: bool,
}
pub fn estimate(
    rows: &[Observation],
    session: &str,
    runtime: &str,
    model: &str,
    now: f64,
) -> Option<Estimate> {
    let rows = resumes(rows);
    let last = rows
        .iter()
        .rev()
        .find(|r| r.session == session && r.runtime == runtime)?;
    if !supported(runtime) || model.is_empty() || last.model != model {
        return None;
    }
    let read = last.read?;
    if read == 0. && last.write.unwrap_or(0.) <= 0. {
        return (last.idle.unwrap_or(0.) > 0. && last.input.unwrap_or(0.) >= 10_000.).then_some(
            Estimate {
                remaining: 0.,
                requested: false,
            },
        );
    }
    let evidence: Vec<_> = rows
        .iter()
        .filter(|r| r.runtime == runtime && r.model == last.model && r.idle.unwrap_or(0.) > 0.)
        .rev()
        .take(40)
        .collect();
    let cold = evidence
        .iter()
        .filter(|r| r.read == Some(0.) && r.input.unwrap_or(0.) >= 10_000.)
        .map(|r| r.idle.unwrap())
        .fold(f64::INFINITY, f64::min);
    let observed = evidence
        .iter()
        .filter(|r| r.read.unwrap_or(0.) > 0. && r.idle.unwrap() < cold)
        .map(|r| r.idle.unwrap())
        .fold(0., f64::max);
    let ttl = last.ttl.or((observed > 0.).then_some(observed))?;
    Some(Estimate {
        remaining: (last.end + ttl - now).max(0.),
        requested: last.ttl.is_some(),
    })
}

pub fn label(runtime: &str, estimate: Option<&Estimate>, compact: bool) -> String {
    match (supported(runtime), estimate) {
        (false, _) => if compact { "n/a" } else { "Cache n/a" }.into(),
        (_, None) => if compact { "?" } else { "Cache ?" }.into(),
        (_, Some(e)) if e.remaining > 0. => format!(
            "{}~{}m",
            if compact { "" } else { "Warm " },
            (e.remaining / 60_000.).ceil()
        ),
        _ => if compact { "~cold" } else { "Cold · est." }.into(),
    }
}
pub fn explanation(runtime: &str, estimate: Option<&Estimate>) -> String {
    let text = if !supported(runtime) {
        "Cache estimate unavailable for this runtime".into()
    } else {
        match estimate {
            Some(e) if e.remaining > 0. => format!(
                "Cache warm · about {} min left · estimate",
                (e.remaining / 60_000.).ceil()
            ),
            Some(_) => "Cache likely cold · estimate".into(),
            None => "Cache unknown · estimate".into(),
        }
    };
    format!(
        "{text}. Estimate from {} on this device. Sending within this window may reuse cached context; reuse is not guaranteed. No keep-alive requests are sent.",
        if estimate.is_some_and(|e| e.requested) {
            "the reported cache lifetime"
        } else {
            "observed cache reads and idle gaps"
        }
    )
}

// Classic local observations, shared by native composers for this server.
// The native facts-only store is separate from the browser's localStorage.
thread_local! { static OBSERVATIONS: RefCell<HashMap<String, Vec<Observation>>> = RefCell::default(); }
pub fn observe(
    server: &str,
    session: &str,
    runtime: &str,
    entries: &[Entry],
    running: bool,
    completed: Option<f64>,
    now: f64,
) -> Vec<Observation> {
    OBSERVATIONS.with_borrow_mut(|stores| {
        let rows = stores
            .entry(server.to_owned())
            .or_insert_with(|| store::read(server));
        let previous = rows.clone();
        if supported(runtime) && !running && !session.is_empty() {
            let mut groups: Vec<Vec<&Entry>> = vec![];
            for entry in entries {
                if entry.role == "user" {
                    groups.push(vec![entry]);
                } else if let Some(group) = groups.last_mut() {
                    group.push(entry);
                }
            }
            for (index, group) in groups.iter().enumerate() {
                let user = group[0];
                let assistant: Vec<_> = group
                    .iter()
                    .copied()
                    .filter(|e| {
                        e.role == "assistant"
                            && e.extra.get("type").is_none_or(|v| v != "compaction")
                    })
                    .collect();
                let Some(start) = user.extra.get("timestamp").and_then(number) else {
                    continue;
                };
                if assistant.is_empty()
                    || assistant.iter().any(|e| {
                        e.extra
                            .get("backend")
                            .and_then(Value::as_str)
                            .unwrap_or(runtime)
                            != runtime
                    })
                {
                    continue;
                }
                let usages: Vec<_> = assistant
                    .iter()
                    .filter(|e| e.extra.get("tokens").is_some_and(Value::is_object))
                    .collect();
                let model = usages
                    .first()
                    .and_then(|e| e.extra.get("model"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if usages
                    .iter()
                    .any(|e| e.extra.get("model").and_then(Value::as_str).unwrap_or("") != model)
                {
                    continue;
                }
                let times: Option<Vec<_>> = assistant
                    .iter()
                    .map(|e| e.extra.get("timestamp").and_then(number))
                    .collect();
                let Some(times) = times else {
                    continue;
                };
                let end = if index + 1 == groups.len() {
                    completed.unwrap_or_else(|| times.iter().copied().fold(0., f64::max))
                } else {
                    times.iter().copied().fold(0., f64::max)
                };
                if end < start {
                    continue;
                }
                let total = |field: &str| -> Option<f64> {
                    if usages.is_empty() {
                        return None;
                    }
                    let sum: Option<Vec<_>> = usages
                        .iter()
                        .map(|e| {
                            let tokens = &e.extra["tokens"];
                            if tokens["cacheObserved"] == false {
                                None
                            } else {
                                number(&tokens[field])
                            }
                        })
                        .collect();
                    let sum: f64 = sum?.iter().sum();
                    sum.is_finite().then_some(sum)
                };
                let ttl = usages
                    .iter()
                    .filter_map(|e| lifetime(&e.extra["tokens"]["cacheRetentionMs"]))
                    .reduce(f64::min);
                let id = json!([session, runtime, user.id]).to_string();
                let old = rows.iter().position(|r| r.id == id);
                let row = Observation {
                    id,
                    session: session.into(),
                    runtime: runtime.into(),
                    model: model.into(),
                    start,
                    end: old.map_or(end, |i| end.max(rows[i].end)),
                    input: total("input"),
                    read: total("cacheRead"),
                    write: total("cacheWrite"),
                    ttl,
                    idle: None,
                };
                if let Some(index) = old {
                    rows[index] = row;
                } else {
                    rows.push(row);
                }
            }
        }
        *rows = resumes(rows);
        rows.retain(|r| r.end >= now - 14. * 86_400_000. && r.end <= now);
        rows.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.id.cmp(&b.id)));
        if rows.len() > 5000 {
            rows.drain(..rows.len() - 5000);
        }
        if *rows != previous {
            store::save(server, rows);
        }
        rows.clone()
    })
}

#[derive(Default)]
pub struct MeterState {
    pub binding: Option<(String, String, u64)>,
    pub poll: Option<gpui::Task<()>>,
    pub clock: Option<gpui::Task<()>>,
    pub requested: bool,
    pub reported: f64,
    pub previous: Option<f64>,
    pub growth: f64,
    pub was_running: bool,
    pub width: f32,
    pub anchor: Option<gpui::Bounds<gpui::Pixels>>,
    pub card_bounds: Option<gpui::Bounds<gpui::Pixels>>,
    pub focus_events: Option<[gpui::Subscription; 2]>,
}
pub fn telemetry(response: &Value) -> f64 {
    let t = &response["telemetry"];
    // The server can itself supply a named fallback. Never relabel it as runtime truth.
    if t["contextSource"] == "transcript-estimate" {
        0.
    } else {
        number(&t["contextTokens"]).unwrap_or(0.).min(LIMIT)
    }
}
pub fn fetch(client: &crate::client::Client, thread: &str, backend: &str) -> Result<f64, String> {
    client
        .get::<Value>(
            "/api/runtime/telemetry",
            &[("threadId", thread), ("backend", backend)],
        )
        .map(|value| telemetry(&value))
}
pub fn format_tokens(value: f64) -> String {
    if !value.is_finite() {
        return "0".into();
    }
    let (scale, suffix) = if value.abs() >= 999_950. {
        (1_000_000., "M")
    } else if value.abs() >= 999.95 {
        (1_000., "k")
    } else {
        (1., "")
    };
    let value = (value / scale * 10.).round() / 10.;
    if value.fract() == 0. {
        format!("{value:.0}{suffix}")
    } else {
        format!("{value:.1}{suffix}")
    }
}

#[cfg(test)]
#[path = "context_tests.rs"]
mod tests;
