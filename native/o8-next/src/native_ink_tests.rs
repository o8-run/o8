use super::*;

const MONITOR: Monitor = Monitor {
    x: 0.,
    y: 0.,
    width: 1000.,
    height: 500.,
};

fn armed(now: Instant) -> Ink {
    let mut ink = Ink::default();
    let reply = ink
        .control(
            &json!({"action":"arm","session":7,"monitor":{"x":0.0,"y":0.0,"width":1000.0,"height":500.0}}),
            now,
        )
        .unwrap();
    assert_eq!(reply["ok"], true);
    assert_eq!(reply["capturing"], true);
    ink
}

fn ms(now: Instant, ms: u64) -> Instant {
    now + Duration::from_millis(ms)
}

fn draw(ink: &mut Ink, now: Instant) {
    assert!(ink.press(100., 50., now));
    assert!(ink.drag(200., 100., ms(now, 16)));
    assert!(ink.lift());
}

#[test]
fn arm_captures_and_only_armed_presses_draw() {
    let now = Instant::now();
    let mut idle = Ink::default();
    assert!(!idle.capturing() && !idle.visible());
    assert!(!idle.press(1., 1., now), "a hidden panel never draws");
    let mut ink = armed(now);
    assert!(ink.capturing() && ink.visible());
    assert!(!ink.drag(5., 5., now), "a move without a press draws nothing");
    draw(&mut ink, now);
    assert_eq!(ink.strokes.len(), 1);
    assert_eq!(ink.strokes[0].len(), 2);
}

#[test]
fn malformed_arms_are_refused() {
    let now = Instant::now();
    let mut ink = Ink::default();
    for args in [
        json!({"action":"arm","monitor":{"x":0.0,"y":0.0,"width":10.0,"height":10.0}}),
        json!({"action":"arm","session":1}),
        json!({"action":"arm","session":1,"monitor":{"x":0.0,"y":0.0,"width":0.0,"height":10.0}}),
        json!({"action":"arm","session":1,"monitor":{"x":1e9,"y":0.0,"width":10.0,"height":10.0}}),
        json!({"action":"capture"}),
        json!({"session":1}),
    ] {
        assert!(ink.control(&args, now).is_none(), "{args}");
        assert!(!ink.capturing());
    }
}

#[test]
fn release_ends_capture_at_once() {
    let now = Instant::now();
    let mut ink = armed(now);
    draw(&mut ink, now);
    let reply = ink
        .control(
            &json!({"action":"release","session":7,"immediate":true}),
            ms(now, 20),
        )
        .unwrap();
    assert_eq!(reply["capturing"], false);
    assert_eq!(ink.phase, Phase::Hidden);
    assert!(!ink.press(1., 1., ms(now, 30)));
}

#[test]
fn handoff_stops_capture_then_flashes_fades_and_hides() {
    let now = Instant::now();
    let mut ink = armed(now);
    draw(&mut ink, now);
    let reply = ink
        .control(
            &json!({"action":"release","session":7,"handoff":true,"from":1}),
            ms(now, 20),
        )
        .unwrap();
    assert_eq!(reply["disarmed"], "handoff");
    // The remaining point comes back with the release.
    assert_eq!(reply["points"].as_array().unwrap().len(), 1);
    assert_eq!(reply["next"], 2);
    assert_eq!(ink.phase, Phase::Fading);
    assert!(!ink.capturing() && ink.visible() && ink.animating());
    let at = ms(now, 20);
    assert!(ink.envelope(ms(at, 100)).1 > 1., "flash swells the glow");
    assert!(ink.envelope(ms(at, 500)).0 < 1., "then fades");
    assert!(!ink.tick(ms(at, FLASH_MS + FADE_MS - 1), false));
    assert!(ink.tick(ms(at, FLASH_MS + FADE_MS), false));
    assert_eq!(ink.phase, Phase::Hidden);
}

