use super::*;
use crate::shell::{test_support::*, *};

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    draw(cx);
    let bounds = cx.debug_bounds(selector).expect(selector);
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    draw(cx);
}

#[gpui::test]
fn onboarding_module_owns_busy_navigation_and_does_not_reopen_after_close(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--onboarding --transcript");
    let (shell, mut visual) = open(fixture.client.clone(), fixture.root.join("module-lifecycle.json"), State::default(), cx);
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    let setup = shell.read_with(cx, |s, _| s.surfaces.setup.view.clone().unwrap());
    // Hold the view at its in-flight state: the public GPUI input helpers drain
    // blocking HTTP tasks before returning. Normal saves run in the other cases.
    setup.update(cx, |s, cx| {
        s.busy = true;
        s.step = Step::Tools;
        let rows = s.snapshot.as_mut().unwrap().setup["dispatchableRuntimes"].as_array_mut().unwrap();
        for index in 0..100 {
            rows.push(serde_json::json!({"id":format!("fixture-tool-{index}"),"label":"Fixture coding tool","available":true}));
        }
        cx.notify();
    });
    draw(cx);
    // Settings lives in the rail's profile menu, as in the desktop rail.
    click(cx, "shell-profile");
    click(cx, "profile-settings");
    assert!(shell.read_with(cx, |s, _| s.surfaces.settings.view.is_none()), "busy setup must intercept shell navigation without a registry veto");
    for chord in ["ctrl-k", "cmd-k", "ctrl-shift-p", "cmd-shift-p"] {
        cx.simulate_keystrokes(chord);
        assert!(!shell.read_with(cx, |s, _| s.palette), "busy setup must block palette navigation: {chord}");
    }
    click(cx, "setup-close");
    assert!(shell.read_with(cx, |s, _| s.surfaces.setup.view.is_some()));
    setup.update(cx, |s, cx| { s.busy = false; cx.notify(); });
    click(cx, "setup-close");
    assert!(shell.read_with(cx, |s, _| s.surfaces.setup.view.is_none()));
    shell.update(cx, |s, cx| s.load(cx));
    cx.run_until_parked();
    draw(cx);
    assert!(shell.read_with(cx, |s, _| s.surfaces.setup.view.is_none()), "closing setup is retained for this shell lifetime");
    // Settings lives in the rail's profile menu, as in the desktop rail.
    click(cx, "shell-profile");
    click(cx, "profile-settings");
    assert!(shell.read_with(cx, |s, _| s.surfaces.settings.view.is_some()), "idle navigation remains available");
    cx.simulate_keystrokes("ctrl-shift-p");
    assert!(shell.read_with(cx, |s, _| s.palette), "idle global palette navigation remains available");
}
