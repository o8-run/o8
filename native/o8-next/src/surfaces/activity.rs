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

pub(super) type Slice = pane::preferences::Slice;
#[path = "activity/draft.rs"]
mod draft;
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
    let saved = shell
        .state
        .workspaces
        .get(&workspace)
        .map(|w| w.surfaces.activity.activity_preferences.clone())
        .unwrap_or_default();
    let open = shell
        .state
        .workspaces
        .values()
        .find_map(|w| w.surfaces.activity.activity_preferences.proposals_open)
        .unwrap_or(false);
    let mut seen = Vec::new();
    for w in shell.state.workspaces.values() {
        for id in &w.surfaces.activity.activity_preferences.seen {
            if !seen.contains(id) {
                seen.push(id.clone());
            }
        }
    }
    if seen.len() > 200 {
        seen.drain(..seen.len() - 200);
    }
    let activity = cx.new(|cx| ActivityPane::new(client, workspace.clone(), saved, open, seen, cx));
    let created_for = workspace.clone();
    shell.subscriptions.push(cx.subscribe_in(
        &activity,
        window,
        move |shell, _, event: &ActivityEvent, window, cx| match event {
            ActivityEvent::Draft(repo,text) => draft::open(shell,repo,text,window,cx),
            ActivityEvent::Preferences(saved) => {
                shell.state.workspaces.entry(created_for.clone()).or_default().surfaces.activity.activity_preferences=saved.clone();
                for w in shell.state.workspaces.values_mut(){w.surfaces.activity.activity_preferences.proposals_open=saved.proposals_open;w.surfaces.activity.activity_preferences.seen=saved.seen.clone();}
                shell.persist();
            }
            ActivityEvent::Worker(key) => {
                if let Some(session) = shell
                    .workspace_sessions()
                    .iter()
                    .find(|s| s.key() == *key || s.id == *key)
                    .cloned()
                {
                    shell.execute(Command::Session(session.id), window, cx);
                } else {
                    toasts::show(toasts::Kind::Info, "This worker is not available in the selected workspace. Refresh the session list.", vec![], Some(toasts::NOTICE_TIMEOUT), cx);
                    cx.notify();
                }
            }
            ActivityEvent::Diff(id) => {
                if let Some(state) = shell.state.workspaces.get_mut(&workspace) {
                    state.surfaces.diff.diff_packet = Some(id.clone());
                }
                let key = shell.key(&Tab::Diff);
                shell.content.remove(&key);
                shell.execute(Command::Diff, window, cx);
            }
            ActivityEvent::Open(url) => shell.open_link(url, window, cx),
        },
    ));
    Some(Content::Activity(activity))
}

impl ShellView for ActivityPane {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.update(cx, |pane, cx| {
            pane.focus(window);
            pane.load_dossiers(cx);
            pane.load_proposals(cx);
        });
    }

    fn tick(view: &Entity<Self>, refresh: bool, cx: &mut Context<Shell>) {
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
                if main || shell.panel_shows(|key| shows(key)) {
                    view.update(cx, |activity, cx| {
                        activity.tick(cx);
                        if refresh {
                            activity.load_dossiers(cx);
                            activity.load_proposals(cx);
                        }
                    });
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
#[path = "activity/dossier_tests.rs"]
mod dossier_tests;
#[cfg(test)]
#[path = "activity/identity_tests.rs"]
mod identity_tests;
#[cfg(test)]
#[path = "activity/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "activity/packet_tests.rs"]
mod packet_tests;
