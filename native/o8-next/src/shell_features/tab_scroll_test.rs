use super::*;
use crate::shell::test_support::*;
use gpui::{Modifiers, ScrollDelta, ScrollWheelEvent};

struct TabScrollTests;
register_shell_feature!(TabScrollTests);
thread_local! { static BUBBLED: Cell<bool> = const { Cell::new(false) }; }
impl ShellFeature for TabScrollTests {
    fn slots(&self) -> &'static [RenderSlot] {
        &[RenderSlot {
            group: RenderGroup::Chrome,
            order: -100,
            render: |s, _, _, _| {
                s.file.ends_with("tab-wheel.json").then(|| {
                    canvas(
                        |_, _, _| (),
                        |_, _, window, _| {
                            // An ancestor-level bubble observer: consumed strip events never reach it.
                            window.on_mouse_event(|_: &ScrollWheelEvent, phase, _, _| {
                                if phase == gpui::DispatchPhase::Bubble {
                                    BUBBLED.set(true);
                                }
                            });
                        },
                    )
                    .absolute()
                    .inset_0()
                    .into_any_element()
                })
            },
        }]
    }
}

fn bounds(cx: &mut VisualTestContext, id: &str) -> Bounds<gpui::Pixels> {
    draw(cx);
    cx.debug_bounds(Box::leak(id.to_owned().into_boxed_str()))
        .unwrap_or_else(|| panic!("missing {id}"))
}

fn click(cx: &mut VisualTestContext, id: &str) {
    let target = bounds(cx, id);
    cx.simulate_click(target.center(), Modifiers::default());
    draw(cx);
}

fn settle(cx: &mut VisualTestContext) {
    let until = Instant::now() + Duration::from_millis(300);
    while Instant::now() < until {
        draw(cx);
        std::thread::sleep(Duration::from_millis(10));
    }
    draw(cx);
}

fn wheel(
    cx: &mut VisualTestContext,
    strip: &str,
    delta: ScrollDelta,
    modifiers: Modifiers,
) -> bool {
    let position = bounds(cx, strip).center();
    BUBBLED.set(false);
    cx.simulate_event(ScrollWheelEvent {
        position,
        delta,
        modifiers,
        ..Default::default()
    });
    let propagated = BUBBLED.get();
    draw(cx);
    propagated
}

fn pixels(x: f32, y: f32) -> ScrollDelta {
    ScrollDelta::Pixels(point(px(x), px(y)))
}

