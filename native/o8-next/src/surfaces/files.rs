//! Opt-in read-only Files registration. No draft or mutation lifecycle.
use super::*;
#[path = "files/viewer.rs"]
mod component;
#[path = "files/guard.rs"]
pub(crate) mod guard;
#[path = "files/requests.rs"]
mod requests;
#[path = "files/source.rs"]
mod source;
pub(super) type View = component::Files;
pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((5, || Command::Files)),
    create: |s, _, workspace, window, cx| {
        let client = s.client.in_workspace(&workspace);
        Some(Content::Files(
            cx.new(|cx| View::new(client, workspace, window, cx)),
        ))
    },
    ..Registration::new("Files", "Open file", |_, _, _, _| Some((Tab::Files, false)))
};
impl ShellView for View {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).focus(window, cx);
    }
    #[cfg(test)]
    fn ready(_: &Entity<Self>, _: &App) -> bool {
        false
    }
}
#[cfg(test)]
#[path = "files/tests.rs"]
mod tests;
