use super::*;
use gpui::Entity;
pub(super) fn focus(surface: &Entity<Surface>, cx: &mut VisualTestContext) {
    surface.update_in(cx, |s, w, cx| s.composer.read(cx).focus.focus(w));
}
pub(super) fn wait(
    surface: &Entity<Surface>,
    cx: &mut VisualTestContext,
    ready: impl Fn(&Surface, &App) -> bool,
) {
    for _ in 0..250 {
        cx.run_until_parked();
        if surface.read_with(cx, |s, cx| ready(s, cx)) {
            draw(cx);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    panic!("composer control never became ready");
}
pub(super) fn wait_selector(cx: &mut VisualTestContext, selector: &'static str) {
    for _ in 0..250 {
        cx.run_until_parked();
        draw(cx);
        if cx.debug_bounds(selector).is_some() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    panic!("Missing composer control {selector}");
}
#[gpui::test]
fn native_composer_controls_slash_opens_arrows_and_enter_apply(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    focus(&surface, cx);
    cx.simulate_input("/");
    draw(cx);
    assert!(cx.debug_bounds("composer-slash-menu").is_some());
    cx.simulate_keystrokes("down enter");
    cx.run_until_parked();
    draw(cx);
    assert_eq!(
        surface.read_with(cx, |s, cx| s.composer.read(cx).text.clone()),
        "/orchestrate "
    );
    surface.read_with(cx, |s, _| {
        assert!(
            s.queue["items"].as_array().unwrap().is_empty(),
            "completion never sends"
        )
    });
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("/vis");
    cx.simulate_keystrokes("enter");
    assert_eq!(
        surface.read_with(cx, |s, cx| s.composer.read(cx).text.clone()),
        "/visualization "
    );
}
#[gpui::test]
fn native_composer_controls_slash_escape_waits_for_an_edit(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    focus(&surface, cx);
    cx.simulate_input("/");
    draw(cx);
    assert!(cx.debug_bounds("composer-slash-menu").is_some());
    cx.simulate_keystrokes("escape");
    draw(cx);
    assert!(cx.debug_bounds("composer-slash-menu").is_none());
    cx.simulate_resize(size(px(980.), px(720.)));
    draw(cx);
    assert!(cx.debug_bounds("composer-slash-menu").is_none());
    assert_eq!(
        surface.read_with(cx, |s, cx| s.composer.read(cx).text.clone()),
        "/"
    );
    cx.simulate_input("v");
    draw(cx);
    assert!(cx.debug_bounds("slash-visualization").is_some());
    assert!(cx.debug_bounds("slash-clear").is_none());
}
#[gpui::test]
fn native_composer_controls_mode_arrows_change_the_next_real_send(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    click("send-mode-steer", cx);
    click("composer-attach", cx);
    click("attach-mode", cx);
    cx.simulate_keystrokes("down enter");
    cx.run_until_parked();
    focus(&surface, cx);
    cx.simulate_input("Keyboard selected mode");
    cx.simulate_keystrokes("enter");
    wait(&surface, cx, |s, _| {
        !s.saving && s.queue["items"].as_array().is_some_and(|i| !i.is_empty())
    });
    surface.read_with(cx, |s, _| {
        let payload = &s.queue["items"][0]["payload"];
        // Shared is the default; Down moves to Worktrees, the only other mode.
        assert_eq!(payload["routing"]["pickedMode"], "multitask");
        assert_eq!(payload["routing"]["mode"], "fleet");
        assert!(
            payload["wireMessage"]
                .as_str()
                .unwrap()
                .starts_with("[Mode: Multitask]"),
            "actual payload: {payload}"
        );
    });
}
#[gpui::test]
fn native_composer_controls_intent_chips_apply_without_sending(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    focus(&surface, cx);
    assert!(cx.debug_bounds("attach-repo").is_none());
    click("send-mode-steer", cx);
    focus(&surface, cx);
    cx.simulate_input("Check this change");
    draw(cx);
    click("composer-attach", cx);
    click("attach-repo", cx);
    wait_selector(cx, "composer-prompt-item-0");
    click("composer-prompt-item-0", cx);
    click("composer-attach", cx);
    click("attach-branch", cx);
    wait_selector(cx, "composer-prompt-item-0");
    // Filter real branches through the real search editor, then choose it.
    click("composer-command-query", cx);
    cx.simulate_input("feature/composer");
    draw(cx);
    click("composer-prompt-item-0", cx);
    surface.read_with(cx, |s, cx| {
        assert_eq!(s.composer.read(cx).text, "Check this change");
        assert!(s.queue["items"].as_array().unwrap().is_empty());
    });
    focus(&surface, cx);
    cx.simulate_keystrokes("enter");
    wait(&surface, cx, |s, _| {
        !s.saving && s.queue["items"].as_array().is_some_and(|i| !i.is_empty())
    });
    surface.read_with(cx, |s, _| {
        let payload = &s.queue["items"][0]["payload"];
        assert_eq!(payload["text"], "Check this change");
        assert!(
            payload["wireMessage"]
                .as_str()
                .unwrap()
                .contains("base branch feature/composer")
        );
    });
}
#[gpui::test]
fn native_composer_controls_quick_action_and_prompt_insert_without_send(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let (surface, cx) = open(cx, &fixture);
    focus(&surface, cx);
    cx.simulate_keystrokes("ctrl-shift-k");
    cx.run_until_parked();
    draw(cx);
    click("composer-command-query", cx);
    cx.simulate_input("decompose");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    draw(cx);
    let template = surface.read_with(cx, |s, cx| s.composer.read(cx).text.clone());
    assert!(template.starts_with("Decompose the following issue"));
    focus(&surface, cx);
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("Replace this");
    cx.simulate_keystrokes("ctrl-a");
    click("composer-attach", cx);
    click("attach-browse-prompts", cx);
    wait_selector(cx, "composer-prompt-item-0");
    click("composer-prompt-item-0", cx);
    surface.read_with(cx, |s, cx| {
        assert_eq!(
            s.composer.read(cx).text,
            "Review the patch and report the checks."
        );
        assert!(s.queue["items"].as_array().unwrap().is_empty());
    });
}
