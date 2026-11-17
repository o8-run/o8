//! A warm empty inbox is authoritative only while the TS cache admits it.
//! Discovery, fresh/cache-miss reads and every nonempty projection stay in TS.
use super::{reply, unavailable, ReadContext};
use axum::{http::{HeaderValue, StatusCode}, response::Response};
use serde_json::{json, Value};

pub(super) fn read(store: &ReadContext<'_>) -> Response {
    let started = std::time::Instant::now();
    let result = (|| {
        let context = store.defaults_context.as_ref()?.get("mobileInbox")?;
        if context.get("version")?.as_u64()? != 1 { return None; }
        let generated = context.get("generatedAt")?.as_str()?;
        let mode = context.get("mode")?.as_str()?;
        if !["live", "demo", "stale"].contains(&mode) { return None; }
        let label = context.get("sourceLabel")?.as_str()?;
        let mut body = json!({
            "generatedAt": generated, "mode": mode, "sourceLabel": label,
            "staleDrafts": {"drafts": [], "sources": []},
            "sessions": [], "fleetSessions": [], "approvals": [], "reviewUnits": [], "items": [],
            "summary": {"alerts": 0, "approvals": 0, "reviewItems": 0, "inspectOnlyReviews": 0, "activeRuns": 0}
        });
        if let Some(note) = context.get("note") { body["note"] = Value::String(note.as_str()?.to_owned()); }
        Some(body)
    })();
    let Some(body) = result else { return unavailable(); };
    let mut response = reply(StatusCode::OK, body);
    response.headers_mut().insert("cache-control", HeaderValue::from_static("no-store, max-age=0"));
    response.headers_mut().insert("server-timing", HeaderValue::from_str(
        &format!("total;dur={:.1}", started.elapsed().as_secs_f64() * 1000.0)
    ).expect("numeric elapsed duration"));
    response
}
