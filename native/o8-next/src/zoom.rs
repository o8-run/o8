//! Interface zoom: the saved level (`theme::zoom_percent`) applied to a window.
//! GPUI's per-window zoom lays the window out in a viewport divided by the
//! level and paints it that much larger, so text, icons, spacing and every
//! surface scale together (vendor/gpui/O8-PATCHES.md).
use gpui::{App, Bounds, Context, Keystroke, Pixels, Size, Window, px, size};

/// The shell window's smallest size in layout pixels (its design floor).
pub(crate) const MIN_SIZE: (f32, f32) = (600., 400.);

/// Applies the saved level to `window`. The shell window's minimum size
/// follows it.
pub(crate) fn apply(window: &mut Window, cx: &mut App) {
    let shell = window.root::<crate::shell::Shell>().flatten().is_some();
    apply_to(window, shell, cx);
}
/// Applies the saved level to the shell window, whose root may not be set
/// yet: its minimum follows the zoom and the display the window is on, and a
/// window below that minimum grows to it.
pub(crate) fn apply_shell(window: &mut Window, cx: &mut App) {
    apply_to(window, true, cx);
}
fn apply_to(window: &mut Window, shell: bool, cx: &mut App) {
    window.set_zoom(crate::theme::zoom(), cx);
    if !shell {
        return;
    }
    let min = min_size(window.zoom(), display_size(window, cx));
    set_min_size(window, min);
    let current = window.viewport_size().map(|v| v * window.zoom());
    if let Some(grown) = grown(current, min) {
        // Platform resizes run after the current dispatch, as GPUI's own do.
        window.defer(cx, move |window, _| window.resize(grown));
    }
}
/// The size a window of `current` content size grows to, when it is below
/// `min`.
pub(crate) fn grown(current: Size<Pixels>, min: Size<Pixels>) -> Option<Size<Pixels>> {
    let grown = current.max(&min);
    (grown != current).then_some(grown)
}
/// Re-reads the zoom and the rebound shortcuts saved by any o8 next process
/// each time `window` is activated, and applies the zoom.
pub(crate) fn follow<V: 'static>(window: &mut Window, shell: bool, cx: &mut Context<V>) {
    cx.observe_window_activation(window, move |_, window, cx| {
        if window.is_window_active() {
            crate::theme::with_zoom(crate::theme::ZoomStore::reload);
            reload_bindings();
            apply_to(window, shell, cx);
        }
    })
    .detach();
}
/// Zooms in (`steps` > 0) or out one step at a time from the saved level,
/// saves and applies it.
pub(crate) fn step(steps: i32, window: &mut Window, cx: &mut App) {
    crate::theme::with_zoom(|store| store.step(steps));
    applied(window, cx);
}
/// Back to the designed size.
pub(crate) fn reset(window: &mut Window, cx: &mut App) {
    crate::theme::set_zoom_percent(crate::theme::ZOOM_DEFAULT);
    applied(window, cx);
}
fn applied(window: &mut Window, cx: &mut App) {
    apply(window, cx);
    window.refresh();
    // The level is one preference: the process's other windows follow, after
    // the caller's update, so none is updated while it is borrowed.
    cx.defer(|cx| {
        for handle in cx.windows() {
            let _ = handle.update(cx, |_, window, cx| apply(window, cx));
        }
    });
}
/// Which zoom command a key runs on the default chords: 1 in, -1 out, 0
/// reset. The primary modifier is Cmd on macOS and Ctrl elsewhere, as the
/// `secondary` defaults in the Shortcuts list.
pub(crate) fn shortcut(keystroke: &Keystroke) -> Option<i32> {
    shortcut_for(keystroke, cfg!(target_os = "macos"))
}
fn shortcut_for(keystroke: &Keystroke, mac: bool) -> Option<i32> {
    let m = keystroke.modifiers;
    let primary = if mac {
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

/// Zoom in, out and reset chords rebound in the Shortcuts list (canonical
/// chord text); None keeps the default chord.
pub(crate) type Bindings = [Option<String>; 3];
const STEPS: [i32; 3] = [1, -1, 0];
#[cfg(not(test))]
static BINDINGS: std::sync::Mutex<Bindings> = std::sync::Mutex::new([None, None, None]);
#[cfg(test)]
thread_local! {
    static BINDINGS: std::cell::RefCell<Bindings> = const { std::cell::RefCell::new([None, None, None]) };
}
fn bindings() -> Bindings {
    #[cfg(not(test))]
    return BINDINGS.lock().map(|b| b.clone()).unwrap_or_default();
    #[cfg(test)]
    return BINDINGS.with(|b| b.borrow().clone());
}
fn keep_bindings(bindings: Bindings) {
    #[cfg(not(test))]
    if let Ok(mut b) = BINDINGS.lock() {
        *b = bindings;
    }
    #[cfg(test)]
    BINDINGS.with(|b| *b.borrow_mut() = bindings);
}
/// The shell saves its resolved zoom chords for the pop-out processes.
pub(crate) fn save_bindings(next: Bindings) {
    if bindings() == next {
        return;
    }
    if let Some(path) = crate::theme::preference_path("next-zoom-keys") {
        let _ = std::fs::write(path, next.clone().map(Option::unwrap_or_default).join("\n"));
    }
    keep_bindings(next);
}
fn reload_bindings() {
    let Some(text) = crate::theme::preference_path("next-zoom-keys")
        .and_then(|path| std::fs::read_to_string(path).ok())
    else {
        return;
    };
    let mut lines = text.lines().map(|line| {
        crate::shell::shortcuts::keymap::parse(line).filter(|_| !line.trim().is_empty())
    });
    keep_bindings([lines.next().flatten(), lines.next().flatten(), lines.next().flatten()]);
}
/// The zoom command a pop-out window runs for a key: a rebound chord, else
/// a default chord that was not rebound. A terminal keeps every key except
/// the macOS Cmd chords, so programs still see Ctrl+-, Ctrl+0 and Ctrl+=.
pub(crate) fn popout_command(
    keystroke: &Keystroke,
    bindings: &Bindings,
    terminal: bool,
    mac: bool,
) -> Option<i32> {
    if terminal && !(mac && keystroke.modifiers.platform) {
        return None;
    }
    let pressed = crate::shell::shortcuts::keymap::chord(keystroke);
    if let Some(index) = bindings.iter().position(|b| b.as_deref() == Some(&pressed)) {
        return Some(STEPS[index]);
    }
    let steps = shortcut_for(keystroke, mac)?;
    let index = STEPS.iter().position(|s| *s == steps)?;
    bindings[index].is_none().then_some(steps)
}
/// The zoom shortcuts in every window but the shell's, whose own key handler
/// runs them. Keystroke interceptors run before any view sees the key and
/// outside every update. `terminal` marks a process whose windows are
/// terminals.
pub(crate) fn install(terminal: bool, cx: &mut App) {
    reload_bindings();
    cx.intercept_keystrokes(move |event, window, cx| {
        if window.root::<crate::shell::Shell>().flatten().is_some() {
            return;
        }
        let mac = cfg!(target_os = "macos");
        if let Some(steps) = popout_command(&event.keystroke, &bindings(), terminal, mac) {
            match steps {
                0 => reset(window, cx),
                steps => step(steps, window, cx),
            }
            cx.stop_propagation();
        }
    })
    .detach();
}
/// The minimum window size in screen points: the design floor at this zoom,
/// never larger than the display.
pub(crate) fn min_size(zoom: f32, display: Option<Size<Pixels>>) -> Size<Pixels> {
    let floor = size(px(MIN_SIZE.0 * zoom), px(MIN_SIZE.1 * zoom));
    display.map_or(floor, |display| floor.min(&display))
}
/// The usable size of the display `window` is on: on macOS its screen's
/// visible frame (without the menu bar and Dock), elsewhere its bounds.
fn display_size(window: &Window, cx: &App) -> Option<Size<Pixels>> {
    #[cfg(target_os = "macos")]
    if let Some(visible) = mac::visible_frame(window) {
        return Some(visible);
    }
    window.display(cx).map(|display| display.bounds().size)
}
#[cfg(target_os = "macos")]
fn set_min_size(window: &Window, min: Size<Pixels>) {
    mac::set_min_size(window, min);
}
/// Other platforms keep the minimum the window opened with.
#[cfg(not(target_os = "macos"))]
fn set_min_size(_: &Window, _: Size<Pixels>) {}
#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)] // objc's msg_send
mod mac {
    use cocoa::{
        base::id,
        foundation::{NSRect, NSSize},
    };
    use gpui::{Pixels, Size, Window, px, size};
    use objc::{msg_send, sel, sel_impl};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    fn native(window: &Window) -> Option<id> {
        let handle = HasWindowHandle::window_handle(window).ok()?;
        let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
            return None;
        };
        let view = handle.ns_view.as_ptr() as id;
        let native: id = unsafe { msg_send![view, window] };
        (!native.is_null()).then_some(native)
    }
    pub(super) fn visible_frame(window: &Window) -> Option<Size<Pixels>> {
        let native = native(window)?;
        unsafe {
            let screen: id = msg_send![native, screen];
            if screen.is_null() {
                return None;
            }
            let frame: NSRect = msg_send![screen, visibleFrame];
            Some(size(px(frame.size.width as f32), px(frame.size.height as f32)))
        }
    }
    pub(super) fn set_min_size(window: &Window, min: Size<Pixels>) {
        let Some(native) = native(window) else {
            return;
        };
        let (width, height) = (f32::from(min.width), f32::from(min.height));
        let min = NSSize::new(f64::from(width), f64::from(height));
        unsafe {
            let _: () = msg_send![native, setContentMinSize: min];
        }
    }
}
/// The page zoom a fixed-width device preview needs: its CSS viewport spans
/// the web view's real frame, `width` layout pixels at this zoom. A zero
/// width (mid-animation) keeps 1.
pub(crate) fn preview_page_zoom(width: f32, viewport: f32, zoom: f32) -> f64 {
    if viewport > 0. && width > 0. {
        f64::from(width * zoom) / f64::from(viewport)
    } else {
        1.
    }
}
/// The level as Settings shows it, such as "110%".
pub(crate) fn label(percent: u16) -> String {
    format!("{percent}%")
}
/// Window bounds in the platform's (unzoomed) coordinates, for native views
/// such as web views that AppKit positions.
pub(crate) fn native(bounds: Bounds<Pixels>, window: &Window) -> Bounds<Pixels> {
    let zoom = window.zoom();
    bounds.map(|v| v * zoom)
}
/// A clearance around fixed-size window chrome the platform draws itself
/// (the macOS traffic lights): it keeps at least its designed size on screen
/// when the window zooms out.
pub(crate) fn chrome_clearance(logical: f32, window: &Window) -> f32 {
    logical * (1. / window.zoom()).max(1.)
}

#[cfg(test)]
mod tests {
    use crate::theme::{ZOOM_DEFAULT, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, parse_zoom, step_zoom};
    use gpui::{Context, IntoElement, Render, TestAppContext, Window, div, point, prelude::*, px};

    #[test]
    fn zoom_steps_by_ten_percent_and_clamps() {
        assert_eq!(ZOOM_STEP, 10);
        assert_eq!(step_zoom(ZOOM_DEFAULT, 1), 110);
        assert_eq!(step_zoom(ZOOM_DEFAULT, -1), 90);
        assert_eq!(step_zoom(ZOOM_MAX, 1), ZOOM_MAX);
        assert_eq!(step_zoom(ZOOM_MIN, -1), ZOOM_MIN);
        assert_eq!(step_zoom(190, 5), ZOOM_MAX);
        assert_eq!(step_zoom(80, -50), ZOOM_MIN);
        let mut percent = ZOOM_DEFAULT;
        let mut seen = vec![percent];
        while percent < ZOOM_MAX {
            percent = step_zoom(percent, 1);
            seen.push(percent);
        }
        assert_eq!(seen.len(), 11, "100% to 200% in ten steps");
        assert_eq!((ZOOM_MIN, ZOOM_MAX), (70, 200));
    }

    #[test]
    fn zoom_saved_text_parses_clamped_and_on_a_step() {
        assert_eq!(parse_zoom("120"), Some(120));
        assert_eq!(parse_zoom(" 90\n"), Some(90));
        assert_eq!(parse_zoom("124"), Some(120));
        assert_eq!(parse_zoom("126.0"), Some(130));
        assert_eq!(parse_zoom("10"), Some(ZOOM_MIN));
        assert_eq!(parse_zoom("-40"), Some(ZOOM_MIN));
        assert_eq!(parse_zoom("900"), Some(ZOOM_MAX));
        assert_eq!(parse_zoom("1e9"), Some(ZOOM_MAX));
        assert_eq!(parse_zoom("big"), None);
        assert_eq!(parse_zoom("NaN"), None);
        assert_eq!(parse_zoom(""), None);
    }

    #[test]
    fn zoom_is_not_saved_under_test_and_reads_the_default() {
        // saved_path is None under cfg(test), so nothing on disk is read or written.
        assert_eq!(crate::theme::zoom_percent(), ZOOM_DEFAULT);
        assert_eq!(crate::theme::zoom(), 1.);
        assert_eq!(super::label(130), "130%");
    }

    struct Probe {
        clicks: usize,
    }
    impl Render for Probe {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            div().size_full().child(
                div()
                    .id("zoom-probe")
                    .absolute()
                    .left(px(100.))
                    .top(px(40.))
                    .w(px(50.))
                    .h(px(20.))
                    .bg(gpui::white())
                    .on_click(cx.listener(|this, _, _, _| this.clicks += 1)),
            )
        }
    }

    #[gpui::test]
    fn zoom_scales_painted_bounds_viewport_and_hit_testing(cx: &mut TestAppContext) {
        let (probe, cx) = cx.add_window_view(|_, _| Probe { clicks: 0 });
        let painted = |cx: &mut gpui::VisualTestContext| {
            cx.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear();
                let quads = window.painted_quad_bounds();
                assert_eq!(quads.len(), 1, "only the probe paints");
                (quads[0], window.viewport_size(), window.scale_factor())
            })
        };
        let (plain, viewport, scale) = painted(cx);
        cx.update(|window, cx| window.set_zoom(1.5, cx));
        let (zoomed, zoomed_viewport, zoomed_scale) = painted(cx);
        // The test platform's display scale is 2; the zoom multiplies it.
        assert_eq!(zoomed_scale, scale * 1.5);
        assert_eq!(zoomed_viewport.width, viewport.width / 1.5);
        assert_eq!(zoomed_viewport.height, viewport.height / 1.5);
        for (zoomed, plain) in [
            (zoomed.origin.x, plain.origin.x),
            (zoomed.origin.y, plain.origin.y),
            (zoomed.size.width, plain.size.width),
            (zoomed.size.height, plain.size.height),
        ] {
            assert_eq!(f64::from(zoomed), f64::from(plain) * 1.5);
        }
        assert_eq!(f64::from(plain.size.width), 50. * f64::from(scale));

        // Platform input arrives in unzoomed window points: the probe spans
        // x 150..225 and y 60..90 on screen at 150%.
        let click = |cx: &mut gpui::VisualTestContext, x: f32, y: f32| {
            cx.simulate_click(point(px(x), px(y)), gpui::Modifiers::none());
        };
        click(cx, 120., 50.);
        assert_eq!(
            probe.read_with(cx, |p, _| p.clicks),
            0,
            "left of the zoomed probe"
        );
        click(cx, 210., 80.);
        assert_eq!(
            probe.read_with(cx, |p, _| p.clicks),
            1,
            "inside the zoomed probe"
        );
        cx.update(|window, _| {
            assert_eq!(window.mouse_position(), point(px(140.), px(80. / 1.5)));
        });

        cx.update(|window, cx| window.set_zoom(1., cx));
        let (restored, _, _) = painted(cx);
        assert_eq!(restored, plain);
    }

    #[test]
    fn zoom_device_preview_page_spans_the_zoomed_frame() {
        // A 390-wide phone preview: 390 layout pixels, so 390 or 780 points.
        assert_eq!(super::preview_page_zoom(390., 390., 1.), 1.);
        assert_eq!(super::preview_page_zoom(390., 390., 2.), 2.);
        // The CSS viewport stays 390 at both: the frame's points / page zoom.
        assert_eq!(390. * 2. / super::preview_page_zoom(390., 390., 2.), 390.);
        assert_eq!(super::preview_page_zoom(195., 390., 2.), 1.);
        assert_eq!(super::preview_page_zoom(390., 0., 2.), 1.);
        // Mid-animation the frame can be zero wide: never page zoom 0.
        assert_eq!(super::preview_page_zoom(0., 390., 2.), 1.);
    }

    #[test]
    fn zoom_minimum_window_is_the_design_floor_within_the_display() {
        use gpui::size;
        let min = |zoom, display| super::min_size(zoom, display);
        assert_eq!(min(1., None), size(px(600.), px(400.)));
        assert_eq!(min(2., None), size(px(1200.), px(800.)));
        assert_eq!(min(0.7, None), size(px(600. * 0.7), px(400. * 0.7)));
        let laptop = Some(size(px(1280.), px(720.)));
        assert_eq!(min(2., laptop), size(px(1200.), px(720.)));
        assert_eq!(min(1., laptop), size(px(600.), px(400.)));
    }

    struct Popout;
    impl Render for Popout {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().size_full()
        }
    }

    #[gpui::test]
    fn zoom_popout_windows_open_at_the_saved_zoom_and_take_the_shortcuts(
        cx: &mut TestAppContext,
    ) {
        cx.update(|cx| {
            super::install(false, cx);
            crate::theme::set_zoom_percent(120);
        });
        let (_, cx) = cx.add_window_view(|window, cx| {
            super::apply(window, cx);
            Popout
        });
        let zoom = |cx: &mut gpui::VisualTestContext| {
            cx.update(|window, _| (window.zoom(), crate::theme::zoom_percent()))
        };
        assert_eq!(zoom(cx), (1.2, 120));
        cx.simulate_keystrokes("secondary-=");
        assert_eq!(zoom(cx), (1.3, 130));
        cx.simulate_keystrokes("secondary--");
        assert_eq!(zoom(cx), (1.2, 120));
        cx.simulate_keystrokes("secondary-0");
        assert_eq!(zoom(cx), (1., 100));
    }

    #[test]
    fn zoom_store_steps_from_the_level_another_process_saved() {
        use crate::theme::ZoomStore;
        let path = crate::shell::test_support::scratch_path("zoom-store");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // The shell and a pop-out process, both at 100%.
        let shell = ZoomStore::new(Some(path.clone()));
        let popout = ZoomStore::new(Some(path.clone()));
        assert_eq!((shell.percent(), popout.percent()), (100, 100));
        // The pop-out zooms twice; the shell's next step starts from 120.
        popout.step(1);
        popout.step(1);
        assert_eq!(shell.percent(), 100, "stale until it reads the file");
        assert_eq!(shell.step(1), 130);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "130");
        // Activation reloads a change made elsewhere.
        popout.reload();
        assert_eq!(popout.percent(), 130);
        // A reset elsewhere is what the next step starts from.
        popout.set(ZOOM_DEFAULT);
        assert_eq!(shell.step(-1), 90);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn zoom_window_grows_to_the_new_minimum() {
        use gpui::size;
        let min = super::min_size(1.2, None);
        assert_eq!(super::grown(size(px(600.), px(400.)), min), Some(min));
        assert_eq!(
            super::grown(size(px(900.), px(400.)), min),
            Some(size(px(900.), min.height))
        );
        assert_eq!(super::grown(size(px(900.), px(700.)), min), None);
    }

    #[test]
    fn zoom_terminal_keeps_ctrl_keys_on_linux_and_rebinds_apply() {
        use gpui::Keystroke;
        let key = |text: &str| Keystroke::parse(text).unwrap();
        let none: super::Bindings = [None, None, None];
        let run = |text: &str, bindings: &super::Bindings, terminal, mac| {
            super::popout_command(&key(text), bindings, terminal, mac)
        };
        // Linux: Ctrl is primary; a terminal still receives Ctrl+-, Ctrl+0, Ctrl+=.
        for text in ["ctrl--", "ctrl-0", "ctrl-="] {
            assert_eq!(run(text, &none, true, false), None, "{text}");
        }
        assert_eq!(run("ctrl--", &none, false, false), Some(-1));
        // macOS: Cmd chords zoom in a terminal, Ctrl chords stay with it.
        assert_eq!(run("cmd--", &none, true, true), Some(-1));
        assert_eq!(run("ctrl--", &none, true, true), None);
        // A rebound zoom in runs on its chord; its default chord no longer does.
        let rebound: super::Bindings = [Some("alt-z".into()), None, None];
        assert_eq!(run("alt-z", &rebound, false, true), Some(1));
        assert_eq!(run("cmd-=", &rebound, false, true), None);
        assert_eq!(run("cmd--", &rebound, false, true), Some(-1));
    }

    #[gpui::test]
    fn zoom_popout_runs_a_rebound_chord(cx: &mut TestAppContext) {
        cx.update(|cx| super::install(false, cx));
        super::keep_bindings([Some("alt-z".into()), None, None]);
        let (_, cx) = cx.add_window_view(|window, cx| {
            super::apply(window, cx);
            Popout
        });
        let percent = |cx: &mut gpui::VisualTestContext| cx.update(|_, _| crate::theme::zoom_percent());
        cx.simulate_keystrokes("alt-z");
        assert_eq!(percent(cx), 110);
        cx.simulate_keystrokes("secondary-=");
        assert_eq!(percent(cx), 110, "the default chord moved to alt-z");
        cx.simulate_keystrokes("secondary-0");
        assert_eq!(percent(cx), 100);
    }
}
