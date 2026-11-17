//! Match saved linked-work metadata without taking ownership of live PR reads.
use super::*;

pub(super) fn append(store: &ReadContext<'_>, threads: &mut [Value]) -> Result<(), ()> {
    let db = store.database()?;
    // TS catches a missing linkage schema and leaves every linkedWork null,
    // including rows with a saved branch. Do not synthesize counts in that case.
    let linkage = db.prepare("SELECT DISTINCT c.repository_id, c.pull_request_id, p.state, p.merged_at, p.head_ref_name, c.repository_name FROM conversation_pr_context c LEFT JOIN github_pull_requests p ON p.repository_id = c.repository_id AND p.pull_request_id = c.pull_request_id AND p.number = c.number WHERE c.thread_id = ?");
    let mut linkage = linkage.ok();
    let name = machine_name(store);
    for thread in threads {
        thread["machineDisplayName"] = json!(name);
        thread["linkedWork"] = Value::Null;
        let Some(statement) = linkage.as_mut() else {
            continue;
        };
        let has_links = statement
            .exists([thread["id"].as_str().unwrap_or("")])
            .map_err(|_| ())?;
        if has_links {
            // The TS handler also asks its live GitHub broker for these rows,
            // adding PR state/change counts and updatedAt. Saved counts alone
            // cannot prove that full response. Keep the existing owner here.
            return Err(());
        }
        if thread["repoBranch"].as_str().is_some_and(|s| !s.is_empty()) {
            thread["linkedWork"] = json!({
                "pullRequests": {"total":0,"open":0,"merged":0,"closed":0},
                "branches":1
            });
        }
    }
    Ok(())
}

fn machine_name(store: &ReadContext<'_>) -> String {
    // The bridge passes the exact process-cached TS choice, including platform
    // naming rules. Standalone persisted readers can still use a chosen file.
    if let Ok(name) = std::env::var("O8D_MACHINE_DISPLAY_NAME") {
        return name;
    }
    if let Ok(raw) = std::fs::read_to_string(store.directory.join("computer-name")) {
        if let Some(name) = raw.lines().next().map(str::trim).filter(|s| !s.is_empty()) {
            return name.chars().take(80).collect();
        }
    }
    "This computer".to_owned()
}
