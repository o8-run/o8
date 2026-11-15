use super::*;

fn frame(state: &str, session: u64, surface: &str) -> Value {
    json!({"action":"frame","snapshot":{
        "state": state, "session": session, "audioLevel": 0.6, "durationMs": 12000,
        "hud": {"surface": surface, "title": "Symon · Listening", "text": "hello there",
            "dim": false, "solid": false, "reducedMotion": false,
            "placement": {"x": 100.0, "y": 50.0, "width": 460.0, "height": 138.0}}
    }})
}

#[test]
fn frames_with_detail_show_and_unknown_or_bare_frames_never_do() {
    let mut hud = Hud::default();
    assert_eq!(hud.control(&json!({"action":"prepare"})), Some(false));
    assert_eq!(hud.control(&frame("recording", 1, "caret")), Some(true));
    assert!(hud.target);
    let placement = hud
        .snapshot
        .hud
        .as_ref()
        .and_then(|detail| detail.placement);
    assert_eq!(
        placement,
        Some(Placement {
            x: 100.,
            y: 50.,
            width: 460.,
            height: 138.
        })
    );
    // A dock-shaped frame without HUD detail, or an unknown state, is invisible.
    let mut fresh = Hud::default();
    fresh.control(&json!({"action":"frame","snapshot":{"state":"recording","session":1}}));
    assert!(!fresh.target);
    fresh.control(&frame("speaking", 1, "caret"));
    assert!(!fresh.target);
    assert_eq!(fresh.control(&json!({"action":"start-capture"})), None);
    assert_eq!(fresh.control(&json!({"action":"frame","snapshot":7})), None);
}

#[test]
fn every_dictation_phase_shows_and_idle_retires() {
    let mut hud = Hud::default();
    for state in [
        "requesting-mic",
        "recording",
        "transcribing",
        "polishing",
        "success",
        "error",
    ] {
        hud.control(&frame(state, 1, "hud"));
        assert!(hud.target, "{state}");
    }
    hud.control(&frame("idle", 1, "hud"));
    assert!(!hud.target);
}

#[test]
fn lease_expiry_hides_without_a_fade() {
    let mut hud = Hud::default();
    hud.control(&frame("recording", 1, "caret"));
    hud.expire();
    assert!(hud.target);
    hud.heard = Instant::now() - Duration::from_millis(LEASE_MS + 10);
    hud.expire();
    assert!(!hud.target);
    assert!(!hud.motion.value().1, "expiry hides at once");
}

#[test]
fn a_late_release_never_hides_a_newer_session() {
    let mut hud = Hud::default();
    hud.control(&frame("recording", 2, "caret"));
    hud.control(&json!({"action":"release","session":1,"kind":"dictation"}));
    assert!(hud.target);
    hud.control(&json!({"action":"release","session":2,"kind":"dictation","immediate":true}));
    assert!(!hud.target);
    assert!(!hud.motion.value().1);
}

#[test]
fn placement_converts_to_appkit_and_stays_on_one_screen() {
    let primary = [0., 0., 1440., 900.];
    let caret = Placement {
        x: 100.,
        y: 50.,
        width: 460.,
        height: 138.,
    };
    assert_eq!(
        appkit_frame(Some(caret), &[primary]),
        Some([100., 712., 460., 138.])
    );
    // A secondary display above the primary has a negative top-left y.
    let above = [0., 900., 1920., 1080.];
    let on_above = Placement {
        x: 10.,
        y: -400.,
        width: 460.,
        height: 138.,
    };
    assert_eq!(
        appkit_frame(Some(on_above), &[primary, above]),
        Some([10., 1162., 460., 138.])
    );
    // Off every screen: onto the nearest one, not into the gap between them.
    let offset = [2000., 2000., 1000., 800.];
    let gap = Placement {
        x: 1600.,
        y: -1500.,
        width: 460.,
        height: 138.,
    };
    assert_eq!(
        appkit_frame(Some(gap), &[primary, offset]),
        Some([2000., 2262., 460., 138.])
    );
    let far = Placement {
        x: 90_000.,
        y: -90_000.,
        width: 460.,
        height: 138.,
    };
    assert_eq!(
        appkit_frame(Some(far), &[primary]),
        Some([980., 762., 460., 138.])
    );
    // Oversized: capped to its screen, keeping the top edge with the capped height.
    let huge = Placement {
        x: 0.,
        y: 0.,
        width: 5000.,
        height: 5000.,
    };
    assert_eq!(
        appkit_frame(Some(huge), &[primary]),
        Some([0., 0., 1440., 900.])
    );
    // Capped by the largest frame: the top edge stays where the shell put it.
    let large = [0., 0., 2560., 1600.];
    let tall = Placement {
        x: 0.,
        y: 100.,
        width: 460.,
        height: 1500.,
    };
    assert_eq!(
        appkit_frame(Some(tall), &[large]),
        Some([0., 476., 460., 1024.])
    );
    let broken = Placement {
        x: f64::NAN,
        ..caret
    };
    assert_eq!(appkit_frame(Some(broken), &[primary]), None);
    assert_eq!(appkit_frame(None, &[primary]), None);
    assert_eq!(appkit_frame(Some(caret), &[]), None);
}

