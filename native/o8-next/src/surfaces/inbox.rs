use super::*;
use serde_json::{Value, json};

use crate::inbox::{Inbox, OpenSession};
pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) type View = Inbox;
pub(super) const REGISTRATION: Registration = Registration {
    create,
    command: Some((1, || Command::Inbox)),
    global: true,
    ..Registration::new("Inbox", "Open Inbox", |_, _, _, _| {
        Some((Tab::Inbox, false))
    })
};
fn create(
    shell: &mut Shell,
    _tab: Tab,
    workspace: String,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> Option<Content> {
    let client = shell.client.in_workspace(&workspace);

    let inbox = cx.new(|cx| Inbox::new(client, workspace, cx));
    shell.subscriptions.push(cx.subscribe_in(
        &inbox,
        window,
        |this, _, event: &OpenSession, window, cx| {
            if let Some(session) = this
                .sessions
                .iter()
                .find(|s| s.key() == event.0 || s.id == event.0)
                .cloned()
            {
                if let Some(workspace) = session.repo_path {
                    this.switch(workspace, window, cx);
                }
                let id = session.id;
                this.execute(Command::Session(id.clone()), window, cx);
                if let Some(Content::Session(surface)) =
                    this.content.get(&this.key(&Tab::Session(id.clone())))
                {
                    surface.update(cx, |surface, cx| surface.shell_open(id, cx));
                }
                this.capture(window, cx);
                this.persist();
            } else {
                toasts::show(
                    toasts::Kind::Info,
                    "Related session is unavailable. Refresh the server connection and try again.",
                    vec![],
                    Some(toasts::NOTICE_TIMEOUT),
                    cx,
                );
                cx.notify();
            }
        },
    ));
    Some(Content::Inbox(inbox))
}
impl ShellView for Inbox {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).focus(window);
    }
    fn tick(view: &Entity<Self>, _: bool, cx: &mut Context<Shell>) {
        view.update(cx, |inbox, cx| inbox.tick(cx));
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool {
        view.read(cx).loaded && !view.read(cx).loading
    }
}

// Request adapters compile with this surface through its existing shell entry.
impl Client {
    /// The desktop Inbox's decision endpoint owns principal checks and durable resolution.
    pub fn inbox_decision(&self, id: &str, approve: bool) -> Result<Value, String> {
        let url = self.url("/api/panel/approvals").unwrap();
        let request = self.request("POST", &url);
        let request = self.with_desktop_identity(request);
        match request.send_json(json!({"id":id,"action":if approve {"approve"} else {"reject"}})) {
            Ok(response) => {
                let body: Value = Self::read(response)?;
                if body["ok"] == false {
                    return Err(body["error"].as_str().or(body["note"].as_str()).unwrap_or("Approval could not be resolved").into());
                }
                Ok(body)
            }
            Err(ureq::Error::Status(status, response)) => {
                let body = Self::read::<Value>(response).unwrap_or_default();
                Err(body["error"].as_str().or(body["note"].as_str())
                    .map(|message| format!("{message} (HTTP {status})")).unwrap_or_else(|| format!("Approval refused (HTTP {status})")))
            }
            Err(_) => Err("Decision unconfirmed. Refresh to inspect the recorded approval before another action.".into()),
        }
    }
}

#[cfg(test)]
#[path = "inbox_shell_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../inbox_tests.rs"]
mod tests1;
