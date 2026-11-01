//! Repository indexing and Brain totals use their existing Settings routes.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, div, prelude::*, px};

#[derive(Default)]
pub(super) struct State {
    busy: bool,
    entries: Option<Vec<Entry>>,
    error: Option<String>,
    counts_busy: bool,
    counts: Option<Counts>,
    counts_error: bool,
    jobs: BTreeMap<String, Job>,
}
#[derive(Default)]
struct Job {
    busy: bool,
    note: Option<String>,
    failed: bool,
}
#[derive(Deserialize)]
struct Index {
    entries: Vec<Entry>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    repo_id: String,
    repo_name: String,
    local_path: String,
    status: String,
    last_indexed_at: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Counts {
    ok: Option<bool>,
    directives_count: Option<u64>,
    outcomes_count: Option<u64>,
}
#[derive(Deserialize)]
struct Refresh {
    ok: bool,
    result: Option<Refreshed>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Refreshed {
    written_directives: Option<u64>,
    scanned_files: Option<u64>,
}
impl Settings {
    pub(super) fn load_indexing(&mut self, force: bool, cx: &mut Context<Self>) {
        if !self.indexing.busy
            && (force || self.indexing.entries.is_none() && self.indexing.error.is_none())
        {
            self.indexing.busy = true;
            self.indexing.error = None;
            let client = self.client.clone();
            let task = cx.background_executor().spawn(async move {
                client.settings_request::<Index>("GET", "/api/cortex/codebase-memory", Value::Null)
            });
            cx.spawn(async move |this, cx| {
                let result = task.await;
                let _ = this.update(cx, |this, cx| {
                    this.indexing.busy = false;
                    match result {
                        Ok(index) => this.indexing.entries = Some(index.entries),
                        Err(_) => {
                            this.indexing.entries = None;
                            this.indexing.error = Some(
                                "Could not read repository index state. Refresh to retry.".into(),
                            );
                        }
                    }
                    this.changed(cx);
                });
            })
            .detach();
        }
        if !self.indexing.counts_busy
            && (force || self.indexing.counts.is_none() && !self.indexing.counts_error)
        {
            self.indexing.counts_busy = true;
            self.indexing.counts_error = false;
            let client = self.client.clone();
            let task = cx.background_executor().spawn(async move {
                client.settings_request::<Counts>("GET", "/api/cortex/diagnostics", Value::Null)
            });
            cx.spawn(async move |this, cx| {
                let result = task.await;
                let _ = this.update(cx, |this, cx| {
                    this.indexing.counts_busy = false;
                    match result {
                        Ok(counts) if counts.ok != Some(false) => {
                            this.indexing.counts = Some(counts)
                        }
                        _ => {
                            this.indexing.counts = None;
                            this.indexing.counts_error = true;
                        }
                    }
                    this.changed(cx);
                });
            })
            .detach();
        }
        self.changed(cx);
    }
    fn refresh_docs(&mut self, entry: Entry, cx: &mut Context<Self>) {
        if self
            .indexing
            .jobs
            .get(&entry.repo_id)
            .is_some_and(|job| job.busy)
        {
            return;
        }
        self.indexing.jobs.insert(
            entry.repo_id.clone(),
            Job {
                busy: true,
                ..Default::default()
            },
        );
        let client = self.client.clone();
        let path = entry.local_path;
        let repo_id = entry.repo_id;
        let task = cx.background_executor().spawn(async move {
            client.settings_request::<Refresh>(
                "POST",
                "/api/cortex/reingest",
                json!({"repoPath":path}),
            )
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                let job = this.indexing.jobs.entry(repo_id).or_default();
                job.busy = false;
                match result {
                    Ok(Refresh { ok: true, result: Some(result) }) => {
                        job.failed = false;
                        job.note = Some(match (result.written_directives, result.scanned_files) {
                            (Some(written), Some(scanned)) => format!("{written} sections refreshed · {scanned} files scanned"),
                            _ => "Refresh accepted; result counts were not reported.".into(),
                        });
                    }
                    _ => { job.failed = true; job.note = Some("Could not confirm the document refresh. Retry when the runtime is available.".into()); }
                }
                this.changed(cx);
            });
        }).detach();
        self.changed(cx);
    }
    pub(super) fn indexing_view(&mut self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let mut content = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child("Repositories")
            .child(self.button(
                "setting-indexing-refresh".into(),
                "Refresh index state".into(),
                !self.indexing.busy && !self.indexing.counts_busy,
                false,
                window,
                cx,
                |this, _, cx| this.load_indexing(true, cx),
            ));
        if let Some(error) = &self.indexing.error {
            content = content.child(div().text_color(theme().danger).child(error.clone()));
        }
        if self.indexing.busy {
            content = content.child("Reading repository index…");
        }
        let entries = self.indexing.entries.clone().unwrap_or_default();
        if entries.is_empty() && !self.indexing.busy && self.indexing.error.is_none() {
            content = content.child("No repositories connected yet.");
        }
        for entry in entries {
            let job = self.indexing.jobs.get(&entry.repo_id);
            let busy = job.is_some_and(|job| job.busy);
            let note = job.and_then(|job| job.note.clone());
            let failed = job.is_some_and(|job| job.failed);
            let label = match entry.status.as_str() {
                "ready" => "Ready",
                "cached" => "Cached",
                "pending" => "Pending",
                "indexing" => "Indexing",
                "deferred" => "Deferred",
                "skipped" => "Skipped",
                "error" => "Error",
                _ => "Unknown",
            };
            let row = div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .py(px(12.))
                .border_b_1()
                .border_color(theme().border)
                .child(panels::fact(
                    &format!("settings-index-repo-{}", entry.repo_id),
                    &entry.repo_name,
                    label,
                ))
                .child(
                    div()
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child(
                            entry
                                .last_indexed_at
                                .clone()
                                .unwrap_or_else(|| entry.local_path.clone()),
                        ),
                )
                .child(
                    self.button(
                        format!("setting-index-docs-{}", entry.repo_id),
                        if busy {
                            "Refreshing…"
                        } else {
                            "Refresh docs"
                        }
                        .into(),
                        !busy,
                        false,
                        window,
                        cx,
                        move |this, _, cx| this.refresh_docs(entry.clone(), cx),
                    ),
                )
                .when_some(note, |row, note| {
                    row.child(
                        div()
                            .text_color(if failed {
                                theme().danger
                            } else {
                                theme().text_secondary
                            })
                            .child(note),
                    )
                });
            content = content.child(row);
        }
        content = content.child(div().text_size(px(11.)).text_color(theme().text_muted).child("Refresh docs re-reads repository documentation into Brain citations using the configured runtime."))
            .child("Engineering Brain");
        let counts = self.indexing.counts.as_ref();
        let unknown = if self.indexing.counts_busy {
            "Checking…"
        } else {
            "Unavailable"
        };
        content
            .child(panels::fact(
                "settings-index-directives",
                "Saved instructions",
                &counts
                    .and_then(|c| c.directives_count)
                    .map(|n| n.to_string())
                    .unwrap_or(unknown.into()),
            ))
            .child(panels::fact(
                "settings-index-outcomes",
                "Recorded task outcomes",
                &counts
                    .and_then(|c| c.outcomes_count)
                    .map(|n| n.to_string())
                    .unwrap_or(unknown.into()),
            ))
            .child(panels::fact(
                "settings-index-storage",
                "Knowledge storage",
                "Local",
            ))
            .into_any_element()
    }
}
#[cfg(test)]
#[path = "settings_indexing_tests.rs"]
mod tests;
