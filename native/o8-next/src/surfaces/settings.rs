use super::*;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;

use crate::settings::Settings;
pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    pub view: Option<Entity<Settings>>,
    pub subscription: Option<gpui::Subscription>,
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
        let settings = cx.new(|cx| Settings::new(client, window, cx));
        self.surfaces.settings.subscription = Some(cx.subscribe_in(
            &settings,
            window,
            |this, _, _: &crate::settings::Close, window, cx| this.close_settings(window, cx),
        ));
        self.surfaces.settings.view = Some(settings);
        self.revision += 1;
        cx.notify();
    }
    fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.surfaces.settings.view = None;
        self.surfaces.settings.subscription = None;
        self.restore_focus(window, cx);
        self.revision += 1;
        cx.notify();
    }
}

// Request adapters compile with this surface through its existing shell entry.
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
        let request = self.request(method, &url);
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

#[cfg(test)]
#[path = "settings_shell_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../settings_tests.rs"]
mod tests1;