fn setup(cx: &mut TestAppContext, overflow: bool) -> (Fixture, Entity<Shell>, VisualTestContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("tab-wheel.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_resize(size(px(1200.), px(816.)));
    if overflow {
        // Seed open tabs, then exercise only production mouse/key handlers.
        shell.update(&mut visual, |s, cx| {
            let first = s.active().unwrap();
            let other = s
                .sessions
                .iter()
                .find(|item| Some(Tab::Session(item.id.clone())) != s.active())
                .unwrap()
                .id
                .clone();
            let tabs = vec![
                first,
                Tab::Session(other),
                Tab::Grid,
                Tab::Brain,
                Tab::Workers,
                Tab::Issues,
            ];
            for (i, tab) in tabs.iter().enumerate() {
                s.state
                    .tab_labels
                    .insert(s.key(tab), format!("Workspace tab {i} long label"));
            }
            let saved = s
                .state
                .workspaces
                .get_mut(s.state.selected.as_deref().unwrap())
                .unwrap();
            saved.tabs = tabs;
            saved.active = 0;
            cx.notify();
        });
    }
    click(&mut visual, "header-right-panel");
    settle(&mut visual);
    click(&mut visual, "panel-tool-devices");
    if overflow {
        for tool in ["threads", "side-chat", "resources", "targeting"] {
            wheel(
                &mut visual,
                "panel-tabs",
                pixels(-10000., 0.),
                Modifiers::default(),
            );
            click(&mut visual, "panel-new-tab");
            settle(&mut visual);
            click(&mut visual, &format!("panel-add-{tool}"));
        }
    }
    settle(&mut visual);
    // Moving a strip does not change its active tab or snap it back.
    for strip in ["surface-tabs", "panel-tabs"] {
        wheel(&mut visual, strip, pixels(10000., 0.), Modifiers::default());
    }
    (fixture, shell, visual)
}

#[gpui::test]
fn tab_wheel_overflow_moves_both_strips_and_updates_fades(cx: &mut TestAppContext) {
    let (_fixture, _shell, mut visual) = setup(cx, true);
    for (strip, tab) in [
        ("surface-tabs", "surface-tab-0"),
        ("panel-tabs", "panel-tab-close-devices"),
    ] {
        let before = bounds(&mut visual, tab).left();
        assert!(
            !wheel(
                &mut visual,
                strip,
                ScrollDelta::Lines(point(0., -3.)),
                Modifiers::default()
            ),
            "a moving strip must consume its wheel"
        );
        let after = bounds(&mut visual, tab).left();
        assert!(
            (f32::from(before - after) - 48.).abs() < 0.2,
            "vertical lines map to 16px: {before:?} -> {after:?}"
        );
        assert!(
            visual
                .debug_bounds(Box::leak(format!("{strip}-fades-11").into_boxed_str()))
                .is_some(),
            "both edge fades follow the scrolled strip"
        );
        wheel(
            &mut visual,
            strip,
            pixels(0., -10000.),
            Modifiers::default(),
        );
        assert!(
            visual
                .debug_bounds(Box::leak(format!("{strip}-fades-10").into_boxed_str()))
                .is_some(),
            "the right fade disappears at the end"
        );
        assert!(
            wheel(&mut visual, strip, pixels(0., -10.), Modifiers::default()),
            "a clamped edge lets the event through"
        );
    }
}

#[gpui::test]
fn tab_wheel_fitting_strips_and_zoom_gestures_propagate(cx: &mut TestAppContext) {
    let (_fixture, _shell, mut visual) = setup(cx, false);
    for (strip, tab) in [
        ("surface-tabs", "surface-tab-0"),
        ("panel-tabs", "panel-tab-close-devices"),
    ] {
        let before = bounds(&mut visual, tab);
        assert!(wheel(
            &mut visual,
            strip,
            pixels(0., -70.),
            Modifiers::default()
        ));
        assert_eq!(
            bounds(&mut visual, tab),
            before,
            "fitting strips must not move"
        );
    }
    // Zoom must also be ignored when the strip has room to scroll.
    let (_overflow_fixture, _overflow_shell, mut visual) = setup(&mut visual.cx, true);
    for (strip, tab) in [
        ("surface-tabs", "surface-tab-0"),
        ("panel-tabs", "panel-tab-close-devices"),
    ] {
        for modifiers in [
            Modifiers {
                control: true,
                ..Default::default()
            },
            Modifiers {
                platform: true,
                ..Default::default()
            },
        ] {
            let before = bounds(&mut visual, tab);
            assert!(wheel(&mut visual, strip, pixels(0., -70.), modifiers));
            assert!(wheel(&mut visual, strip, pixels(-70., 0.), modifiers));
            assert_eq!(
                bounds(&mut visual, tab),
                before,
                "zoom must not scroll either axis"
            );
        }
    }
}

#[gpui::test]
fn tab_wheel_horizontal_trackpad_keeps_its_axis(cx: &mut TestAppContext) {
    let (_fixture, _shell, mut visual) = setup(cx, true);
    for (strip, tab) in [
        ("surface-tabs", "surface-tab-0"),
        ("panel-tabs", "panel-tab-close-devices"),
    ] {
        let before = bounds(&mut visual, tab);
        assert!(
            wheel(&mut visual, strip, pixels(-37., -90.), Modifiers::default()),
            "horizontal trackpads retain native bubble propagation"
        );
        let after = bounds(&mut visual, tab);
        assert!(
            (f32::from(before.left() - after.left()) - 37.).abs() < 0.2,
            "horizontal delta stays native, without adding deltaY"
        );
        assert_eq!(before.top(), after.top());
    }
}

#[gpui::test]
fn tab_wheel_activating_offscreen_tabs_reveals_with_classic_inset(cx: &mut TestAppContext) {
    let (_fixture, _shell, mut visual) = setup(cx, true);
    let viewport = bounds(&mut visual, "surface-tabs");
    assert!(bounds(&mut visual, "surface-tab-1").right() > viewport.right());
    visual.simulate_keystrokes("ctrl-tab");
    settle(&mut visual);
    let tab = bounds(&mut visual, "surface-tab-1");
    let gap = f32::from(viewport.right() - tab.right());
    assert!(
        (gap - 22.).abs() < 0.3,
        "new active workspace tab needs the 22px inset, got {gap}"
    );

    // The picker activates an existing tab even while that tab is off screen.
    wheel(
        &mut visual,
        "panel-tabs",
        pixels(-10000., 0.),
        Modifiers::default(),
    );
    click(&mut visual, "panel-new-tab");
    settle(&mut visual);
    click(&mut visual, "panel-add-threads");
    settle(&mut visual);
    let viewport = bounds(&mut visual, "panel-tabs");
    let tab = bounds(&mut visual, "panel-tab");
    let gap = f32::from(tab.left() - viewport.left());
    assert!(
        (gap - 22.).abs() < 0.3,
        "new active panel tab needs the 22px inset, got {gap}"
    );
}
