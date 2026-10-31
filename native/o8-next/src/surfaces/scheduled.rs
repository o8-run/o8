//! Scheduled: the desktop AutomationsPage as a native tab. Local automations
//! (manual or cron prompts) and the connected agents' own schedules.
use super::*;

#[path = "scheduled/editor.rs"]
mod editor;
#[path = "scheduled/view.rs"]
mod view;

pub(super) type Slice = EmptyState;
pub(super) type Runtime = ();
pub(super) type View = view::Scheduled;
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((10, || Command::Scheduled)),
    create: |shell, _, _, window, cx| {
        Some(Content::Scheduled(cx.new(|cx| {
            view::Scheduled::new(shell.client.clone(), window, cx)
        })))
    },
    ..Registration::new("Scheduled", "Open scheduled automations", |_, _, _, _| {
        Some((Tab::Scheduled, false))
    })
};
impl ShellView for View {
    fn focus(view: &Entity<Self>, _: bool, window: &mut Window, cx: &mut Context<Shell>) {
        view.read(cx).focus.focus(window);
    }
    fn tick(view: &Entity<Self>, refresh: bool, cx: &mut Context<Shell>) {
        view.update(cx, |s, cx| s.tick(refresh, cx));
    }
    #[cfg(test)]
    fn ready(view: &Entity<Self>, cx: &App) -> bool {
        !view.read(cx).loading
    }
}

#[cfg(test)]
#[path = "scheduled/tests.rs"]
mod tests;
