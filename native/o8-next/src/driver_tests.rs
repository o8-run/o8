use super::*;
use gpui::{
    Context, FocusHandle, InteractiveElement, IntoElement, KeyDownEvent, ParentElement, Render,
    StatefulInteractiveElement, Styled, TestAppContext, VisualTestContext, div,
};

/// A window with a plain control, one that changes real state, one drawn
/// over part of the plain one, and a place to type.
struct Probe {
    focus: FocusHandle,
    ok: usize,
    stop: usize,
    covered: usize,
    under: usize,
    inner: usize,
    scrolled: f32,
    keys: Vec<String>,
}

impl Render for Probe {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let button = |id: &'static str| {
            div()
                .id(id)
                .debug_selector(move || id.into())
                .w(px(120.))
                .h(px(30.))
        };
        div()
            .size_full()
            .track_focus(&self.focus)
            .on_key_down(cx.listener(|probe, event: &KeyDownEvent, _, _| {
                probe.keys.push(event.keystroke.key.clone());
            }))
            .on_scroll_wheel(cx.listener(|probe, event: &ScrollWheelEvent, _, _| {
                probe.scrolled += f32::from(event.delta.pixel_delta(px(1.)).y);
            }))
            .child(button("probe-ok").on_click(cx.listener(|probe, _, _, _| probe.ok += 1)))
            .child(
                button("probe-stop-mission")
                    .on_click(cx.listener(|probe, _, _, _| probe.stop += 1)),
            )
            .child(
                button("probe-covered").on_click(cx.listener(|probe, _, _, _| probe.covered += 1)),
            )
            .child(
                // Drawn over the whole of "probe-covered".
                div()
                    .absolute()
                    .top(px(60.))
                    .left(px(0.))
                    .child(button("probe-merge-over")),
            )
            .child(button("probe-far").absolute().top(px(5000.)))
            .child(
                div()
                    .id("probe-box")
                    .debug_selector(|| "probe-box".into())
                    .absolute()
                    .top(px(200.))
                    .w(px(200.))
                    .h(px(100.))
                    .on_click(|_, _, _| {})
                    .child(
                        div()
                            .id("inner")
                            .absolute()
                            .top(px(30.))
                            .left(px(60.))
                            .w(px(80.))
                            .h(px(40.))
                            .on_click(cx.listener(|probe, _, _, _| probe.inner += 1)),
                    ),
            )
            .child(button("probe-under").on_click(cx.listener(|probe, _, _, _| probe.under += 1)))
            .child(
                // Nothing names this, and it takes the press meant for
                // "probe-under" (the fourth row).
                div()
                    .id("unnamed")
                    .absolute()
                    .top(px(80.))
                    .left(px(0.))
                    .w(px(400.))
                    .h(px(60.))
                    .on_click(|_, _, _| {}),
            )
    }
}

fn probe(cx: &mut TestAppContext) -> (gpui::Entity<Probe>, &mut VisualTestContext) {
    let (probe, cx) = cx.add_window_view(|window, cx| {
        let focus = cx.focus_handle();
        focus.focus(window);
        Probe {
            focus,
            ok: 0,
            stop: 0,
            covered: 0,
            under: 0,
            inner: 0,
            scrolled: 0.,
            keys: vec![],
        }
    });
    draw(cx);
    (probe, cx)
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}

fn ask(cx: &mut VisualTestContext, request: Value) -> Value {
    // As the socket loop does: the request, then the frame that follows it.
    let answer = cx.update(|window, cx| answer(&request, window, cx));
    cx.update(|window, cx| settle(window, cx));
    answer
}

#[gpui::test]
fn a_press_lands_on_the_named_control(cx: &mut TestAppContext) {
    let (probe, cx) = probe(cx);
    let answer = ask(cx, json!({"command": "press", "selector": "probe-ok"}));
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(probe.read_with(cx, |probe, _| (probe.ok, probe.stop)), (1, 0));
    // A name that is not in the frame is an error, never a press elsewhere.
    let answer = ask(cx, json!({"command": "press", "selector": "probe-gone"}));
    assert_eq!(answer["ok"], false);
    assert!(answer["error"].as_str().unwrap().contains("no control named"));
    let answer = ask(cx, json!({"command": "press", "selector": "probe-far"}));
    assert!(answer["error"].as_str().unwrap().contains("not on screen"));
    assert_eq!(probe.read_with(cx, |probe, _| (probe.ok, probe.stop)), (1, 0));
}

