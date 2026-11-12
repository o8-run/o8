use super::*;
use crate::shell::test_support::*;

/// Traffic lights | sidebar toggle | Ring | Back | Forward. The toggle keeps
/// its place past the lights' space and the Ring follows it on the header
/// icons' line. With the sidebar open, Forward ends on the column's head
/// padding, over the sidebar's last head control, at any column width that
/// leaves room; folded, Back follows the Ring after 12 units. At every zoom.
#[gpui::test]
fn header_ring_sits_between_the_toggle_and_back_at_every_zoom(cx: &mut TestAppContext) {
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
    let sidebar = super::super::super::sidebar::WIDTH;
    let narrow = super::super::super::sidebar::MIN_WIDTH;
    let pad = super::super::super::sidebar::HEAD_PAD;
    for (layout, width) in [
        ("open", Some(sidebar)),
        ("narrowest", Some(narrow)),
        ("folded", None),
    ] {
        shell.update(&mut visual, |s, cx| {
            s.surfaces.sidebar.hidden = width.is_none();
            s.state.sidebar_width = width;
            cx.notify();
        });
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
                    .unwrap_or_else(|| panic!("{id}, {layout} at zoom {zoom}"))
            };
            let ring = bounds("header-ring");
            let toggle = bounds("header-sidebar");
            let back = bounds("header-back");
            let forward = bounds("header-forward");
            let header = bounds("thread-header");
            let at = format!("{layout} at zoom {zoom}");
            // 16 layout units, zooming with the header like its icons.
            near(ring.size.width, RING_W, &at);
            near(ring.size.height, RING_W, &at);
            // The toggle where it is on main, clear of the lights' space.
            near(toggle.left(), inset, &at);
            assert!(toggle.left() > px(lights), "{at}");
            // The Ring right after it, on the icons' line (y 20 of 40).
            near(ring.left(), f32::from(toggle.right()) + 4., &at);
            near(ring.center().y - header.top(), 20., &at);
            near(ring.center().y, f32::from(toggle.center().y), &at);
            // Back and Forward keep their 4-unit gap and never crowd the Ring.
            near(forward.left(), f32::from(back.right()) + 4., &at);
            assert!(back.left() >= ring.right() + px(ARROWS_GAP - 0.01), "{at}");
            match width {
                Some(width) => {
                    let room = width - pad - (ARROW_W + 4. + ARROW_W);
                    let aligned = room >= f32::from(ring.right()) + ARROWS_GAP;
                    if aligned {
                        // Forward ends on the column's head padding...
                        near(forward.right(), width - pad, &at);
                        // ...over the right edge of the sidebar's last head control.
                        let last = ["sidebar-new-thread", "sidebar-project-add"]
                            .into_iter()
                            .filter_map(|id| visual.debug_bounds(id))
                            .map(|b| f32::from(b.right()))
                            .fold(f32::MIN, f32::max);
                        assert!(last > 0., "{at}: no head control in the sidebar");
                        near(forward.right(), last, &at);
                    } else {
                        // Too narrow to align: the folded gap, still inside the column.
                        near(back.left(), f32::from(ring.right()) + ARROWS_GAP, &at);
                        assert!(forward.right() <= px(width - pad + 0.01), "{at}");
                    }
                }
                None => near(back.left(), f32::from(ring.right()) + ARROWS_GAP, &at),
            }
        }
    }
    assert!(visual.simulate_close());
}

/// Back and Forward right-align to the column while it has room, and fall
/// back to the 12-unit gap after the Ring when it does not, or when folded.
#[test]
fn header_arrows_align_to_the_column_or_keep_the_gap() {
    let pad = super::super::super::sidebar::HEAD_PAD;
    let inset = 78.;
    let cluster = TOGGLE_W + 4. + RING_W;
    let arrows = ARROW_W + 4. + ARROW_W;
    // Open at the default width: Forward's right edge is the column's less its padding.
    let lead = arrows_lead(Some(280.), inset);
    assert!((inset + cluster + lead + arrows - (280. - pad)).abs() < 1e-3);
    // Folded, and a column too narrow to align: the 12-unit gap.
    assert_eq!(arrows_lead(None, inset), ARROWS_GAP);
    assert_eq!(arrows_lead(Some(150.), inset), ARROWS_GAP);
    // The folded width counts the wider gap.
    assert_eq!(
        folded(inset),
        inset + cluster + ARROWS_GAP + arrows + 4. - 16.
    );
}

/// The Ring is drawn for the running theme: ink on light, paper on dark; the
/// sidebar toggle never competes with its orange point.
#[test]
fn header_ring_colour_follows_the_theme() {
    let orange = crate::theme::brand_orange();
    assert_ne!(
        toggle_color(false),
        orange,
        "open sidebar toggle is not orange"
    );
    assert_ne!(toggle_color(true), orange);
    assert_eq!(toggle_color(false), theme().text);
    assert_eq!(toggle_color(true), theme().text_secondary);
    let (ink, orange) = crate::ring::colors(true);
    let (paper, point) = crate::ring::colors(false);
    assert_eq!(ink, gpui::rgb(0x17140F));
    assert_eq!(paper, gpui::rgb(0xF4F2EC));
    assert_eq!((orange, point), (gpui::rgb(0xFF5A1F), gpui::rgb(0xFF5A1F)));
}
