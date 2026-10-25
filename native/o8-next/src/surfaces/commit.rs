//! Surface-owned shell registration; viewer behavior lives in its existing component.
use super::*;
#[path = "commit/viewer.rs"]
mod component;
#[path = "commit/patch.rs"]
mod patch;
#[path = "commit/requests.rs"]
mod requests;
pub(super) type View = component::Commit;
#[path = "commit/guard.rs"]
pub(crate) mod guard;
pub(super) type Slice = EmptyState;
#[path = "commit/lifecycle.rs"]
mod lifecycle;
pub(super) type Runtime = lifecycle::Runtime;
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((4, || Command::Commit)),
    create: |s, _, workspace, window, cx| {
        lifecycle::install(s, window, cx);
        let client = s.client.in_workspace(&workspace);
        let view = cx.new(|cx| component::Commit::new(client, workspace.clone(), window, cx));
        lifecycle::remember(s, workspace, view.clone());
        Some(Content::Commit(view))
    },
    capture: lifecycle::capture,
    key_down: |s, event, _, cx| {
        if lifecycle::close_query(event) {
            return lifecycle::veto_close(s, cx);
        }
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
        {
            if view.read(cx).has_draft(cx) {
                s.notice = "Unsaved changes. Save or discard in the editor.".into();
                cx.notify();
                return true;
            }
            if let Some(workspace) = s.state.selected.clone() {
                lifecycle::forget(s, &workspace);
            }
        }
        false
    },
    ..Registration::new("Commit", "Open commit", |_, _, _, _| {
        Some((Tab::Commit, false))
    })
};
impl ShellView for View {
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
