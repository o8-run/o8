use super::*;
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
                this.notice =
                    "Related session is unavailable. Refresh the server connection and try again."
                        .into();
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

#[cfg(test)]
#[path = "inbox_shell_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../inbox_tests.rs"]
mod tests1;
