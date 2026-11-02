//! About uses the existing check-only updater route; it never installs an update.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, div, prelude::*, px};
use std::time::Duration;

#[derive(Deserialize)]
struct Identity {
    version: String,
}
#[derive(Deserialize)]
struct UpdateReply {
    ok: bool,
    state: Option<UpdateState>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateState {
    update_pending: bool,
    version: Option<String>,
    check: UpdateCheck,
}
#[derive(Deserialize)]
struct UpdateCheck {
    outcome: String,
}

impl Settings {
    pub(super) fn load_about(&mut self, force: bool, cx: &mut Context<Self>) {
        if self.about_busy || !force && (self.about_version.is_some() || self.about_error.is_some())
        {
            return;
        }
        self.about_busy = true;
        self.about_error = None;
        if force {
            self.about_version = None;
        }
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            client.settings_request::<Identity>("GET", "/api/setup/identity", Value::Null)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.about_busy = false;
                match result {
                    Ok(identity) if !identity.version.trim().is_empty() => {
                        this.about_version = Some(identity.version)
                    }
                    _ => {
                        this.about_error =
                            Some("Version information is unavailable. Refresh to retry.".into())
                    }
                }
                this.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    fn check_update(&mut self, cx: &mut Context<Self>) {
        if self.about_busy {
            return;
        }
        self.about_busy = true;
        self.about_status = "Checking for updates…".into();
        self.about_error = None;
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            let route = client
                .url("/api/panel/update/apply")
                .map_err(|_| "Update check is unavailable.")?;
            let response = client
                .request("POST", &route)
                .timeout(Duration::from_secs(40))
                .send_json(json!({"checkOnly":true}))
                .map_err(|_| "The update check could not finish. Try again.")?;
            let reply = Client::read::<UpdateReply>(response)
                .map_err(|_| "The update check returned no verified result.")?;
            if !reply.ok {
                return Err("The update check could not finish. Try again.");
            }
            let Some(state) = reply.state else {
                return Err("The update check returned no verified result.");
            };
            match (
                state.check.outcome.as_str(),
                state.update_pending,
                state.version,
            ) {
                ("current", false, _) => Ok("o8 is up to date.".to_string()),
                ("available", true, Some(version)) if !version.trim().is_empty() => {
                    Ok(format!("Update {version} is ready."))
                }
                _ => Err("The update check returned no verified result."),
            }
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                this.about_busy = false;
                this.about_status.clear();
                match result {
                    Ok(message) => this.about_status = message,
                    Err(error) => this.about_error = Some(error.into()),
                }
                this.changed(cx);
            });
        })
        .detach();
        self.changed(cx);
    }
    pub(super) fn about_view(&mut self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let mut content = div()
            .flex()
            .flex_col()
            .flex_shrink_0()
            .gap(px(16.))
            .child("Version")
            .child(panels::fact(
                "settings-about-version",
                "Version",
                self.about_version.as_deref().unwrap_or(if self.about_busy {
                    "Checking…"
                } else {
                    "Unavailable"
                }),
            ))
            .child(panels::fact(
                "settings-about-platform",
                "Platform",
                std::env::consts::OS,
            ))
            .child(panels::fact(
                "settings-about-mode",
                "Mode",
                if cfg!(debug_assertions) {
                    "Development"
                } else {
                    "Production"
                },
            ))
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child("Version identifies the connected o8 installation."),
            )
            .child(
                self.button(
                    "setting-about-check-updates".into(),
                    if self.about_busy {
                        "Checking…"
                    } else {
                        "Check for updates"
                    }
                    .into(),
                    !self.busy && !self.about_busy,
                    false,
                    window,
                    cx,
                    |this, _, cx| this.check_update(cx),
                ),
            );
        // Keep repeated checks in place as pending, success and error text changes.
        let mut feedback = div()
            .min_h(px(64.))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .gap(px(4.));
        if !self.about_status.is_empty() {
            feedback = feedback.child(
                div()
                    .debug_selector(|| "settings-about-update-result".into())
                    .child(self.about_status.clone()),
            );
        }
        if let Some(error) = &self.about_error {
            feedback = feedback.child(
                div()
                    .debug_selector(|| "settings-about-error".into())
                    .text_color(theme().danger)
                    .child(error.clone()),
            );
        }
        content = content.child(feedback);
        content = content.child("Links");
        for (id, label, url) in [
            ("github", "GitHub", "https://github.com/o8-run/o8"),
            (
                "docs",
                "Documentation",
                "https://github.com/o8-run/o8/tree/main/docs",
            ),
            (
                "releases",
                "Releases",
                "https://github.com/o8-run/o8/releases/latest",
            ),
        ] {
            content = content.child(self.button(
                format!("setting-about-{id}"),
                label.into(),
                true,
                false,
                window,
                cx,
                move |_, _, cx| cx.open_url(url),
            ));
        }
        content.child("Credits").child(div().text_size(px(11.)).text_color(theme().text_muted)
            .child("o8 next uses GPUI and the o8 runtime adapter system. Its desktop controls follow classic o8's design language."))
            .into_any_element()
    }
}

#[cfg(test)]
#[path = "settings_about_tests.rs"]
mod tests;
