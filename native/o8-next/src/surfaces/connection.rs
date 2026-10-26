//! Local connection policy, credential refresh, recovery focus and error UI.
use super::registry::{Frame, KeyResult, ShellExtension};
use super::*;
use crate::theme::current as theme;
use std::io::Read;

pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    hidden: bool,
    restore: Option<(Option<String>, FocusHandle)>,
    status: Option<Entity<Status>>,
}
pub(super) const REGISTRATION: Registration = Registration {
    extension: Some(&Connection),
    overlay: |s| {
        if !s.connected {
            s.surfaces
                .connection
                .status
                .as_ref()
                .map(|v| v.clone().into_any_element())
        } else {
            None
        }
    },
    overlay_open: |s| s.surfaces.connection.hidden,
    ..Registration::new("", "", |_, _, _, _| None)
};
struct Connection;
fn management(s: &Shell) -> bool {
    registrations()
        .iter()
        .any(|r| r.overlay_command && (r.overlay_open)(s))
}
fn key(s: &Shell) -> Option<String> {
    s.active().map(|tab| s.key(&tab))
}

fn refresh(client: &Client) -> Result<Client, String> {
    let origin = client.url("/").unwrap();
    if std::env::var("O8_NEXT_TOKEN_ORIGIN").ok().as_deref()
        != Some(origin.origin().ascii_serialization().as_str())
    {
        return Ok(client.clone());
    }
    let files = if let Ok(files) = std::env::var("O8_NEXT_TOKEN_FILES") {
        serde_json::from_str::<Vec<PathBuf>>(&files)
            .ok()
            .filter(|files| {
                (1..=2).contains(&files.len()) && files.iter().all(|file| file.is_absolute())
            })
    } else {
        std::env::var("O8_NEXT_TOKEN_FILE")
            .ok()
            .map(PathBuf::from)
            .filter(|file| file.is_absolute())
            .map(|file| vec![file])
    };
    let Some(files) = files else {
        return Ok(client.clone());
    };
    let token = files.iter().find_map(|file| {
        let mut bytes = vec![];
        let input = std::fs::File::open(file).ok()?;
        input.take(16 * 1024 + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() > 16 * 1024 {
            return None;
        }
        String::from_utf8(bytes)
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty())
    });
    client.refresh_bearer(token)?;
    Ok(client.clone())
}
impl ShellExtension for Connection {
    fn load(&self, shell: &mut Shell, cx: &mut Context<Shell>) -> bool {
        if shell.loading {
            return true;
        }
        let client = match refresh(&shell.client) {
            Ok(client) => client,
            Err(_) => {
                shell.connected = false;
                shell.notice = "Token rejected".into();
                cx.notify();
                return true;
            }
        };
        shell.client = client.clone();
        // Main's registered catalog loader owns the retained sidebar. Its client
        // clones share the refreshed transport, so recovery must use that loader.
        if registrations()
            .iter()
            .any(|registration| (registration.load)(shell, cx))
        {
            return true;
        }
        shell.loading = true;
        let missing = client
            .request("GET", &client.url("/").unwrap())
            .header("Authorization")
            .is_none();
        let task = cx.background_executor().spawn(async move {
            let sessions = client.sessions()?;
            let mut load = WorkspaceLoad {
                paths: sessions
                    .iter()
                    .filter_map(|s| s.repo_path.clone())
                    .collect(),
                active_project: None,
            };
            for registration in registrations() {
                (registration.workspaces)(&client, &mut load);
            }
            Ok::<_, String>((sessions, load))
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |s, cx| {
                s.loading = false;
                match result {
                    Ok((sessions, load)) => {
                        let recovering = !s.connected;
                        let selected = s.state.selected.clone();
                        s.sessions = sessions;
                        s.workspaces = load.paths.into_iter().collect();
                        s.connected = true;
                        let active = load.active_project.as_ref().unwrap_or(&s.workspaces);
                        if !s
                            .state
                            .selected
                            .as_ref()
                            .is_some_and(|w| active.contains(w))
                        {
                            s.state.selected = active.first().cloned();
                        }
                        if recovering {
                            s.notice.clear();
                        }
                        if selected != s.state.selected {
                            s.persist();
                        }
                    }
                    Err(error) => {
                        s.connected = false;
                        s.notice = if error.contains("HTTP 401") || error.contains("HTTP 403") {
                            if missing {
                                "Token missing"
                            } else {
                                "Token rejected"
                            }
                        } else {
                            "Server down"
                        }
                        .into();
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
        true
    }
    fn prepare(&self, s: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
        if !s.loading {
            if !s.connected && s.notice.starts_with("Local server unavailable:") {
                s.notice = if s.notice.contains("HTTP 401") || s.notice.contains("HTTP 403") {
                    if s.client
                        .request("GET", &s.client.url("/").unwrap())
                        .header("Authorization")
                        .is_none()
                    {
                        "Token missing"
                    } else {
                        "Token rejected"
                    }
                } else {
                    "Server down"
                }
                .into();
            }
            report_startup(s.connected);
        }
        if !s.connected && !management(s) {
            if !s.surfaces.connection.hidden {
                s.capture(window, cx);
                s.surfaces.connection.restore = window.focused(cx).map(|focus| (key(s), focus));
                s.surfaces.connection.hidden = true;
            }
            s.focus.focus(window);
        } else if s.connected && s.surfaces.connection.hidden {
            s.surfaces.connection.hidden = false;
            if let Some((saved, focus)) = s.surfaces.connection.restore.take()
                && saved == key(s)
            {
                focus.focus(window);
            } else {
                s.restore_focus(window, cx);
            }
        }
        let weak = cx.weak_entity();
        let status = s
            .surfaces
            .connection
            .status
            .get_or_insert_with(|| {
                cx.new(|_| Status {
                    shell: weak,
                    text: String::new(),
                    loading: true,
                })
            })
            .clone();
        let text = if s.notice.is_empty() {
            "Connecting…".into()
        } else {
            s.notice.clone()
        };
        let loading = s.loading;
        status.update(cx, |v, cx| {
            if v.text != text || v.loading != loading {
                v.text = text;
                v.loading = loading;
                cx.notify();
            }
        });
    }
    fn tick(&self, s: &mut Shell, refresh: bool, window: &mut Window, cx: &mut Context<Shell>) {
        self.prepare(s, window, cx);
        if refresh {
            s.load(cx);
        }
    }
    fn frame(&self, s: &Shell) -> Option<Frame> {
        Some(Frame {
            status: s.connected && !s.notice.is_empty(),
            retry: false,
            ..Frame::default()
        })
    }
    fn allow_command(&self, s: &Shell, command: &Command) -> bool {
        s.connected
            || matches!(command, Command::Refresh | Command::Shortcuts)
            || command.registration().overlay_command
    }
    fn allow_switch(&self, s: &Shell) -> bool {
        s.connected
    }
    fn key(
        &self,
        s: &mut Shell,
        e: &KeyDownEvent,
        _: &mut Window,
        cx: &mut Context<Shell>,
    ) -> KeyResult {
        if s.connected || management(s) || s.palette {
            return KeyResult::Unhandled;
        }
        let k = &e.keystroke;
        if k.key == "f5" {
            s.load(cx);
            return KeyResult::Handled;
        }
        if (k.modifiers.control || k.modifiers.platform)
            && ["k", ",", "p"].contains(&k.key.as_str())
        {
            return KeyResult::Unhandled;
        }
        KeyResult::Handled
    }
}
pub(super) struct Status {
    shell: gpui::WeakEntity<Shell>,
    text: String,
    loading: bool,
}
impl Render for Status {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .debug_selector(|| "connection-state".into())
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap(px(16.))
            .child(
                div()
                    .debug_selector(|| "shell-status".into())
                    .child(self.text.clone()),
            )
            .when(!self.loading, |view| {
                view.child(
                    div()
                        .id("shell-retry")
                        .debug_selector(|| "shell-retry".into())
                        .p(px(8.))
                        .bg(theme().surface_raised)
                        .cursor_pointer()
                        .child("Retry")
                        .on_click(cx.listener(|s, _, _, cx| {
                            let _ = s.shell.update(cx, |shell, cx| shell.load(cx));
                        })),
                )
            })
    }
}
#[cfg(test)]
#[path = "connection_tests.rs"]
mod tests;