#[gpui::test]
fn a_control_that_changes_real_state_must_be_named(cx: &mut TestAppContext) {
    let (probe, cx) = probe(cx);
    let answer = ask(
        cx,
        json!({"command": "press", "selector": "probe-stop-mission"}),
    );
    assert_eq!(answer["ok"], false);
    assert!(answer["error"].as_str().unwrap().contains("changes real state"));
    assert_eq!(probe.read_with(cx, |probe, _| probe.stop), 0);
    // Naming another control does not unlock this one.
    let answer = ask(
        cx,
        json!({"command": "press", "selector": "probe-stop-mission", "allow": ["probe-ok"]}),
    );
    assert_eq!(answer["ok"], false);
    let answer = ask(
        cx,
        json!({"command": "press", "selector": "probe-stop-mission",
            "allow": ["probe-stop-mission"]}),
    );
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(probe.read_with(cx, |probe, _| probe.stop), 1);
    // A plain control with a guarded one drawn over it is refused too: the
    // press would go to the one on top.
    let answer = ask(cx, json!({"command": "press", "selector": "probe-covered"}));
    assert_eq!(answer["ok"], false);
    assert!(answer["error"].as_str().unwrap().contains("probe-merge-over"));
    assert_eq!(probe.read_with(cx, |probe, _| probe.covered), 0);
}

#[gpui::test]
fn a_press_is_refused_when_something_unnamed_is_on_top(cx: &mut TestAppContext) {
    let (probe, cx) = probe(cx);
    let answer = ask(cx, json!({"command": "press", "selector": "probe-under"}));
    assert_eq!(answer["ok"], false, "{answer}");
    assert!(answer["error"].as_str().unwrap().contains("would reach"));
    assert_eq!(probe.read_with(cx, |probe, _| probe.under), 0);
}

#[gpui::test]
fn the_snapshot_lists_named_controls_and_marks_guarded_ones(cx: &mut TestAppContext) {
    let (_probe, cx) = probe(cx);
    let answer = ask(cx, json!({"command": "snapshot", "prefix": "probe-"}));
    let controls = answer["result"]["controls"].as_array().unwrap();
    let names: Vec<_> = controls
        .iter()
        .map(|control| control["selector"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "probe-box",
            "probe-covered",
            "probe-far",
            "probe-merge-over",
            "probe-ok",
            "probe-stop-mission",
            "probe-under"
        ]
    );
    let ok = &controls[4];
    assert_eq!((ok["width"].as_f64(), ok["height"].as_f64()), (Some(120.), Some(30.)));
    assert_eq!(ok["guarded"], false);
    assert_eq!(controls[5]["guarded"], true);
    assert!(answer["result"]["viewport"]["width"].as_f64().unwrap() > 0.);
}

#[gpui::test]
fn keys_and_the_wheel_reach_the_window(cx: &mut TestAppContext) {
    let (probe, cx) = probe(cx);
    let answer = ask(cx, json!({"command": "key", "keys": "escape cmd-k"}));
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(probe.read_with(cx, |probe, _| probe.keys.clone()), ["escape", "k"]);
    // Keys that confirm, send or run something must each be named.
    for (keys, name) in [
        ("enter", "key:enter"),
        ("tab space", "key:space"),
        ("ctrl-m", "key:ctrl-m"),
        ("ctrl-j", "key:ctrl-j"),
        ("shift-enter", "key:enter"),
        ("cmd-w", "key:cmd-w"),
    ] {
        let answer = ask(cx, json!({"command": "key", "keys": keys}));
        assert_eq!(answer["ok"], false, "{keys}");
        let answer = ask(cx, json!({"command": "key", "keys": keys, "allow": ["key:escape"]}));
        assert_eq!(answer["ok"], false, "{keys}");
        assert!(answer["error"].as_str().unwrap().contains(name), "{answer}");
    }
    assert_eq!(probe.read_with(cx, |probe, _| probe.keys.len()), 2);
    let answer = ask(
        cx,
        json!({"command": "key", "keys": "enter", "allow": ["key:enter"]}),
    );
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(probe.read_with(cx, |probe, _| probe.keys.len()), 3);
    let answer = ask(
        cx,
        json!({"command": "scroll", "selector": "probe-ok", "dy": 36}),
    );
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(probe.read_with(cx, |probe, _| probe.scrolled), 36.);
    let answer = ask(cx, json!({"command": "dance"}));
    assert!(answer["error"].as_str().unwrap().contains("unknown command"));
}

