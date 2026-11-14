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
fn placement_converts_to_appkit_and_falls_back_to_the_legacy_anchor() {
    let primary = [0., 0., 1440., 900.];
    let caret = Placement {
        x: 100.,
        y: 50.,
        width: 460.,
        height: 138.,
    };
    assert_eq!(
        appkit_frame(Some(caret), primary),
        Some([100., 712., 460., 138.])
    );
    // A secondary display above the primary has a negative top-left y.
    let above = Placement {
        x: 10.,
        y: -400.,
        width: 460.,
        height: 138.,
    };
    assert_eq!(
        appkit_frame(Some(above), primary),
        Some([10., 1162., 460., 138.])
    );
    assert_eq!(appkit_frame(None, primary), Some([310., 48., 820., 220.]));
    let broken = Placement {
        x: f64::NAN,
        ..caret
    };
    assert_eq!(
        appkit_frame(Some(broken), primary),
        Some([310., 48., 820., 220.])
    );
    assert_eq!(appkit_frame(None, [0., 0., 0., 0.]), None);
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
