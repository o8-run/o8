//! Usage: the desktop UsageWorkspace as a native tab. Account limits, then
//! cost and tokens from each CLI's own history on this machine.
use super::*;

#[path = "usage/format.rs"]
mod format;
#[path = "usage/history.rs"]
mod history;
#[path = "usage/view.rs"]
mod view;

pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) type View = view::Usage;
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((11, || Command::Usage)),
    create: |shell, _, _, window, cx| {
        Some(Content::Usage(
            cx.new(|cx| view::Usage::new(shell.client.clone(), window, cx)),
        ))
    },
    ..Registration::new("Usage", "Open usage", |_, _, _, _| {
        Some((Tab::Usage, false))
    })
};
impl ShellView for View {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).focus.focus(window);
    }
    fn tick(view: &Entity<Self>, _: bool, cx: &mut Context<Shell>) {
        view.update(cx, |s, cx| s.tick(cx));
    }
    fn refresh(view: &Entity<Self>, cx: &mut Context<Shell>) {
        view.update(cx, |s, cx| s.load(true, cx));
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool {
        !view.read(cx).loading
    }
}

#[cfg(test)]
#[path = "usage/tests.rs"]
mod tests;
