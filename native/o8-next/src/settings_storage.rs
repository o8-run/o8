//! Workspace accounting is read-only here; unknown measurements stay unknown.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, div, prelude::*, px};

#[derive(Default)]
pub(super) struct State {
    busy: bool,
    usage: Option<Usage>,
    error: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    accounting_status: String,
    total_allocated_bytes: Option<u64>,
    total_logical_bytes: Option<u64>,
    storage_admission: Option<Admission>,
    storage_pressure: Option<Pressure>,
    category_storage: Option<Categories>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Admission {
    physical_available_bytes: Option<u64>,
    reserved_bytes: Option<u64>,
    dispatch_headroom_bytes: Option<i64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pressure {
    parked_workspaces: Option<u64>,
    eligible_repositories: Option<u64>,
    opted_out_repositories: Option<u64>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Categories {
    measured_at: Option<String>,
    categories: BTreeMap<String, Category>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Category {
    allocated_bytes: Option<u64>,
    logical_bytes: Option<u64>,
    measurement_method: Option<String>,
}
fn bytes(value: Option<u64>) -> String {
    let Some(value) = value else {
        return "Unknown".into();
    };
    for (size, unit) in [
        (1_u64 << 40, "TiB"),
        (1 << 30, "GiB"),
        (1 << 20, "MiB"),
        (1 << 10, "KiB"),
    ] {
        if value >= size {
            return format!("{:.1} {unit}", value as f64 / size as f64);
        }
    }
    format!("{value} B")
}
impl Settings {
    pub(super) fn load_storage(&mut self, force: bool, cx: &mut Context<Self>) {
        if self.storage.busy
            || !force && (self.storage.usage.is_some() || self.storage.error.is_some())
        {
            return;
        }
        self.storage.busy = true;
        self.storage.usage = None;
        self.storage.error = None;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let url = client
                .url("/api/worktrees/retention-usage")
                .map_err(|_| ())?;
            // A partial response can still contain useful measured categories.
            let response = match client.request("GET", &url).call() {
                Ok(response) | Err(ureq::Error::Status(_, response)) => response,
                Err(_) => return Err(()),
            };
            let successful = (200..300).contains(&response.status());
            Client::read::<Usage>(response)
                .map(|usage| (usage, successful))
                .map_err(|_| ())
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.storage.busy = false;
                match result {
                    Ok((usage, successful)) if matches!(usage.accounting_status.as_str(), "observed" | "partial" | "unknown") => {
                        if !successful || usage.accounting_status != "observed" { this.storage.error = Some("Some storage accounting is unknown. Reported measurements are shown below.".into()); }
                        this.storage.usage = Some(usage);
                    }
                    _ => this.storage.error = Some("Storage measurement is unavailable. Refresh to retry.".into()),
                }
                this.changed(cx);
            });
        }).detach();
        self.changed(cx);
    }
    pub(super) fn storage_view(&mut self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let mut content = div()
            .flex()
            .flex_col()
            .gap(px(16.))
            .child("Storage usage")
            .child(
                self.button(
                    "setting-storage-refresh".into(),
                    if self.storage.busy {
                        "Measuring…"
                    } else {
                        "Refresh usage"
                    }
                    .into(),
                    !self.storage.busy,
                    false,
                    window,
                    cx,
                    |this, _, cx| this.load_storage(true, cx),
                ),
            );
        if let Some(error) = &self.storage.error {
            content = content.child(
                div()
                    .debug_selector(|| "settings-storage-error".into())
                    .text_color(theme().warning)
                    .child(error.clone()),
            );
        }
        let usage = self.storage.usage.as_ref();
        let admission = usage.and_then(|usage| usage.storage_admission.as_ref());
        for (id, label, value) in [
            (
                "allocated",
                "Disk space used",
                usage.and_then(|usage| usage.total_allocated_bytes),
            ),
            (
                "logical",
                "Total file size",
                usage.and_then(|usage| usage.total_logical_bytes),
            ),
            (
                "free",
                "Free on disk",
                admission.and_then(|a| a.physical_available_bytes),
            ),
            (
                "reserved",
                "Set aside for tasks",
                admission.and_then(|a| a.reserved_bytes),
            ),
            (
                "headroom",
                "Available for new tasks",
                // Match classic: a reserve shortfall means zero available for new tasks.
                admission
                    .and_then(|a| a.dispatch_headroom_bytes)
                    .map(|bytes| bytes.max(0) as u64),
            ),
        ] {
            content = content.child(panels::fact(
                &format!("settings-storage-{id}"),
                label,
                &bytes(value),
            ));
        }
        let pressure = usage.and_then(|usage| usage.storage_pressure.as_ref());
        content = content.child("Fleet parking");
        for (id, label, value) in [
            (
                "parked",
                "Parked",
                pressure.and_then(|p| p.parked_workspaces),
            ),
            (
                "eligible",
                "Eligible repos",
                pressure.and_then(|p| p.eligible_repositories),
            ),
            (
                "opted-out",
                "Opted out",
                pressure.and_then(|p| p.opted_out_repositories),
            ),
        ] {
            content = content.child(panels::fact(
                &format!("settings-storage-{id}"),
                label,
                &value.map(|n| n.to_string()).unwrap_or("Unknown".into()),
            ));
        }
        content = content.child("Storage categories");
        let categories = usage.and_then(|usage| usage.category_storage.as_ref());
        if let Some(measured) = categories.and_then(|c| c.measured_at.as_ref()) {
            content = content.child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child(format!("Measured {measured}")),
            );
        }
        for (id, label) in [
            ("source", "Source files"),
            ("dependency", "Dependencies"),
            ("build", "Build output"),
            ("runtime", "Runtime state"),
            ("transcript", "Transcripts"),
        ] {
            let category = categories.and_then(|categories| categories.categories.get(id));
            content = content
                .child(panels::fact(
                    &format!("settings-storage-category-{id}"),
                    label,
                    &format!(
                        "{} allocated · {} logical",
                        bytes(category.and_then(|c| c.allocated_bytes)),
                        bytes(category.and_then(|c| c.logical_bytes))
                    ),
                ))
                .when_some(
                    category.and_then(|c| c.measurement_method.as_ref()),
                    |v, method| {
                        v.child(
                            div()
                                .text_size(px(11.))
                                .text_color(theme().text_muted)
                                .child(method.clone()),
                        )
                    },
                );
        }
        content.into_any_element()
    }
}
#[cfg(test)]
#[path = "settings_storage_tests.rs"]
mod tests;
