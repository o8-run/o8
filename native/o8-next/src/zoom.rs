//! Interface zoom: the saved level (`theme::zoom_percent`) applied to a window.
//! GPUI's per-window zoom lays the window out in a viewport divided by the
//! level and paints it that much larger, so text, icons, spacing and every
//! surface scale together (vendor/gpui/O8-PATCHES.md).
use gpui::{App, Bounds, Pixels, Window};

/// Applies the saved level to `window`.
pub(crate) fn apply(window: &mut Window, cx: &mut App) {
    window.set_zoom(crate::theme::zoom(), cx);
}
/// Zooms in (`steps` > 0) or out one step at a time, saves and applies it.
pub(crate) fn step(steps: i32, window: &mut Window, cx: &mut App) {
    let percent = crate::theme::step_zoom(crate::theme::zoom_percent(), steps);
    set(percent, window, cx);
}
/// Back to the designed size.
pub(crate) fn reset(window: &mut Window, cx: &mut App) {
    set(crate::theme::ZOOM_DEFAULT, window, cx);
}
fn set(percent: u16, window: &mut Window, cx: &mut App) {
    crate::theme::set_zoom_percent(percent);
    apply(window, cx);
    window.refresh();
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
}