#[test]
fn handoff_without_ink_or_motion_hides_at_once() {
    let now = Instant::now();
    let mut ink = armed(now);
    ink.control(&json!({"action":"release","session":7,"handoff":true}), now);
    assert_eq!(ink.phase, Phase::Hidden);
    let mut reduced = Ink::default();
    reduced.control(
        &json!({"action":"arm","session":1,"reducedMotion":true,"monitor":{"x":0.0,"y":0.0,"width":10.0,"height":10.0}}),
        now,
    );
    draw(&mut reduced, now);
    reduced.control(&json!({"action":"release","session":1,"handoff":true}), now);
    assert_eq!(reduced.phase, Phase::Hidden);
}

#[test]
fn escape_releases_the_pointer_and_keeps_the_strokes() {
    let now = Instant::now();
    let mut ink = armed(now);
    draw(&mut ink, now);
    assert!(ink.tick(ms(now, 50), true));
    assert_eq!(ink.phase, Phase::Held);
    assert!(!ink.capturing() && ink.visible() && !ink.animating());
    let reply = ink
        .control(&json!({"action":"frame","session":7,"from":0}), ms(now, 60))
        .unwrap();
    assert_eq!(reply["ok"], true);
    assert_eq!(reply["capturing"], false);
    assert_eq!(reply["disarmed"], "escape");
    assert_eq!(reply["points"].as_array().unwrap().len(), 2);
    // Escape with nothing drawn simply hides.
    let mut empty = armed(now);
    assert!(empty.tick(ms(now, 10), true));
    assert_eq!(empty.phase, Phase::Hidden);
}

#[test]
fn lease_expiry_without_frames_hides_even_while_drawing() {
    let now = Instant::now();
    let mut ink = armed(now);
    assert!(ink.press(10., 10., now));
    assert!(!ink.tick(ms(now, LEASE_MS), false));
    ink.control(&json!({"action":"frame","session":7}), ms(now, LEASE_MS));
    assert!(!ink.tick(ms(now, LEASE_MS * 2), false), "a frame renews the lease");
    assert!(ink.tick(ms(now, LEASE_MS * 2 + 1), false));
    assert_eq!(ink.phase, Phase::Hidden);
    assert!(!ink.drag(50., 50., ms(now, LEASE_MS * 2 + 2)));
    // The next frame reports why, with the points, so the page can take over.
    let reply = ink
        .control(
            &json!({"action":"frame","session":7}),
            ms(now, LEASE_MS * 2 + 5),
        )
        .unwrap();
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["disarmed"], "lease");
    assert_eq!(reply["points"].as_array().unwrap().len(), 1);
    // A held panel also lets go when the frames stop.
    let mut held = armed(now);
    draw(&mut held, now);
    held.tick(now, true);
    assert!(held.tick(ms(now, LEASE_MS + 1), false));
    assert_eq!(held.phase, Phase::Hidden);
}

#[test]
fn the_time_bound_ends_capture_even_with_frames_arriving() {
    let now = Instant::now();
    let mut ink = armed(now);
    let mut at = now;
    while since(at, now) < BOUND_MS - 500 {
        at = ms(at, 500);
        ink.control(&json!({"action":"frame","session":7}), at);
        assert!(!ink.tick(at, false));
        assert!(ink.capturing());
    }
    let end = ms(now, BOUND_MS);
    ink.control(&json!({"action":"frame","session":7}), end);
    assert!(ink.tick(end, false));
    assert_eq!(ink.phase, Phase::Hidden);
    let reply = ink
        .control(&json!({"action":"frame","session":7}), end)
        .unwrap();
    assert_eq!(reply["disarmed"], "bound");
    assert_eq!(reply["ok"], false);
}

#[test]
fn errors_and_display_loss_disarm() {
    let now = Instant::now();
    let mut ink = armed(now);
    assert!(ink.disarm(Disarm::Error, now));
    assert!(!ink.capturing() && !ink.visible());
    let mut gone = armed(now);
    assert!(gone.disarm(Disarm::Display, now));
    assert!(!gone.capturing());
    assert!(!gone.disarm(Disarm::Release, now), "disarming twice is a no-op");
}

