//! The macOS window buttons (close, minimize, full screen), drawn by the app.
//!
//! AppKit draws its own buttons at a fixed screen size and place, so they
//! cannot follow the window zoom: at 140% they sat small and off-centre next
//! to the scaled header. As in the classic desktop shell, the native buttons
//! are hidden and these take their place. They are laid out in window units,
//! so they grow and shrink with everything else, and they share the header's
//! centre line at every zoom.
//!
//! Behaviour follows the native buttons and the classic component
//! (TrafficLights.tsx): red closes through the window's normal close path,
//! yellow minimizes, green toggles full screen and Option-click zooms
//! (maximizes). Hovering the group shows the glyphs on all three; an inactive
//! window shows them flat grey; in full screen they are not drawn and AppKit's
//! own buttons come back in the title bar it reveals there.
use gpui::{
    AnyElement, App, InteractiveElement, IntoElement, ParentElement, Rgba,
    StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px, rgb, rgba,
};

/// A button's diameter, as the native and classic ones.
pub(crate) const SIZE: f32 = 12.;
/// Between two buttons: native centres are 20 apart.
pub(crate) const GAP: f32 = 8.;
/// The close button's left edge (its centre at x=20, where AppKit put it).
pub(crate) const LEFT: f32 = 14.;
/// Each button's press area: the dot and 2 units around it, so at 70% it is
/// still 11 points. The areas meet halfway between the dots.
pub(crate) const HIT: f32 = SIZE + 4.;
/// Whether the app draws the buttons: macOS, and every test platform, so the
/// geometry is checked on CI's Linux runners too.
pub(crate) const DRAWN: bool = cfg!(any(test, target_os = "macos"));

const GROUP: &str = "window-lights";
const GLYPH: Rgba = Rgba {
    r: 0.,
    g: 0.,
    b: 0.,
    a: 0.55,
};

#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum Light {
    Close,
    Minimize,
    Zoom,
}

impl Light {
    pub(crate) const ALL: [Light; 3] = [Light::Close, Light::Minimize, Light::Zoom];
    pub(crate) fn selector(self) -> &'static str {
        match self {
            Light::Close => "window-light-close",
            Light::Minimize => "window-light-minimize",
            Light::Zoom => "window-light-zoom",
        }
    }
    /// The painted dot, inside the press area `selector` names.
    pub(crate) fn dot_selector(self) -> &'static str {
        match self {
            Light::Close => "window-light-close-dot",
            Light::Minimize => "window-light-minimize-dot",
            Light::Zoom => "window-light-zoom-dot",
        }
    }
    pub(crate) fn glyph_selector(self) -> &'static str {
        match self {
            Light::Close => "window-light-close-glyph",
            Light::Minimize => "window-light-minimize-glyph",
            Light::Zoom => "window-light-zoom-glyph",
        }
    }
    fn color(self) -> Rgba {
        rgb(match self {
            Light::Close => 0xFF5F57,
            Light::Minimize => 0xFEBC2E,
            Light::Zoom => 0x28C840,
        })
    }
    /// The classic glyphs, doubled onto the 24-unit icon grid.
    fn glyph(self) -> AnyElement {
        match self {
            Light::Close => {
                crate::icon::stroke("M7.4 7.4 L16.6 16.6 M16.6 7.4 L7.4 16.6", GLYPH, SIZE, 2.2)
                    .into_any_element()
            }
            Light::Minimize => {
                crate::icon::stroke("M5.8 12 H18.2", GLYPH, SIZE, 2.2).into_any_element()
            }
            // Full screen: two solid triangles on the diagonal.
            Light::Zoom => crate::icon::fill("M6 13.2 V6 h7.2 Z M18 10.8 V18 H10.8 Z", GLYPH, SIZE)
                .into_any_element(),
        }
    }
}

/// What a press asks of AppKit: the action message of the standard button the
/// light stands for (NSWindow's own close, miniaturize and zoom buttons send
/// these), so a light can only do what its native counterpart does.
pub(crate) fn action(light: Light, alt: bool) -> &'static str {
    match (light, alt) {
        // `performClose:` keeps the window's should-close path, where the
        // shell saves and asks.
        (Light::Close, _) => "performClose:",
        (Light::Minimize, _) => "miniaturize:",
        // Option turns the green button into Zoom (maximize).
        (Light::Zoom, true) => "zoom:",
        (Light::Zoom, false) => "toggleFullScreen:",
    }
}

/// The buttons' top edge in a header `header` units tall: centred on it, as
/// the sidebar toggle and the history arrows are.
pub(crate) fn top(header: f32) -> f32 {
    (header - SIZE) / 2.
}

/// The three buttons, absolutely placed in the window's top-left corner of a
/// `header`-tall title band, or None where the platform draws its own or the
/// window is in full screen.
pub(crate) fn render(header: f32, window: &Window) -> Option<AnyElement> {
    if !DRAWN {
        return None;
    }
    let fullscreen = window.is_fullscreen();
    // Full screen changes reach AppKit's style flags after the last resize
    // of the transition; hide or show its buttons once this frame is drawn,
    // so neither set sticks beside the other.
    if SYNCED.replace(Some(fullscreen)) != Some(fullscreen) {
        window.on_next_frame(|window, _| sync_native(window));
    }
    if fullscreen {
        return None;
    }
    let active = window.is_window_active();
    let pad = (HIT - SIZE) / 2.;
    Some(
        div()
            .id(GROUP)
            .debug_selector(|| GROUP.into())
            .group(GROUP)
            .absolute()
            .left(px(LEFT - pad))
            .top(px(top(header) - pad))
            .flex()
            .gap(px(GAP - 2. * pad))
            .children(Light::ALL.map(|light| button(light, active)))
            .into_any_element(),
    )
}

