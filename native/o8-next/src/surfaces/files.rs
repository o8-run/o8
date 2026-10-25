//! Surface-owned shell registration; viewer behavior lives in its existing component.
use super::*;
#[path = "files/viewer.rs"]
mod component;
#[path = "files/requests.rs"]
mod requests;
pub(super) type View = component::Files;
#[path = "files/guard.rs"]
pub(crate) mod guard;
pub(super) type Slice = EmptyState;
#[path = "files/lifecycle.rs"]
mod lifecycle;
pub(super) type Runtime = lifecycle::Runtime;
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((4, || Command::Files)),
    create: |s, _, workspace, window, cx| {
        lifecycle::install(s, window, cx);
        let client = s.client.in_workspace(&workspace);
        let view = cx.new(|cx| component::Files::new(client, workspace.clone(), window, cx));
        lifecycle::remember(s, workspace, view.clone());
        Some(Content::Files(view))
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
            && let Some(Content::Files(view)) =
                s.active().and_then(|tab| s.content.get(&s.key(&tab)))
        {
            let view = view.clone();
            if !view.update(cx, |v, cx| v.request_close(cx)) {
                return true;
            }
            if let Some(workspace) = s.state.selected.clone() {
                lifecycle::forget(s, &workspace);
            }
        }
        false
    },
    ..Registration::new("Files", "Open file", |_, _, _, _| Some((Tab::Files, false)))
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
#[path = "files/tests.rs"]
mod tests;