#[test]
fn unplaced_frames_never_show_and_a_takeover_needs_no_entrance() {
    let mut hud = Hud::default();
    let mut unplaced = frame("recording", 1, "caret");
    unplaced["snapshot"]["hud"]["placement"] = Value::Null;
    assert_eq!(hud.control(&unplaced), Some(false));
    assert!(!hud.target);
    // The web bar is already on screen: the panel takes over at full opacity.
    assert_eq!(hud.control(&frame("recording", 1, "caret")), Some(true));
    let (opacity, moving) = hud.motion.value();
    assert!(opacity > 0.999 && !moving);
}

#[test]
fn a_released_panel_stops_animating_and_drops_its_content() {
    for immediate in [true, false] {
        let mut hud = Hud::default();
        hud.control(&frame("polishing", 1, "caret"));
        assert!(hud.animating(), "polishing travels while shown");
        hud.control(&json!({"action":"release","session":1,"immediate":immediate}));
        if !immediate {
            assert!(hud.animating(), "the exit fade still runs");
            assert!(!hud.settle(), "content stays for the fade");
            std::thread::sleep(Duration::from_millis(200));
        }
        assert!(!hud.animating(), "a hidden panel requests no frames");
        assert!(hud.settle());
        assert!(hud.snapshot.hud.is_none());
        assert!(!hud.animating());
    }
    // Lease expiry from a processing state, too.
    let mut hud = Hud::default();
    hud.control(&frame("transcribing", 1, "caret"));
    hud.heard = Instant::now() - Duration::from_millis(LEASE_MS + 10);
    hud.expire();
    assert!(!hud.animating());
    assert!(hud.settle());
}

#[test]
fn polishing_dash_travels_like_the_web_stroke() {
    let pieces = marks::polish_pieces();
    assert_eq!(pieces.len(), 72);
    assert!(pieces.first().unwrap().2 < 1. && pieces.last().unwrap().2 > 99.);
    // dashoffset 36 at rest: the dash covers the path's last 36.
    assert_eq!(marks::dash_start(0), -36.);
    assert!(marks::in_dash(80., marks::dash_start(0)));
    assert!(!marks::in_dash(20., marks::dash_start(0)));
    // Half way through the 2.1 s cycle the offset is -36: positions 36 to 72.
    assert_eq!(marks::dash_start(1050), 36.);
    assert!(marks::in_dash(50., 36.) && !marks::in_dash(80., 36.));
}

#[test]
fn level_eases_over_70_ms_unless_motion_is_reduced() {
    let mut level = marks::LevelEase::default();
    level.set(0.8);
    let (now, moving) = level.value(false);
    assert!(moving && now < 0.8);
    assert_eq!(level.value(true), (0.8, false));
    level.set(f32::NAN);
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(level.value(false), (0., false));
}

#[gpui::test]
fn hud_states_draw_offscreen_without_input(cx: &mut TestAppContext) {
    let (hud, visual) = cx.add_window_view(|_, _| Hud::default());
    for surface in ["caret", "hud"] {
        for (state, reduced) in [
            ("requesting-mic", false),
            ("recording", false),
            ("transcribing", false),
            ("polishing", true),
            ("success", false),
            ("error", true),
        ] {
            hud.update_in(visual, |hud, _, cx| {
                let mut value = frame(state, 1, surface);
                value["snapshot"]["hud"]["reducedMotion"] = json!(reduced);
                value["snapshot"]["hud"]["solid"] = json!(reduced);
                hud.control(&value);
                hud.motion = crate::motion::Transition::settled(160, true);
                cx.notify();
            });
            visual.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear();
            });
            assert!(
                visual.debug_bounds("native-dictation-hud").is_some(),
                "{surface} {state}"
            );
        }
    }
    hud.update_in(visual, |hud, _, cx| {
        hud.control(&json!({"action":"release","immediate":true}));
        cx.notify();
    });
    visual.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    assert!(hud.update_in(visual, |hud, _, _| !hud.target));
}
