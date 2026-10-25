use super::*;
pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) type View = crate::brain::Brain;
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((0, || Command::Brain)),
    create: |shell, _, workspace, window, cx| {
        let client = shell.client.in_workspace(&workspace);
        Some(Content::Brain(cx.new(|cx| {
            crate::brain::Brain::new(client, workspace, None, window, cx)
        })))
    },
    ..Registration::new("Brain", "Open Brain", |_, _, _, _| {
        Some((Tab::Brain, false))
    })
};
impl ShellView for View {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).focus(window, cx);
    }

    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool {
        view.read(cx).painted.get() == view.read(cx).revision
    }
}

#[cfg(test)]
#[path = "../brain_tests.rs"]
mod tests;
