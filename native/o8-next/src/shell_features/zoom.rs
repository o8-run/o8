// Interface zoom: the primary modifier with = (or +), - and 0 zooms the whole
// window in, out and back to 100%, as the classic web UI's zoom did. The
// palette lists the same commands; Settings › Appearance shows the level.
use super::*;
struct Zoom;
register_shell_feature!(Zoom);
impl ShellFeature for Zoom {
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 90,
            dispatch,
        }]
    }
    fn commands(&self) -> &'static [PaletteCommands] {
        &[PaletteCommands {
            order: 50,
            collect: |_| {
                vec![
                    Command::Feature(&ZOOM_IN),
                    Command::Feature(&ZOOM_OUT),
                    Command::Feature(&ZOOM_RESET),
                ]
            },
        }]
    }
    fn observers(&self) -> &'static [PreferenceObserver] {
        &[PreferenceObserver {
            order: 0,
            install: |_, w, cx| crate::zoom::apply(w, cx),
        }]
    }
}

/// Which zoom command a key runs: 1 in, -1 out, 0 reset. The primary
/// modifier is Cmd on macOS and Ctrl elsewhere, as the `secondary` defaults
/// in the Shortcuts list.
pub(super) fn zoom_key(keystroke: &gpui::Keystroke) -> Option<i32> {
    let m = keystroke.modifiers;
    let primary = if cfg!(target_os = "macos") {
        m.platform && !m.control
    } else {
        m.control && !m.platform
    };
    if !primary || m.alt || m.function {
        return None;
    }
    match keystroke.key.as_str() {
        // Cmd+= and Cmd++ (Shift+=) both zoom in.
        "=" | "+" => Some(1),
        "-" if !m.shift => Some(-1),
        "0" if !m.shift => Some(0),
        _ => None,
    }
}

fn dispatch(
    s: &mut Shell,
    event: &KeyDownEvent,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> KeyResult {
    let Some(direction) = zoom_key(&event.keystroke) else {
        return KeyResult::Unhandled;
    };
    run(s, direction, window, cx);
    KeyResult::Handled
}

fn run(s: &mut Shell, direction: i32, window: &mut Window, cx: &mut Context<Shell>) {
    match direction {
        0 => crate::zoom::reset(window, cx),
        steps => crate::zoom::step(steps, window, cx),
    }
    s.revision += 1;
    cx.notify();
}

pub(super) static ZOOM_IN: PaletteCommand = PaletteCommand {
    id: "zoom-in",
    label: "Zoom in",
    run: |s, window, cx| {
        s.palette = false;
        run(s, 1, window, cx);
        s.restore_focus(window, cx);
    },
};
pub(super) static ZOOM_OUT: PaletteCommand = PaletteCommand {
    id: "zoom-out",
    label: "Zoom out",
    run: |s, window, cx| {
        s.palette = false;
        run(s, -1, window, cx);
        s.restore_focus(window, cx);
    },
};
pub(super) static ZOOM_RESET: PaletteCommand = PaletteCommand {
    id: "zoom-reset",
    label: "Reset zoom",
    run: |s, window, cx| {
        s.palette = false;
        run(s, 0, window, cx);
        s.restore_focus(window, cx);
    },
};

#[cfg(test)]
mod tests {
    use super::zoom_key;
    use gpui::Keystroke;

    fn key(text: &str) -> Option<i32> {
        zoom_key(&Keystroke::parse(text).unwrap())
    }

    #[test]
    fn zoom_keys_use_the_primary_modifier() {
        assert_eq!(key("secondary-="), Some(1));
        assert_eq!(key("secondary-shift-="), Some(1));
        assert_eq!(key("secondary-+"), Some(1));
        assert_eq!(key("secondary--"), Some(-1));
        assert_eq!(key("secondary-0"), Some(0));
        assert_eq!(key("="), None);
        assert_eq!(key("-"), None);
        assert_eq!(key("secondary-alt-="), None);
        assert_eq!(key("secondary-shift-0"), None);
        assert_eq!(key("secondary-9"), None);
        let other = if cfg!(target_os = "macos") {
            "ctrl"
        } else {
            "cmd"
        };
        assert_eq!(key(&format!("{other}-=")), None);
        assert_eq!(key(&format!("{other}--")), None);
    }
}
