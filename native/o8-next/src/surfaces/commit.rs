//! Surface-owned shell registration; viewer behavior lives in its existing component.
use super::*;
#[path = "commit/viewer.rs"]
mod component;
#[path = "commit/requests.rs"]
mod requests;
pub(super) type View = component::Commit;
#[path = "commit/guard.rs"]
pub(crate) mod guard;
pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((4, || Command::Commit)),
    create: |s, _, workspace, window, cx| {
        let weak = cx.weak_entity();
        window.on_window_should_close(cx, move |window, cx| {
            weak.update(cx, |s, cx| {
                if s.content.values().any(|content| content.has_draft(cx)) {
                    s.notice = "Unsaved changes. Save or discard in the editor.".into();
                    cx.notify();
                    return false;
                }
                s.capture(window, cx);
                s.persist();
                true
            })
            .unwrap_or(false)
        });
        let client = s.client.in_workspace(&workspace);
        Some(Content::Commit(cx.new(|cx| {
            component::Commit::new(client, workspace, window, cx)
        })))
    },
    key_down: |s, event, _, cx| {
        let m = event.keystroke.modifiers;
        if !s.palette
            && !registrations().iter().any(|r| (r.overlay_open)(s))
            && m.control
            && !m.alt
            && !m.platform
            && !m.shift
            && event.keystroke.key == "w"
            && let Some(Content::Commit(view)) =
                s.active().and_then(|tab| s.content.get(&s.key(&tab)))
            && view.read(cx).has_draft(cx)
        {
            s.notice = "Unsaved changes. Save or discard in the editor.".into();
            cx.notify();
            return true;
        }
        false
    },
    ..Registration::new("Commit", "Open commit", |_, _, _, _| {
        Some((Tab::Commit, false))
    })
};
impl ShellView for View {
    fn has_draft(view: &Entity<Self>, cx: &App) -> bool {
        view.read(cx).has_draft(cx)
    }
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).focus(window, cx);
    }
    #[cfg(test)]
    fn ready(_view: &Entity<Self>, _cx: &App) -> bool {
        false
    }
}
#[cfg(test)]
#[path = "commit/tests.rs"]
mod tests;
