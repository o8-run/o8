use super::*;
struct Keymap;
register_shell_feature!(Keymap);
#[derive(Default)]
struct Observers {
    subscriptions: Vec<gpui::Subscription>,
}
impl ShellFeature for Keymap {
    fn bind_input(&self, root: gpui::Div, s: &Shell, cx: &mut Context<Shell>) -> gpui::Div {
        bind_root(root, s, cx)
    }
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 100,
            dispatch: |s, event, window, cx| {
                if !shortcuts::owns_input(s, event) {
                    return KeyResult::Unhandled;
                }
                if !(shortcuts::REGISTRATION.key_down)(s, event, window, cx) {
                    // Main dismisses Projects before legacy Ctrl+Tab advances.
                    action(s, &crate::keymap::Shortcut::NextSurface, window, cx);
                }
                KeyResult::Handled
            },
        }]
    }
    fn observers(&self) -> &'static [PreferenceObserver] {
        &[PreferenceObserver {
            order: -10,
            install: |s, _, cx| {
                crate::keymap::install(cx);
                s.palette_input
                    .update(cx, |input, _| input.context = "TextInput Palette");
                let input = s.palette_input.clone();
                let subscription = cx.observe(&input, |s, input, cx| {
                    s.query = input.read(cx).text.clone();
                    s.choice = 0;
                    cx.notify();
                });
                s.features
                    .get::<Observers>()
                    .subscriptions
                    .push(subscription);
            },
        }]
    }
}
fn bind_root(root: gpui::Div, s: &Shell, cx: &mut Context<Shell>) -> gpui::Div {
    let context = if s.surfaces.shortcuts.view.is_some() {
        "Global Reference Modal Overlay"
    } else if s.shortcuts {
        "Global Shortcuts Modal Overlay"
    } else if s.palette {
        "Global Palette Overlay"
    } else if s.surfaces.settings.view.is_some() {
        "Global SettingsCloseHost Overlay"
    } else if registrations().iter().any(|r| (r.overlay_open)(s)) {
        "Global Overlay"
    } else {
        "Global"
    };
    root.key_context(context)
        .map(|root| crate::keymap::registered_context_input(root, cx.listener(key_down)))
        .map(|root| crate::keymap::legacy_registration_input(root, cx.listener(legacy_key_down)))
        .map(|root| crate::keymap::sidebar_navigation_input(root, cx.listener(sidebar_key_down)))
        .on_action(cx.listener(action))
}

fn action(
    s: &mut Shell,
    action: &crate::keymap::Shortcut,
    window: &mut Window,
    cx: &mut Context<Shell>,
) {
    use crate::keymap::Shortcut;
    // Main's connection policy admits management commands while offline, but
    // hidden content must not receive named actions before the raw-key fallback.
    if !s.connected
        && !s.palette
        && !s.shortcuts
        && !registrations().iter().any(|r| r.overlay_command && (r.overlay_open)(s))
        && !matches!(action, Shortcut::Palette | Shortcut::PaletteGlobal | Shortcut::Settings)
    {
        return;
    }
    if super::super::palette::action(s, action, window, cx)
        || registry::extensions().any(|extension| extension.action(s, action, window, cx))
    {
        s.revision += 1;
        cx.notify();
        return;
    }
    match *action {
        Shortcut::Reference => {
            s.execute(Command::ShortcutReference, window, cx);
        }
        Shortcut::ReferenceCancel => {
            s.shortcuts = false;
            s.restore_focus(window, cx);
        }
        Shortcut::Settings => {
            if s.surfaces.settings.view.is_some() {
                s.close_settings(window, cx);
            } else {
                s.open_settings(window, cx);
            }
        }
        Shortcut::SettingsClose if s.surfaces.settings.view.is_some() => {
            s.close_settings(window, cx);
        }
        Shortcut::NextSurface | Shortcut::PreviousSurface | Shortcut::SurfaceIndex(_) => {
            let Some(saved) = s.current().filter(|saved| !saved.tabs.is_empty()) else {
                return;
            };
            let index = match *action {
                Shortcut::PreviousSurface => {
                    (saved.active + saved.tabs.len() - 1) % saved.tabs.len()
                }
                Shortcut::SurfaceIndex(index) if index < saved.tabs.len() => index,
                Shortcut::SurfaceIndex(_) => return,
                _ => (saved.active + 1) % saved.tabs.len(),
            };
            s.capture(window, cx);
            for registration in registrations() {
                (registration.after_tab)(s);
            }
            if let Some(saved) = s
                .state
                .selected
                .as_ref()
                .and_then(|w| s.state.workspaces.get_mut(w))
                && !saved.tabs.is_empty()
            {
                saved.active = index;
            }
            s.ensure(window, cx);
            s.restore_focus(window, cx);
            s.persist();
        }
        Shortcut::CloseSurface => {
            if let Some(tab) = s.active() {
                s.surface_focus.remove(&s.key(&tab));
                s.content.remove(&s.key(&tab));
                let saved = s
                    .state
                    .workspaces
                    .get_mut(s.state.selected.as_deref().unwrap_or(""))
                    .unwrap();
                (tab.registration().remove)(saved, &tab);
                saved.tabs.remove(saved.active);
                saved.active = saved.active.min(saved.tabs.len().saturating_sub(1));
                s.ensure(window, cx);
                s.restore_focus(window, cx);
                s.persist();
            }
        }
        #[cfg(test)]
        Shortcut::Probe => s.execute(Command::Fake, window, cx),
        _ => {
            cx.propagate();
            return;
        }
    }
    if s.palette {
        // The palette header is the first child of the scrolling container.
        s.palette_scroll.scroll_to_item(s.choice + 1);
    }
    s.revision += 1;
    cx.notify();
}
fn sidebar_key_down(
    s: &mut Shell,
    event: &KeyDownEvent,
    window: &mut Window,
    cx: &mut Context<Shell>,
) {
    if (sidebar::REGISTRATION.key_down)(s, event, window, cx) {
        s.revision += 1;
        cx.notify();
        cx.stop_propagation();
    }
}
fn legacy_key_down(
    s: &mut Shell,
    event: &KeyDownEvent,
    window: &mut Window,
    cx: &mut Context<Shell>,
) {
    if registrations()
        .iter()
        .any(|registration| (registration.key_down)(s, event, window, cx))
    {
        s.revision += 1;
        cx.notify();
        cx.stop_propagation();
    }
}

fn key_down(s: &mut Shell, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Shell>) {
    if features::key(s, event, window, cx) == registry::KeyResult::Handled {
        s.revision += 1;
        cx.notify();
        cx.stop_propagation();
    }
}
