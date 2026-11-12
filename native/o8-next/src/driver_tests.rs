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
    let answer = cx.update(|window, cx| handle(&request, window, cx));
    draw(cx);
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
            "probe-covered",
            "probe-far",
            "probe-merge-over",
            "probe-ok",
            "probe-stop-mission"
        ]
    );
    let ok = &controls[3];
    assert_eq!((ok["width"].as_f64(), ok["height"].as_f64()), (Some(120.), Some(30.)));
    assert_eq!(ok["guarded"], false);
    assert_eq!(controls[4]["guarded"], true);
    assert!(answer["result"]["viewport"]["width"].as_f64().unwrap() > 0.);
}

#[gpui::test]
fn keys_text_and_the_wheel_reach_the_window(cx: &mut TestAppContext) {
    let (probe, cx) = probe(cx);
    let answer = ask(cx, json!({"command": "key", "keys": "escape cmd-k"}));
    assert_eq!(answer["ok"], true, "{answer}");
    let answer = ask(cx, json!({"command": "type", "text": "a b"}));
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(
        probe.read_with(cx, |probe, _| probe.keys.clone()),
        ["escape", "k", "a", "space", "b"]
    );
    // Enter sends and confirms, so it must be named; text never carries one.
    let answer = ask(cx, json!({"command": "key", "keys": "enter"}));
    assert_eq!(answer["ok"], false);
    let answer = ask(cx, json!({"command": "type", "text": "a\nb"}));
    assert_eq!(answer["ok"], false);
    let answer = ask(
        cx,
        json!({"command": "key", "keys": "enter", "allow": ["key:enter"]}),
    );
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(probe.read_with(cx, |probe, _| probe.keys.len()), 6);
    let answer = ask(
        cx,
        json!({"command": "scroll", "selector": "probe-ok", "dy": 36}),
    );
    assert_eq!(answer["ok"], true, "{answer}");
    assert_eq!(probe.read_with(cx, |probe, _| probe.scrolled), 36.);
    let answer = ask(cx, json!({"command": "dance"}));
    assert!(answer["error"].as_str().unwrap().contains("unknown command"));
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
    ] {
        assert!(guarded(name), "{name}");
    }
    for name in ["activity-refresh", "header-sidebar", "sender-name", "stopwatch"] {
        assert!(!guarded(name), "{name}");
    }
}
