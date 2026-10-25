//! Workers owns its routes, retained task entities, filters and shell entry.
use super::*;
#[path = "workers/card.rs"]
mod card;
#[path = "workers/model.rs"]
mod model;
#[path = "workers/pane.rs"]
mod pane;
pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) type View = pane::Workers;
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((9, || Command::Workers)),
    create: |shell, _, workspace, _, cx| {
        let client = shell.client.in_workspace(&workspace);
        Some(Content::Workers(
            cx.new(|cx| View::new(client, workspace, cx)),
        ))
    },
    ..Registration::new("Workers", "Open Workers", |_, _, _, _| {
        Some((Tab::Workers, false))
    })
};
impl ShellView for View {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).focus.focus(window);
    }
    fn tick(view: &Entity<Self>, refresh: bool, cx: &mut Context<Shell>) {
        let shell = cx.weak_entity();
        let view = view.clone();
        cx.defer(move |cx| {
            let _ = shell.update(cx, |shell, cx| {
                if shell.active() == Some(Tab::Workers) {
                    view.update(cx, |view, cx| view.tick(refresh, cx));
                }
            });
        });
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool {
        !view.read(cx).loading
    }
}
#[cfg(test)]
#[path = "workers/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "workers/card_tests.rs"]
mod card_tests;

#[cfg(test)]
#[path = "workers/action_tests.rs"]
mod action_tests;