#[test]
fn stale_sessions_never_touch_a_newer_hold() {
    let now = Instant::now();
    let mut ink = armed(now);
    let reply = ink
        .control(&json!({"action":"release","session":6}), now)
        .unwrap();
    assert_eq!(reply["ok"], true);
    assert!(ink.capturing());
    let reply = ink
        .control(&json!({"action":"frame","session":6}), now)
        .unwrap();
    assert_eq!(reply["ok"], false);
    // A stale frame does not renew the lease.
    assert!(ink.tick(ms(now, LEASE_MS + 1), false));
}

#[test]
fn points_are_normalized_to_the_covered_monitor_in_order_and_capped() {
    let now = Instant::now();
    let mut ink = armed(now);
    assert!(ink.press(0., 0., now));
    assert!(ink.drag(500., 250., ms(now, 10)));
    assert!(ink.drag(1500., -20., ms(now, 20)));
    ink.lift();
    assert!(ink.press(250., 125., ms(now, 30)));
    assert!(!ink.drag(250.2, 125.2, ms(now, 31)), "repeats are dropped");
    let points = ink.points_since(0);
    assert_eq!(points[0], [0., 0., 0., 0.]);
    assert_eq!(points[1][..3], [0., 0.5, 0.5]);
    assert!((points[1][3] - 10.).abs() < 1.);
    assert_eq!(points[2][..3], [0., 1., 0.], "clamped like the web overlay");
    assert_eq!(points[3], [1., 0.25, 0.25, 0.]);
    assert_eq!(ink.points_since(3).len(), 1);
    assert!(ink.points_since(9).is_empty());

    let mut full = armed(now);
    for stroke in 0..MAX_STROKES + 4 {
        full.press(stroke as f32, 0., now);
        full.lift();
    }
    assert_eq!(full.strokes.len(), MAX_STROKES);
    assert!(!full.press(0., 0., now), "no stroke past the cap");
    let mut long = armed(now);
    long.press(0., 0., now);
    let mut x = 1.;
    while long.drag(x, 1., now) {
        x += 1.;
    }
    assert_eq!(long.strokes[0].len(), MAX_POINTS);
    assert_eq!(long.points_since(0).len(), REPLY_POINTS);
    assert!(!long.press(5., 5., now), "no point past the cap");
}

#[test]
fn monitors_map_to_their_screen_with_negative_origins_and_mixed_scales() {
    // AppKit frames, primary first: a 1512×982 laptop, a 1920×1080 display to
    // its left and lower, a 2560×1440 display above it.
    let screens = [
        [0., 0., 1512., 982.],
        [-1920., -200., 1920., 1080.],
        [0., 982., 2560., 1440.],
    ];
    let primary = Monitor {
        x: 0.,
        y: 0.,
        width: 1512.,
        height: 982.,
    };
    assert_eq!(appkit_frame(primary, &screens), Some(screens[0]));
    // Top-left desktop points: y = primary top - (AppKit y + height).
    let left = Monitor {
        x: -1920.,
        y: 102.,
        width: 1920.,
        height: 1080.,
    };
    assert_eq!(appkit_frame(left, &screens), Some(screens[1]));
    let above = Monitor {
        x: 0.,
        y: -1440.,
        width: 2560.,
        height: 1440.,
    };
    assert_eq!(appkit_frame(above, &screens), Some(screens[2]));
    // A monitor that was unplugged, or mostly off every screen, is refused.
    let gone = Monitor {
        x: 4000.,
        y: 0.,
        width: 1920.,
        height: 1080.,
    };
    assert_eq!(appkit_frame(gone, &screens), None);
    assert_eq!(appkit_frame(MONITOR, &[]), None);
    let bad = Monitor {
        width: f64::NAN,
        ..MONITOR
    };
    assert_eq!(appkit_frame(bad, &screens), None);
}

