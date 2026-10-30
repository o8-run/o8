use super::*;
use crate::devices_panel::DevicesPanel;
#[derive(Default)]
struct State {
    view: Option<gpui::Entity<DevicesPanel>>,
}
struct Devices;
register_shell_feature!(Devices);
impl ShellFeature for Devices {
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 51,
            run: |s, _, window, cx| {
                let active = super::right_panel::devices_visible(s) && window.is_window_active();
                if active && s.features.get::<State>().view.is_none() {
                    let client = s.client.clone();
                    let view = cx.new(|cx| DevicesPanel::new(client, cx));
                    view.read(cx).focus(window);
                    s.features.get::<State>().view = Some(view);
                }
                if let Some(view) = s.features.get::<State>().view.clone() {
                    view.update(cx, |view, cx| view.activate(active, cx));
                }
            },
        }]
    }
}
pub(super) fn element(s: &Shell, _: &mut Context<Shell>) -> gpui::AnyElement {
    s.features
        .read::<State>()
        .and_then(|s| s.view.clone())
        .map(|view| view.into_any_element())
        .unwrap_or_else(|| div().into_any_element())
}

pub(super) fn sync_visibility(s: &Shell, window: &Window, cx: &mut Context<Shell>) {
    if let Some(view) = s.features.read::<State>().and_then(|s| s.view.clone()) {
        let active = super::right_panel::devices_visible(s) && window.is_window_active();
        view.update(cx, |view, cx| view.activate(active, cx));
    }
}
