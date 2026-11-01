use super::*;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;

use crate::settings::Settings;
pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    pub view: Option<Entity<Settings>>,
    // Every shell closer drops this slot, so action listeners share its lifetime.
    pub subscription: Option<(gpui::Subscription, gpui::Subscription)>,
}
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((6, || Command::Settings)),
    overlay_command: true,
    overlay: |s| {
        s.surfaces
            .settings
            .view
            .as_ref()
            .map(|v| v.clone().into_any_element())
    },
    overlay_open: |s| s.surfaces.settings.view.is_some(),
    focus_overlay: |s, window, cx| {
        if let Some(view) = &s.surfaces.settings.view {
            view.read(cx).focus(window);
            true
        } else {
            false
        }
    },
    before_tab: |s| {
        s.surfaces.settings.view = None;
        s.surfaces.settings.subscription = None;
    },
    key_down: |s, event, window, cx| {
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        if (modifiers.control || modifiers.platform) && key == "," {
            if s.surfaces.settings.view.is_some() {
                s.close_settings(window, cx);
            } else {
                s.open_settings(window, cx);
            }
        } else if s.surfaces.settings.view.is_some()
            && modifiers.control
            && !modifiers.alt
            && key == "w"
        {
            s.close_settings(window, cx);
        } else {
            return false;
        }
        true
    },
    ..Registration::new("", "Open settings", |s, _, window, cx| {
        s.open_settings(window, cx);
        None
    })
};
impl Shell {
    fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.capture(window, cx);
        self.palette = false;
        self.surfaces.projects.open = false;
        let client = self.client.clone();
        let providers = cx.new(|cx| providers::Providers::new(client.clone(), cx));
        let settings = cx.new(|cx| Settings::new(client, window, cx));
        settings.update(cx, |s, _| s.providers = Some(providers.into()));
        let close_subscription = cx.subscribe_in(
            &settings,
            window,
            |this, _, _: &crate::settings::Close, window, cx| this.close_settings(window, cx),
        );
        let action_subscription = cx.subscribe_in(
            &settings,
            window,
            |this, _, action: &crate::settings::Action, window, cx| match action {
                crate::settings::Action::Appearance(mode) => this.set_appearance(mode, window, cx),
                crate::settings::Action::Shortcuts => {
                    (super::shortcuts::REGISTRATION.open)(this, Command::Shortcuts, window, cx);
                }
            },
        );
        self.surfaces.settings.subscription = Some((close_subscription, action_subscription));
        self.surfaces.settings.view = Some(settings);
        self.revision += 1;
        cx.notify();
    }
    fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.surfaces.settings.view = None;
        self.surfaces.settings.subscription = None;
        self.restore_focus(window, cx);
        self.tick(false, window, cx);
        self.revision += 1;
        cx.notify();
    }
}

// Request adapters compile with this surface through its existing shell entry.
const SETTINGS_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Reads: the shared 5s agent timeout is shorter than operator-defaults takes
/// on a busy `next dev` server (2-7s). Provider-instance writes get the same
/// 15s: the first create on a cold server outlasted 5s, so the Add dialog
/// showed "Adding an instance…" and gave up while the server was still working.
/// Other writes keep the shared timeout so their outcome stays bounded.
pub(crate) fn settings_timeout(method: &str, path: &str) -> Option<std::time::Duration> {
    (method == "GET" || path.starts_with(providers::instance::INSTANCES))
        .then_some(SETTINGS_READ_TIMEOUT)
}

impl Client {
    /// Settings shares the existing operator bearer, loopback policy, redirect
    /// refusal, timeout and response bound. No credential response is retained.
    pub(crate) fn settings_request<T: DeserializeOwned>(
        &self,
        method: &str,
        path: &str,
        body: Value,
    ) -> Result<T, crate::settings::RequestError> {
        use crate::settings::RequestError;
        let url = self.url(path).map_err(|_| RequestError {
            status: None,
            message: "Invalid settings route".into(),
        })?;
        let mut request = self.request(method, &url);
        if let Some(timeout) = settings_timeout(method, path) {
            request = request.timeout(timeout);
        }
        let response = if method == "GET" {
            request.call()
        } else {
            request.send_json(body)
        };
        match response {
            Ok(response) => Self::read(response).map_err(|_| RequestError {
                status: None,
                message: "Invalid settings response. Refresh before trying again.".into(),
            }),
            Err(ureq::Error::Status(status, response)) => {
                #[derive(Deserialize)]
                struct ErrorBody {
                    error: String,
                }
                let detail = Self::read::<ErrorBody>(response).ok().map(|v| v.error);
                let message = if path.starts_with("/api/v2/keys") {
                    // Credential endpoints may include provider text. Only fixed
                    // route refusals may reach UI; never echo supplied key data.
                    match detail.as_deref() {
                        Some(
                            "Invalid API key"
                            | "Key cannot be empty"
                            | "No OpenRouter key is connected"
                            | "Turn the OpenRouter connection on before checking it",
                        ) => detail.unwrap(),
                        _ => format!(
                            "Key action refused (HTTP {status}). Previous keys were preserved."
                        ),
                    }
                } else {
                    detail.unwrap_or_else(|| format!("Settings request refused (HTTP {status})."))
                };
                Err(RequestError {
                    status: Some(status),
                    message,
                })
            }
            Err(_) => Err(RequestError {
                status: None,
                message: "The result is unconfirmed. Refresh settings before trying again.".into(),
            }),
        }
    }
}

// Settings › Providers lives with this surface; Settings only hosts its view.
#[path = "settings/providers.rs"]
pub(crate) mod providers;

#[cfg(test)]
#[path = "settings_shell_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../settings_tests.rs"]
mod tests1;