#[test]
fn frames_are_requested_only_while_drawing_or_fading() {
    let now = Instant::now();
    let mut ink = Ink::default();
    assert!(!ink.animating());
    ink = armed(now);
    assert!(!ink.animating(), "an armed panel at rest is static");
    assert!(ink.press(1., 1., now));
    assert!(ink.animating(), "the live head pulses");
    ink.lift();
    assert!(!ink.animating());
    draw(&mut ink, now);
    ink.disarm(Disarm::Lease, now);
    assert!(!ink.animating(), "a hidden panel never asks for frames");
}

#[gpui::test]
fn ink_draws_offscreen_in_every_phase(cx: &mut TestAppContext) {
    let (ink, visual) = cx.add_window_view(|_, _| Ink::default());
    let now = Instant::now();
    for step in 0..4 {
        ink.update_in(visual, |ink, _, cx| {
            match step {
                0 => {
                    *ink = armed(now);
                    assert!(ink.press(10., 10., now));
                    assert!(ink.drag(40., 30., ms(now, 16)));
                }
                1 => {
                    ink.lift();
                    ink.disarm(Disarm::Handoff, ms(now, 20));
                }
                2 => {
                    ink.tick(ms(now, 20 + FLASH_MS + FADE_MS), false);
                }
                _ => {}
            }
            cx.notify();
        });
        visual.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear();
        });
    }
    assert!(ink.update_in(visual, |ink, _, _| !ink.visible() && !ink.animating()));
}

#[test]
fn scenes_paint_strokes_taps_and_the_live_head() {
    let marks = |points: &[(f32, f32)]| -> Vec<Mark> {
        points
            .iter()
            .map(|&(x, y)| Mark { x, y, t: 0. })
            .collect()
    };
    let stroke = marks(&[(0., 0.), (10., 0.), (20., 5.), (30., 15.)]);
    let tap = marks(&[(50., 50.)]);
    let scene = draw::Scene::new(&[stroke.clone(), tap.clone()], false, 1., 1., Some(0));
    assert!(!scene.is_empty());
    let reduced = draw::Scene::new(&[stroke, tap], true, 1., 1., None);
    assert!(!reduced.is_empty());
    assert!(draw::Scene::new(&[], false, 1., 1., None).is_empty());
}

#[test]
fn outlines_taper_from_tail_to_head_and_close_round() {
    let points: Vec<(f32, f32)> = (0..20).map(|i| (i as f32 * 5., 0.)).collect();
    let radii = draw::radii(&points, draw::BODY);
    assert!(radii[0] < radii[19], "the tail is thinner than the head");
    assert!(radii.iter().all(|r| *r > 0. && *r <= draw::BODY / 2.));
    let outline = draw::outline(&points, &radii);
    // Both sides plus a seven-point cap at each end.
    assert_eq!(outline.len(), 20 * 2 + 14);
    assert!(draw::outline(&points[..1], &radii[..1]).is_empty());
    // Streamlining keeps the head on the pointer.
    let raw: Vec<Mark> = points
        .iter()
        .map(|&(x, y)| Mark { x, y, t: 0. })
        .collect();
    assert_eq!(draw::streamline(&raw).last(), Some(&(95., 0.)));
}

#[test]
fn the_watchdog_fires_only_for_a_stalled_capture() {
    assert!(!watchdog::stalled(false, 0, 1_000_000));
    assert!(!watchdog::stalled(true, 1_000, 1_000 + 3_000));
    assert!(watchdog::stalled(true, 1_000, 1_000 + 3_001));
}

#[test]
fn timing_matches_the_web_feed() {
    let timing: Value =
        serde_json::from_str(include_str!("../../../src/lib/next/ink-timing.json")).unwrap();
    assert_eq!(timing["leaseMs"], LEASE_MS);
    assert_eq!(timing["boundMs"], BOUND_MS);
    // The page takes the pointer back (request deadline after a cadence)
    // before this lease can run out after the last frame it received.
    let request = timing["requestMs"].as_u64().unwrap();
    let cadence = timing["cadenceMs"].as_u64().unwrap();
    assert!(cadence + request < LEASE_MS);
}