#[gpui::test]
fn a_press_on_a_container_does_not_go_to_the_button_inside_it(cx: &mut TestAppContext) {
    let (probe, cx) = probe(cx);
    // "probe-box" is named; the button at its centre is not.
    let answer = ask(cx, json!({"command": "press", "selector": "probe-box"}));
    assert_eq!(answer["ok"], false, "{answer}");
    assert!(answer["error"].as_str().unwrap().contains("container"));
    assert_eq!(probe.read_with(cx, |probe, _| probe.inner), 0);
}

#[gpui::test]
fn text_for_a_focused_terminal_must_be_named(cx: &mut TestAppContext) {
    let (_probe, cx) = probe(cx);
    cx.update(|window, cx| {
        settle(window, cx);
        terminal_has_focus();
        let refused = handle(&json!({"command": "type", "text": "y"}), window, cx);
        assert!(refused["error"].as_str().unwrap().contains("type:terminal"), "{refused}");
        // Named, it gets as far as finding nothing here that takes text.
        let named = handle(
            &json!({"command": "type", "text": "y", "allow": ["type:terminal"]}),
            window,
            cx,
        );
        assert!(named["error"].as_str().unwrap().contains("takes text"), "{named}");
    });
}

#[gpui::test]
fn typed_text_never_reaches_a_key_listener(cx: &mut TestAppContext) {
    let (probe, cx) = probe(cx);
    // Nothing here takes text, so it is refused rather than sent as keys:
    // a space would otherwise act on a focused button.
    let answer = ask(cx, json!({"command": "type", "text": "a b"}));
    assert_eq!(answer["ok"], false);
    assert!(answer["error"].as_str().unwrap().contains("takes text"));
    let answer = ask(cx, json!({"command": "type", "text": "a\nb"}));
    assert!(answer["error"].as_str().unwrap().contains("printable"));
    assert!(probe.read_with(cx, |probe, _| probe.keys.is_empty()));
}

#[test]
fn names_that_change_real_state_are_guarded() {
    for name in [
        "activity-stop-mission",
        "composer-send",
        "proposal-accept-3",
        "packet-close-unmerged",
        "sidebar-row-settle",
        "pr-Merge",
        // The buttons that carry out a merge, close, pick or reply.
        "pr-confirm",
        "pr-close-with-comment",
        "pr-retry-close",
        "pr-ready-button",
        "comparison-confirm",
        "comparison-pick",
        "sidebar-snooze-custom-confirm",
        "thread-auto-off-abc",
        "worker-pane-steer-7",
        "pane-close-7",
        "inbox-respond-4",
        "provider-sign-in",
        "sidebar-row-regenerate-title",
    ] {
        assert!(guarded(name), "{name}");
    }
    for name in ["activity-refresh", "header-sidebar", "sender-name", "stopwatch"] {
        assert!(!guarded(name), "{name}");
    }
}

#[gpui::test]
fn a_press_lands_on_the_named_control_at_any_zoom(cx: &mut TestAppContext) {
    let (probe, cx) = probe(cx);
    // At 200% the second row's centre, sent unconverted, is the first row's.
    cx.update(|window, cx| window.set_zoom(2., cx));
    draw(cx);
    let answer = ask(
        cx,
        json!({"command": "press", "selector": "probe-stop-mission",
            "allow": ["probe-stop-mission"]}),
    );
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(
        probe.read_with(cx, |probe, _| (probe.ok, probe.stop)),
        (0, 1),
        "the press reached the named control, not the one above it"
    );
}
