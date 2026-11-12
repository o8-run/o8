use super::*;
use crate::shell::test_support::*;

/// The Ring sits past the traffic lights' space, before the sidebar toggle,
/// on the header icons' line; the toggle, Back and Forward move right by its
/// width and one gap, at every zoom.
#[gpui::test]
fn header_ring_sits_between_the_lights_and_the_toggle_at_every_zoom(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("header-ring.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_resize(size(px(1680.), px(1050.)));
    let near = |a: gpui::Pixels, b: f32, what: &str| {
        assert!((f32::from(a) - b).abs() < 0.01, "{what}: {a:?} vs {b}");
    };
    for zoom in [0.7, 1.0, 1.4, 2.0] {
        visual.update(|window, cx| window.set_zoom(zoom, cx));
        draw(&mut visual);
        let (inset, lights) = visual.update(|window, _| {
            (
                toggle_inset(window),
                crate::zoom::chrome_clearance(super::super::super::rail::LIGHTS, window),
            )
        });
        let mut bounds = |id: &'static str| {
            visual
                .debug_bounds(id)
                .unwrap_or_else(|| panic!("{id} at zoom {zoom}"))
        };
        let ring = bounds("header-ring");
        let toggle = bounds("header-sidebar");
        let back = bounds("header-back");
        let forward = bounds("header-forward");
        let header = bounds("thread-header");
        let at = format!("zoom {zoom}");
        // 16 layout units, zooming with the header like its icons.
        near(ring.size.width, RING_W, &at);
        near(ring.size.height, RING_W, &at);
        // Where the toggle used to start, clear of the lights' space.
        near(ring.left(), inset, &at);
        assert!(ring.left() > px(lights), "{at}");
        // Centred on the header icons' line (y 20 of the 40-unit header).
        near(ring.center().y - header.top(), 20., &at);
        near(ring.center().y, f32::from(toggle.center().y), &at);
        // The toggle shifts by the Ring's width plus the icons' 4-unit gap;
        // Back and Forward keep their gaps after it.
        near(toggle.left(), inset + RING_W + 4., &at);
        near(back.left(), f32::from(toggle.right()) + 4., &at);
        near(forward.left(), f32::from(back.right()) + 4., &at);
    }
    assert!(visual.simulate_close());
}

/// The Ring is drawn for the running theme: ink on light, paper on dark.
#[test]
fn header_ring_colour_follows_the_theme() {
    let (ink, orange) = crate::ring::colors(true);
    let (paper, point) = crate::ring::colors(false);
    assert_eq!(ink, gpui::rgb(0x17140F));
    assert_eq!(paper, gpui::rgb(0xF4F2EC));
    assert_eq!((orange, point), (gpui::rgb(0xFF5A1F), gpui::rgb(0xFF5A1F)));
}
