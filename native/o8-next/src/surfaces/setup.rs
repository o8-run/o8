//! First-run policy and registration; the view uses the desktop setup routes.
use super::*;
use serde_json::Value;
#[path = "setup/view.rs"]
mod view;
pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    pub view: Option<Entity<view::Setup>>,
    first_run_checked: Cell<bool>,
}
pub(super) const REGISTRATION: Registration = Registration {
    extension: Some(&SetupPolicy),
    key_down: |s, _, _, cx| block_navigation(s, cx),
    overlay_command: true,
    overlay: |s| {
        s.surfaces
            .setup
            .view
            .as_ref()
            .map(|v| v.clone().into_any_element())
    },
    overlay_open: |s| s.surfaces.setup.view.is_some(),
    block_ensure: |s| s.surfaces.setup.view.is_some(),
    before_tab: |s| s.surfaces.setup.view = None,
    nav: |s, position, cx| {
        if position != NavPosition::BeforeWorkspaces {
            return vec![];
        }
        if s.connected && !s.loading && !s.surfaces.setup.first_run_checked.replace(true) {
            let shell = cx.weak_entity();
            cx.defer(move |cx| {
                let _ = shell.update(cx, |s, cx| {
                    if !s.sessions.iter().any(|session| session.repo_path.is_some()) {
                        s.open_setup(cx);
                    }
                });
            });
        }
        let mut nav = vec![
            div()
                .id("setup-open")
                .debug_selector(|| "setup-open".into())
                .cursor_pointer()
                .p(px(6.))
                .child("Setup")
                .on_click(cx.listener(|s, _, window, cx| {
                    s.capture(window, cx);
                    s.execute(Command::Setup, window, cx);
                }))
                .into_any_element(),
        ];
        if s.surfaces.setup.view.is_some() {
            nav.push(
                div()
                    .id("setup-close")
                    .debug_selector(|| "setup-close".into())
                    .cursor_pointer()
                    .p(px(6.))
                    .child("Close setup")
                    .on_click(cx.listener(|s, _, window, cx| {
                        if s.surfaces
                            .setup
                            .view
                            .as_ref()
                            .is_some_and(|v| v.read(cx).busy())
                        {
                            return;
                        }
                        s.surfaces.setup.view = None;
                        s.restore_focus(window, cx);
                        s.revision += 1;
                        cx.notify();
                    }))
                    .into_any_element(),
            );
        }
        nav
    },
    ..Registration::new("", "Open setup", |s, _, _, cx| {
        s.open_setup(cx);
        None
    })
};
fn block_navigation(s: &mut Shell, cx: &mut Context<Shell>) -> bool {
    if s.surfaces
        .setup
        .view
        .as_ref()
        .is_some_and(|v| v.read(cx).busy())
    {
        s.notice = "Wait for setup to finish before opening another surface.".into();
        cx.notify();
        true
    } else {
        false
    }
}
struct SetupPolicy;
impl registry::ShellExtension for SetupPolicy {
    fn action(
        &self,
        s: &mut Shell,
        _: &crate::keymap::Shortcut,
        _: &mut Window,
        cx: &mut Context<Shell>,
    ) -> bool {
        block_navigation(s, cx)
    }
}
impl Shell {
    fn open_setup(&mut self, cx: &mut Context<Self>) {
        if self.surfaces.setup.view.is_some() {
            return;
        }
        let setup = cx.new(|cx| view::Setup::new(self.client.clone(), cx));
        self.subscriptions
            .push(cx.subscribe(&setup, |s, _, opened: &view::Opened, cx| {
                if let Some(session) = &opened.0
                    && let Some(path) = &session.repo_path
                {
                    s.state.selected = Some(path.clone());
                    if !s.workspaces.contains(path) {
                        s.workspaces.push(path.clone());
                    }
                    if !s.sessions.iter().any(|v| v.id == session.id) {
                        s.sessions.push(session.clone());
                    }
                    let saved = s.state.workspaces.entry(path.clone()).or_default();
                    saved.tabs.push(Tab::Session(session.id.clone()));
                    saved.active = saved.tabs.len() - 1;
                    saved.composer = true;
                }
                s.surfaces.setup.view = None;
                s.connected = true;
                s.persist();
                s.revision += 1;
                cx.notify();
            }));
        self.surfaces.setup.view = Some(setup);
        self.revision += 1;
        cx.notify();
    }
}
impl Client {
    /// Keep the existing request/refusal contract with the surface registration.
    fn setup_request(&self, method: &str, path: &str, body: &Value) -> Result<Value, String> {
        let url = self.url(path).map_err(|_| "Invalid project route")?;
        let request = self.request(method, &url);
        let response = if method == "GET" {
            request.call()
        } else {
            request.send_json(body.clone())
        };
        match response {
            Ok(response) => Self::read(response),
            Err(ureq::Error::Status(status, response)) => {
                let data = Self::read::<Value>(response).unwrap_or(Value::Null);
                let message = data["error"].as_str().unwrap_or("Project request refused");
                let note = data["note"].as_str().unwrap_or("");
                Err(format!("{} (HTTP {status}). {}", message.chars().take(512).collect::<String>(), note.chars().take(512).collect::<String>()))
            }
            Err(_) => Err("Could not reach the selected server. Refresh to check saved state before retrying.".into()),
        }
    }
}

#[cfg(test)]
#[path = "setup/tests.rs"]
mod tests;
