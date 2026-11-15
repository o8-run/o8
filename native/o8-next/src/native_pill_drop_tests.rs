//! The drop target and staged chips in the real Pill model: drawn, static,
//! and never a click target (drags pass through to the web dock window).
use super::*;

fn draw(pill: &Entity<Pill>, frame: Value, visual: &mut gpui::VisualTestContext) {
    pill.update_in(visual, |pill, _, cx| {
        pill.apply(serde_json::from_value(frame).unwrap());
        pill.motion = crate::motion::Transition::settled(160, true);
        cx.notify();
    });
    visual.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}

#[gpui::test]
fn drop_target_and_staged_chips_draw_without_taking_clicks(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    draw(
        &pill,
        json!({"state":"drop","session":1,"holdMs":5000}),
        visual,
    );
    assert!(visual.debug_bounds("native-dock-drop").is_some());
    assert!(pill.read_with(visual, |p, _| p.hit_rects(capsules::now_ms()).is_empty()));
    assert_eq!(
        pill.read_with(visual, |p, _| capsules::size(&p.snapshot)),
        (320., 64.)
    );
    let staged = json!({"state":"staged","session":2,"holdMs":5000,"staged":{
        "files":[{"name":"notes.txt","size":"2 KB"},{"name":"plan.md","size":"1.5 MB"}],"extra":2}});
    draw(&pill, staged, visual);
    assert!(visual.debug_bounds("native-dock-staged").is_some());
    assert!(pill.read_with(visual, |p, _| p.hit_rects(capsules::now_ms()).is_empty()));
    assert_eq!(
        pill.read_with(visual, |p, _| capsules::size(&p.snapshot)),
        (420., 56.)
    );
    // Both are static frames: the hold, not the 750 ms lease, retires them.
    pill.update(visual, |pill, _| {
        assert_eq!(pill.lease, 5000);
        pill.heard = Instant::now() - Duration::from_millis(751);
        pill.expire();
        assert!(pill.target);
        pill.heard = Instant::now() - Duration::from_millis(5001);
        pill.expire();
        assert!(!pill.target);
    });
}

#[gpui::test]
fn staged_without_files_never_shows_and_releases_name_their_kind(cx: &mut TestAppContext) {
    let (pill, visual) = cx.add_window_view(|_, _| Pill::default());
    pill.update(visual, |pill, _| {
        pill.apply(
            serde_json::from_value(json!({"state":"staged","session":1,"staged":{"files":[]}}))
                .unwrap(),
        );
        assert!(!pill.target);
    });
    assert_eq!(capsules::kind("drop"), "drop");
    assert_eq!(capsules::kind("staged"), "staged");
}
