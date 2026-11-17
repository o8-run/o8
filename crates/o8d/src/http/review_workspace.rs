//! The unselected workspace response has no Git, database or cache work.
use super::{reply, unavailable, ReadContext};
use axum::{http::HeaderValue, http::StatusCode, response::Response};
use chrono::{SecondsFormat, Utc};
use serde_json::json;

pub(super) fn read(store: &ReadContext<'_>) -> Response {
    if store.defaults_context.as_ref()
        .and_then(|context| context.get("reviewWorkspaceUnselected"))
        .and_then(|value| value.as_bool()) != Some(true)
    {
        return unavailable();
    }
    let mut response = reply(StatusCode::OK, json!({
        "generatedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "repoSlug": "", "repoPath": "", "branch": "", "ahead": 0, "behind": 0,
        "dirty": false, "changedFiles": [], "diffStat": "", "recentCommits": [],
        "worktrees": [], "pullRequests": [], "activeIssues": []
    }));
    response.headers_mut().insert("cache-control", HeaderValue::from_static("no-store, max-age=0"));
    response
}
