//! Settings mouse actions -> persisted selection -> production roster -> native rail.
use super::*;
use crate::shell::test_support::*;

fn settle(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    for _ in 0..10 {
        cx.run_until_parked();
        shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
        draw(cx);
    }
}
fn click(cx: &mut VisualTestContext, id: &'static str) {
    draw(cx);
    let bounds = cx
        .debug_bounds(id)
        .unwrap_or_else(|| panic!("missing {id}"));
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
}
fn open_settings(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    shell.update_in(cx, |s, window, cx| s.execute(Command::Settings, window, cx));
    settle(shell, cx);
    click(cx, "settings-nav-bots");
    settle(shell, cx);
}
fn roster(fixture: &Fixture) -> Value {
    let url = fixture.client.url("/api/bots").unwrap();
    fixture
        .client
        .request("GET", &url)
        .call()
        .unwrap()
        .into_json()
        .unwrap()
}
#[gpui::test]
fn bots_settings_setup_controls_rail_eligibility_and_survives_reopen(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--bot-settings");
    let file = fixture.root.join("bot-settings.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    settle(&shell, &mut visual);
    ready(&shell, &mut visual);
    assert!(
        visual.debug_bounds("rail-bot-grok:agent-1").is_none(),
        "mailbox discovery alone must not set up a rail bot"
    );
    assert_eq!(roster(&fixture)["bots"], json!([]));
    open_settings(&shell, &mut visual);
    click(&mut visual, "settings-bot-grok:agent-1");
    settle(&shell, &mut visual);
    assert!(shell.read_with(&visual, |s, cx| {
        let view = s.surfaces.settings.view.as_ref().unwrap().read(cx);
        assert!(view.error.is_none(), "{:?}", view.error);
        view.snapshot.as_ref().unwrap().values["botRailEnabledIds"] == json!(["grok:agent-1"])
    }));
    assert_eq!(roster(&fixture)["bots"][0]["id"], "grok:agent-1");
    click(&mut visual, "settings-close");
    settle(&shell, &mut visual);
    assert!(
        visual.debug_bounds("rail-bot-grok:agent-1").is_some(),
        "save invalidates the 30-second roster cache"
    );
    let saved = State::load(&file).unwrap();
    assert!(visual.simulate_close());
    let (reopened, mut next) = open(fixture.client.clone(), file, saved, &mut visual.cx);
    settle(&reopened, &mut next);
    ready(&reopened, &mut next);
    assert!(next.debug_bounds("rail-bot-grok:agent-1").is_some());
    let control = fixture.client.url("/__fixture/bots").unwrap();
    fixture
        .client
        .request("POST", &control)
        .send_json(json!({"rosterFailing":true}))
        .unwrap();
    open_settings(&reopened, &mut next);
    click(&mut next, "settings-bot-grok:agent-1");
    settle(&reopened, &mut next);
    click(&mut next, "settings-close");
    settle(&reopened, &mut next);
    assert!(next.debug_bounds("rail-bot-grok:agent-1").is_none());
    assert!(
        next.debug_bounds("rail-bots-retry").is_some(),
        "failed fetch remains visible"
    );
    fixture
        .client
        .request("POST", &control)
        .send_json(json!({"rosterFailing":false}))
        .unwrap();
    click(&mut next, "rail-bots-retry");
    settle(&reopened, &mut next);
    assert_eq!(roster(&fixture)["bots"], json!([]));
}

#[gpui::test]
fn bots_settings_save_invalidates_after_shortcut_closes_the_view(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--bot-settings");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("busy-close.json"),
        State::default(),
        cx,
    );
    settle(&shell, &mut visual);
    ready(&shell, &mut visual);
    open_settings(&shell, &mut visual);
    let control = fixture.client.url("/__fixture/settings").unwrap();
    fixture
        .client
        .request("POST", &control)
        .send_json(json!({"delayMs":200}))
        .unwrap();
    // Dispatch without the test helper's executor drain so the close really
    // happens while the production POST is delayed.
    draw(&mut visual);
    let position = visual
        .debug_bounds("settings-bot-grok:agent-1")
        .unwrap()
        .center();
    visual.simulate_event_without_wait(gpui::MouseDownEvent {
        position,
        button: gpui::MouseButton::Left,
        click_count: 1,
        ..Default::default()
    });
    visual.simulate_event_without_wait(gpui::MouseUpEvent {
        position,
        button: gpui::MouseButton::Left,
        click_count: 1,
        ..Default::default()
    });
    assert!(shell.read_with(&visual, |s, cx| {
        s.surfaces.settings.view.as_ref().unwrap().read(cx).busy
    }));
    visual.simulate_event_without_wait(gpui::KeyDownEvent {
        keystroke: gpui::Keystroke::parse("ctrl-w").unwrap(),
        is_held: false,
    });
    settle(&shell, &mut visual);
    assert!(shell.read_with(&visual, |s, _| s.surfaces.settings.view.is_none()));
    assert!(
        visual.debug_bounds("rail-bot-grok:agent-1").is_some(),
        "accepted save refreshes the rail after its view is dropped"
    );
    assert_eq!(roster(&fixture)["bots"][0]["id"], "grok:agent-1");
}

#[gpui::test]
fn bots_settings_second_choice_preserves_a_save_before_controls_repaint(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--bot-settings");
    let control = fixture.client.url("/__fixture/bots").unwrap();
    fixture
        .client
        .request("POST", &control)
        .send_json(json!({"bots":[
            {"id":"fixture:a","house":"fixture","name":"First"},
            {"id":"fixture:b","house":"fixture","name":"Second"}
        ]}))
        .unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("two-choices.json"),
        State::default(),
        cx,
    );
    settle(&shell, &mut visual);
    ready(&shell, &mut visual);
    open_settings(&shell, &mut visual);
    let second = visual
        .debug_bounds("settings-bot-fixture:b")
        .unwrap()
        .center();
    click(&mut visual, "settings-bot-fixture:a");
    // Complete readback without explicitly repainting the old row controls.
    for _ in 0..10 {
        visual.run_until_parked();
    }
    assert!(shell.read_with(&visual, |s, cx| {
        let settings = s.surfaces.settings.view.as_ref().unwrap().read(cx);
        !settings.busy
            && settings.snapshot.as_ref().unwrap().values["botRailEnabledIds"]
                == json!(["fixture:a"])
    }));
    visual.simulate_click(second, gpui::Modifiers::default());
    settle(&shell, &mut visual);
    assert_eq!(
        roster(&fixture)["bots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["fixture:a", "fixture:b"]
    );
}