thread_local! {
    /// The full-screen state AppKit's buttons were last matched to.
    static SYNCED: std::cell::Cell<Option<bool>> = const { std::cell::Cell::new(None) };
}

fn button(light: Light, active: bool) -> impl IntoElement {
    let id = light.selector();
    let dot = div()
        .debug_selector(move || light.dot_selector().into())
        .size(px(SIZE))
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .map(|dot| {
            if active {
                // The native hairline rim, inside the circle.
                dot.bg(light.color())
                    .border(px(0.5))
                    .border_color(rgba(0x0000002e))
            } else {
                let mut grey = crate::theme::current().text;
                grey.a *= 0.22;
                dot.bg(grey)
            }
        })
        // Glyphs only on an active window, on all three while the group is
        // hovered. (macOS sends no hover to an inactive GPUI window.)
        .when(active, |dot| {
            dot.child(
                div()
                    .debug_selector(move || light.glyph_selector().into())
                    .opacity(0.)
                    .group_hover(GROUP, |glyph| glyph.opacity(1.))
                    .child(light.glyph()),
            )
        });
    div()
        .id(id)
        .debug_selector(move || id.into())
        .size(px(HIT))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .child(dot)
        // The press area is the topmost hitbox here, so no drag region below
        // it moves the window (macOS drags only from a topmost drag area).
        .occlude()
        .on_click(move |event, window, cx| {
            cx.stop_propagation();
            press(action(light, event.modifiers().alt), window, cx);
        })
}

/// Sends `action` to the window's NSWindow after the current event, outside
/// every update: AppKit answers by calling back into the window
/// (should-close, resize), which would find the app borrowed in here.
fn press(action: &'static str, window: &mut Window, cx: &mut App) {
    let handle = window.window_handle();
    cx.spawn(async move |cx| {
        let native = handle.update(cx, |_, window, _| {
            let native = mac::native(window);
            if native.is_none() {
                // No AppKit window (tests, other platforms).
                match action {
                    "performClose:" => window.remove_window(),
                    "toggleFullScreen:" => window.toggle_fullscreen(),
                    _ => {}
                }
            }
            native
        });
        if let Ok(Some(native)) = native {
            mac::perform(native, action);
        }
    })
    .detach();
}

/// Hides AppKit's buttons while the app draws its own, and shows them in full
/// screen, where AppKit's revealed title bar is the only place they appear.
/// Call it when the window opens and after each activation and resize: macOS
/// puts the standard buttons back after some full-screen and style changes.
/// Only touches AppKit, never window or app state.
pub(crate) fn sync_native(window: &Window) {
    if DRAWN {
        mac::hide_buttons(window, !window.is_fullscreen());
    }
}

#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)] // objc's msg_send
mod mac {
    use cocoa::base::{id, nil};
    use gpui::Window;
    use objc::{msg_send, sel, sel_impl};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    /// The window's NSWindow, as a raw pointer (only used on the main thread).
    pub(super) fn native(window: &Window) -> Option<usize> {
        let handle = HasWindowHandle::window_handle(window).ok()?;
        let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
            return None;
        };
        let view = handle.ns_view.as_ptr() as id;
        let native: id = unsafe { msg_send![view, window] };
        (!native.is_null()).then_some(native as usize)
    }
    pub(super) fn hide_buttons(window: &Window, hidden: bool) {
        let Some(native) = native(window) else {
            return;
        };
        let native = native as id;
        let hidden = if hidden {
            cocoa::base::YES
        } else {
            cocoa::base::NO
        };
        // NSWindowButton: 0 close, 1 miniaturize, 2 zoom.
        for kind in 0u64..3 {
            unsafe {
                let button: id = msg_send![native, standardWindowButton: kind];
                if !button.is_null() {
                    let _: () = msg_send![button, setHidden: hidden];
                }
            }
        }
    }
    /// Sends `action`, one of `super::action`'s selectors, to the window.
    pub(super) fn perform(native: usize, action: &str) {
        let native = native as id;
        let selector = objc::runtime::Sel::register(action);
        unsafe {
            let _: id = msg_send![native, performSelector: selector withObject: nil];
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod mac {
    use gpui::Window;
    pub(super) fn native(_: &Window) -> Option<usize> {
        None
    }
    pub(super) fn hide_buttons(_: &Window, _: bool) {}
    pub(super) fn perform(_: usize, _: &str) {}
}

#[cfg(test)]
mod tests {
    use super::{Light, action};

    #[test]
    fn window_lights_send_the_appkit_action_of_their_button() {
        // Each light sends what its native button sends, and Option changes
        // only the green one; a crossed mapping minimizes on green.
        let sent: Vec<_> = Light::ALL
            .iter()
            .flat_map(|light| [action(*light, false), action(*light, true)])
            .collect();
        assert_eq!(
            sent,
            [
                "performClose:",
                "performClose:",
                "miniaturize:",
                "miniaturize:",
                "toggleFullScreen:",
                "zoom:",
            ]
        );
    }
}
