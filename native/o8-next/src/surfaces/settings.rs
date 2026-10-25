use super::*;
use crate::settings::Settings;
pub(super) type Slice = EmptyState;
#[derive(Default)]
pub(super) struct Runtime {
    pub view: Option<Entity<Settings>>,
    pub subscription: Option<gpui::Subscription>,
}
pub(super) const REGISTRATION: Registration = Registration {
    command: Some((6, || Command::Settings)),
    overlay_command: true,
    overlay: |s| {
        s.surfaces
            .settings
            .view
            .as_ref()
            .map(|v| v.clone().into_any_element())
    },
    overlay_open: |s| s.surfaces.settings.view.is_some(),
    focus_overlay: |s, window, cx| {
        if let Some(view) = &s.surfaces.settings.view {
            view.read(cx).focus(window);
            true
        } else {
            false
        }
    },
    before_tab: |s| {
        s.surfaces.settings.view = None;
        s.surfaces.settings.subscription = None;
    },
    nav: |_, position, cx| {
        if position != NavPosition::AfterWorkspaces {
            return vec![];
        }
        vec![
            div()
                .id("shell-settings")
                .debug_selector(|| "shell-settings".into())
                .cursor_pointer()
                .p(px(6.))
                .child("Settings")
                .on_click(cx.listener(|this, _, window, cx| this.open_settings(window, cx)))
                .into_any_element(),
        ]
    },
    key_down: |s, event, window, cx| {
        let key = event.keystroke.key.as_str();
        let modifiers = event.keystroke.modifiers;
        if (modifiers.control || modifiers.platform) && key == "," {
            if s.surfaces.settings.view.is_some() {
                s.close_settings(window, cx);
            } else {
                s.open_settings(window, cx);
            }
        } else if s.surfaces.settings.view.is_some()
            && modifiers.control
            && !modifiers.alt
            && key == "w"
        {
            s.close_settings(window, cx);
        } else {
            return false;
        }
        true
    },
    ..Registration::new("", "Open settings", |s, _, window, cx| {
        s.open_settings(window, cx);
        None
    })
};
impl Shell {
    fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.capture(window, cx);
        self.palette = false;
        self.surfaces.projects.open = false;
        let client = self.client.clone();
        let settings = cx.new(|cx| Settings::new(client, window, cx));
        self.surfaces.settings.subscription = Some(cx.subscribe_in(
            &settings,
            window,
            |this, _, _: &crate::settings::Close, window, cx| this.close_settings(window, cx),
        ));
        self.surfaces.settings.view = Some(settings);
        self.revision += 1;
        cx.notify();
    }
    fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.surfaces.settings.view = None;
        self.surfaces.settings.subscription = None;
        self.restore_focus(window, cx);
        self.revision += 1;
        cx.notify();
    }
}

#[cfg(test)]
#[path = "settings_shell_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "../settings_tests.rs"]
mod tests1;
