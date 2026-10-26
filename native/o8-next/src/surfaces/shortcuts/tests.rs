use crate::shell::test_support::*;
#[path = "review_tests.rs"]
mod review;
use crate::shell::*;
#[path = "binding_tests.rs"]
mod bindings;
#[path = "modal_tests.rs"]
mod modal;

fn shortcuts_draw(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    draw(cx);
}

fn shortcuts_click(cx: &mut VisualTestContext, selector: &'static str) {
    draw(cx);
    let bounds = cx.debug_bounds(selector).expect("painted shortcut control");
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    shortcuts_draw(cx);
}

#[gpui::test]
fn shortcuts_overlay_bindings_dismissal_and_typing(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("shortcuts.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    let before = cx.update(|window, cx| window.focused(cx));
    let start = Instant::now();
    cx.simulate_keystrokes("cmd-/");
    shortcuts_draw(cx);
    let open_ms = start.elapsed().as_secs_f64() * 1000.;
    assert!(
        cx.debug_bounds("keyboard-shortcuts").is_some(),
        "Cmd+/ must open the native overlay"
    );
    cx.simulate_keystrokes("tab");
    shortcuts_draw(cx);
    let list_focus = cx.update(|window, cx| window.focused(cx));
    cx.simulate_keystrokes("shift-tab");
    shortcuts_draw(cx);
    assert_ne!(
        list_focus,
        cx.update(|window, cx| window.focused(cx)),
        "Tab must stay inside the dialog"
    );
    let start = Instant::now();
    cx.simulate_keystrokes("escape");
    shortcuts_draw(cx);
    let interaction = start.elapsed().as_secs_f64() * 1000.;
    assert_eq!(
        before,
        cx.update(|window, cx| window.focused(cx)),
        "dismiss restores the original focus"
    );
    shortcuts_click(cx, "shortcuts-open");
    cx.simulate_keystrokes("enter");
    shortcuts_draw(cx);
    assert_eq!(
        before,
        cx.update(|window, cx| window.focused(cx)),
        "Enter activates the focused close button"
    );
    cx.simulate_keystrokes("?");
    shortcuts_draw(cx);
    shortcuts_click(cx, "shortcuts-close");
    cx.simulate_keystrokes("cmd-/");
    shortcuts_draw(cx);
    let bounds = cx.debug_bounds("shortcuts-list").unwrap();
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    shortcuts_draw(cx);
    cx.simulate_keystrokes("cmd-k");
    shortcuts_draw(cx);
    assert!(
        !shell.read_with(cx, |s, _| s.palette),
        "modal help blocks underlying command actions"
    );
    cx.simulate_click(point(px(2.), px(2.)), gpui::Modifiers::default());
    shortcuts_draw(cx);
    cx.simulate_keystrokes("cmd-k");
    shortcuts_draw(cx);
    assert!(shell.read_with(cx, |s, _| s.palette));
    cx.simulate_keystrokes("g r i d enter");
    ready(&shell, cx);
    assert_eq!(shell.read_with(cx, |s, _| s.active()), Some(Tab::Grid));
    cx.simulate_keystrokes("cmd-alt-left");
    shortcuts_draw(cx);
    assert!(matches!(
        shell.read_with(cx, |s, _| s.active()),
        Some(Tab::Session(_))
    ));
    cx.simulate_keystrokes("cmd-alt-right");
    shortcuts_draw(cx);
    assert_eq!(shell.read_with(cx, |s, _| s.active()), Some(Tab::Grid));
    cx.simulate_keystrokes("cmd-1");
    shortcuts_draw(cx);
    assert!(matches!(
        shell.read_with(cx, |s, _| s.active()),
        Some(Tab::Session(_))
    ));
    cx.simulate_keystrokes("cmd-9");
    shortcuts_draw(cx);
    assert!(
        matches!(
            shell.read_with(cx, |s, _| s.active()),
            Some(Tab::Session(_))
        ),
        "an absent tab number must preserve the current tab"
    );
    cx.simulate_keystrokes("cmd-2");
    shortcuts_draw(cx);
    assert_eq!(shell.read_with(cx, |s, _| s.active()), Some(Tab::Grid));
    cx.simulate_keystrokes("cmd-w");
    shortcuts_draw(cx);
    assert!(matches!(
        shell.read_with(cx, |s, _| s.active()),
        Some(Tab::Session(_))
    ));
    cx.simulate_keystrokes("cmd-k");
    cx.simulate_keystrokes("n e w enter");
    ready(&shell, cx);
    let composer = cx.update(|window, cx| window.focused(cx));
    let tabs = shell.read_with(cx, |s, _| s.current().unwrap().tabs.len());
    cx.simulate_keystrokes("cmd-w");
    shortcuts_draw(cx);
    assert_eq!(
        tabs,
        shell.read_with(cx, |s, _| s.current().unwrap().tabs.len()),
        "Cmd+W must preserve an editing tab"
    );
    cx.simulate_keystrokes("?");
    shortcuts_draw(cx);
    assert_eq!(
        composer,
        cx.update(|window, cx| window.focused(cx)),
        "? must keep editor focus while typing"
    );
    cx.simulate_keystrokes("cmd-/");
    shortcuts_draw(cx);
    assert_eq!(
        composer,
        cx.update(|window, cx| window.focused(cx)),
        "Cmd+/ must leave an editable target alone"
    );
    cx.simulate_keystrokes("escape");
    shortcuts_draw(cx);
    assert_eq!(composer, cx.update(|window, cx| window.focused(cx)));
    println!(
        "O8_NEXT_SHORTCUTS_EVIDENCE {}",
        json!({"endpoint":"headless GPUI CPU scene; no GPU/compositor","openToFirstFrameMs":open_ms,"interactionToFrameMs":interaction})
    );
}
