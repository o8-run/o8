use super::*;
pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) type View = crate::issues::Issues;
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((7, || Command::Issues)),
    create: |shell, _, workspace, window, cx| {
        Some(Content::Issues(cx.new(|cx| {
            crate::issues::Issues::new(shell.client.clone(), Some(workspace.clone()), window, cx)
        })))
    },
    ..Registration::new("Issues", "Open issues", |_, _, _, _| {
        Some((Tab::Issues, false))
    })
};
impl ShellView for View {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).focus(window, cx);
    }
    fn tick(view: &Entity<Self>, refresh: bool, cx: &mut Context<Shell>) {
        view.update(cx, |s, cx| s.tick(refresh, cx));
    }
    #[cfg(test)]
    fn ready(_: &Entity<Self>, _: &App) -> bool {
        false
    }
}

#[cfg(test)]
#[path = "../issue_tests.rs"]
mod tests;
