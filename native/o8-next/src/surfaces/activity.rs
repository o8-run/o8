//! Activity owns its shell registration, view, transport and regression fixtures.
use super::*;
use pane::{ActivityEvent, ActivityPane};

#[path = "activity/feed.rs"]
pub(crate) mod feed;
#[path = "activity/marks.rs"]
mod marks;
#[path = "activity/pane.rs"]
mod pane;
#[path = "activity/transport.rs"]
mod transport;

pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) type View = ActivityPane;
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((4, || Command::Activity)),
    create,
    ..Registration::new("Activity", "Open Activity", |_, _, _, _| {
        Some((Tab::Activity, false))
    })
};

fn create(
    shell: &mut Shell,
    _: Tab,
    workspace: String,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> Option<Content> {
    let client = shell.client.in_workspace(&workspace);
    let activity = cx.new(|cx| ActivityPane::new(client, workspace, cx));
    shell.subscriptions.push(cx.subscribe_in(
        &activity,
        window,
        |shell, _, event: &ActivityEvent, window, cx| match event {
            ActivityEvent::Worker(key) => {
                if let Some(session) = shell
                    .workspace_sessions()
                    .iter()
                    .find(|s| s.key() == *key || s.id == *key)
                    .cloned()
                {
                    shell.execute(Command::Session(session.id), window, cx);
                } else {
                    shell.notice = "This worker is not available in the selected workspace. Refresh the session list.".into();
                    cx.notify();
                }
            }
        },
    ));
    Some(Content::Activity(activity))
}

impl ShellView for ActivityPane {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).focus(window);
    }

    fn tick(view: &Entity<Self>, _: bool, cx: &mut Context<Shell>) {
        // Inspect the active workspace after the shell's current borrow is returned.
        let shell = cx.weak_entity();
        let view = view.clone();
        cx.defer(move |cx| {
            let _ = shell.update(cx, |shell, cx| {
                let shows = |key: &str| {
                    matches!(shell.content.get(key),
                        Some(Content::Activity(current)) if current == &view)
                };
                // The main area's Activity tab, or Activity in front in the right panel.
                let main =
                    shell.active() == Some(Tab::Activity) && shows(&shell.key(&Tab::Activity));
                if main || shell.panel_front_key().is_some_and(|key| shows(&key)) {
                    view.update(cx, |activity, cx| activity.tick(cx));
                }
            });
        });
    }

    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool {
        view.read(cx).ready()
    }
}

#[cfg(test)]
#[path = "activity/identity_tests.rs"]
mod identity_tests;
#[cfg(test)]
#[path = "activity/tests.rs"]
mod tests;
