//! Production GPUI shell -> bot HTTP routes -> persisted tabs/native sessions.
use super::*;
use crate::shell::test_support::*;

fn configure(fixture: &Fixture, body: Value) {
    let url = fixture.client.url("/__fixture/bots").unwrap();
    assert_eq!(
        fixture
            .client
            .request("POST", &url)
            .send_json(body)
            .unwrap()
            .status(),
        200
    );
}

fn native(id: &str, thread: &str) -> Value {
    json!({"id":id,"name":id,"house":"o8","mainThread":{"kind":"o8-thread","id":thread},"status":"online"})
}

fn settle(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    for _ in 0..6 {
        cx.run_until_parked();
        shell.update_in(cx, |s, window, cx| s.tick(true, window, cx));
        draw(cx);
    }
}

fn bounds(cx: &mut VisualTestContext, id: &str) -> gpui::Bounds<gpui::Pixels> {
    cx.debug_bounds(Box::leak(id.to_owned().into_boxed_str()))
        .unwrap_or_else(|| panic!("missing {id}"))
}

fn click(cx: &mut VisualTestContext, id: &str) {
    draw(cx);
    let at = bounds(cx, id).center();
    cx.simulate_click(at, gpui::Modifiers::default());
}

fn selected(shell: &Entity<Shell>, cx: &VisualTestContext) -> (String, gpui::EntityId) {
    shell.read_with(cx, |s, cx| {
        let tab = s.active().expect("active native thread");
        let Some(Content::Session(view)) = s.content.get(&s.key(&tab)) else {
            panic!("bot must open the real native session, got {tab:?}");
        };
        (view.read(cx).shell_selected(), view.entity_id())
    })
}

#[gpui::test]
fn bots_rail_no_bot_fixed_navigation_baseline(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("no-bot-geometry.json"),
        State::default(),
        cx,
    );
    settle(&shell, &mut visual);
    ready(&shell, &mut visual);
    assert!(visual.debug_bounds("rail-bots").is_none());
    for height in [400., 480., 520., 816.] {
        visual.simulate_resize(size(px(800.), px(height)));
        draw(&mut visual);
        let prs = bounds(&mut visual, "rail-pull-requests");
        let gauge = bounds(&mut visual, "rail-usage");
        let profile = bounds(&mut visual, "shell-profile");
        println!("NO_BOT_BASELINE height={height} prs={prs:?} gauge={gauge:?} profile={profile:?}");
        assert!(
            visual.debug_bounds("rail-destinations").is_none(),
            "original destinations have no new viewport"
        );
    }
}

#[gpui::test]
fn bots_without_a_workspace_open_by_click_and_restore(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--shell --bots --inbox-empty");
    let file = fixture.root.join("global-bot.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    settle(&shell, &mut visual);
    assert!(shell.read_with(&visual, |s, _| s.connected && s.state.selected.is_none()));
    click(&mut visual, "rail-bot-grok:agent-1");
    settle(&shell, &mut visual);
    ready(&shell, &mut visual);
    assert_eq!(
        shell.read_with(&visual, |s, _| s.active()),
        Some(Tab::Bot("grok:agent-1".into()))
    );
    let saved = State::load(&file).unwrap();
    assert!(saved.selected.is_none());
    assert_eq!(
        saved.workspaces[""].tabs,
        vec![Tab::Bot("grok:agent-1".into())]
    );
    assert!(visual.simulate_close());
    let (restored, mut next) = open(fixture.client.clone(), file, saved, &mut visual.cx);
    settle(&restored, &mut next);
    ready(&restored, &mut next);
    assert_eq!(
        restored.read_with(&next, |s, _| s.active()),
        Some(Tab::Bot("grok:agent-1".into()))
    );
    assert!(restored.read_with(&next, |s, _| s.state.selected.is_none()));
    assert!(
        next.debug_bounds("bot-thread").is_some(),
        "restored bot must paint: {:?}",
        restored.read_with(&next, |s, _| (
            s.connected,
            s.loading,
            s.notice.clone(),
            s.surfaces.projects.open,
            s.surfaces.settings.view.is_some(),
            s.surfaces.setup.view.is_some(),
            s.state.bounds,
            s.state.right_panel.visible,
            s.state.right_panel.primary.clone(),
        ))
    );
}

#[gpui::test]
fn bots_shell_rail_bounds_large_rosters_and_keeps_the_footer_clickable(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--bots");
    for count in [20, 100] {
        configure(&fixture, json!({"bots":[]}));
        let (shell, mut visual) = open(
            fixture.client.clone(),
            fixture.root.join(format!("rail-{count}.json")),
            State::default(),
            cx,
        );
        settle(&shell, &mut visual);
        ready(&shell, &mut visual);
        for height in [400., 480., 520., 540., 628., 816.] {
            configure(&fixture, json!({"bots":[]}));
            shell.update(&mut visual, |s, _| s.surfaces.bots.fetched = None);
            settle(&shell, &mut visual);
            visual.simulate_resize(size(px(800.), px(height)));
            draw(&mut visual);
            let baseline_prs = bounds(&mut visual, "rail-pull-requests");
            let baseline_gauge = bounds(&mut visual, "rail-usage");
            let baseline_footer = bounds(&mut visual, "shell-profile");
            configure(
                &fixture,
                json!({"bots":(0..count).map(|n| json!({
                "id":format!("fixture:{n}"),"house":"fixture","name":format!("Bot {n}"),
                "mainThread":{"kind":"mailbox","id":"agent-1"}
            })).collect::<Vec<_>>()}),
            );
            shell.update(&mut visual, |s, _| s.surfaces.bots.fetched = None);
            settle(&shell, &mut visual);
            assert_eq!(
                shell.read_with(&visual, |s, _| s.surfaces.bots.entries.len()),
                count
            );
            assert!(visual.debug_bounds("rail-destinations").is_none());
            let prs = bounds(&mut visual, "rail-pull-requests");
            let footer = bounds(&mut visual, "shell-profile");
            let gauge = bounds(&mut visual, "rail-usage");
            assert_eq!(prs, baseline_prs, "bots do not move the existing PR target");
            assert_eq!(
                gauge, baseline_gauge,
                "bots consume only the existing spacer"
            );
            assert_eq!(
                footer, baseline_footer,
                "bots add no footer overflow, including below feasible heights"
            );
            let Some(bots) = visual
                .debug_bounds("rail-bots")
                .filter(|b| b.size.height >= px(44.))
            else {
                assert!(
                    height < 628.,
                    "a complete bot row fits at feasible short heights"
                );
                continue;
            };
            assert!(bots.top() >= prs.bottom() && bots.top() - prs.bottom() < px(4.));
            assert!(
                bots.bottom() <= gauge.top(),
                "bots leave the footer reachable"
            );
            assert!(footer.bottom() <= px(height) && gauge.bottom() <= px(height));
            visual.simulate_event(gpui::ScrollWheelEvent {
                position: bots.center(),
                delta: gpui::ScrollDelta::Pixels(point(px(0.), px(-100_000.))),
                modifiers: Default::default(),
                touch_phase: gpui::TouchPhase::Moved,
            });
            draw(&mut visual);
            let last = bounds(&mut visual, &format!("rail-bot-fixture:{}", count - 1));
            assert!(
                bots.contains(&last.center()),
                "the last bot is reachable by scrolling"
            );
            let bottom = shell.read_with(&visual, |s, _| s.surfaces.bots.scroll.offset());
            visual.simulate_event(gpui::ScrollWheelEvent {
                position: bots.center(),
                delta: gpui::ScrollDelta::Pixels(point(px(0.), px(88.))),
                modifiers: Default::default(),
                touch_phase: gpui::TouchPhase::Moved,
            });
            draw(&mut visual);
            assert_eq!(
                bounds(&mut visual, "rail-bots"),
                bots,
                "inner upward scrolling cannot move its viewport"
            );
            assert!(shell.read_with(&visual, |s, _| s.surfaces.bots.scroll.offset().y > bottom.y));
            assert_eq!(bounds(&mut visual, "shell-profile"), footer);
            visual.simulate_event(gpui::ScrollWheelEvent {
                position: bots.center(),
                delta: gpui::ScrollDelta::Pixels(point(px(0.), px(-100_000.))),
                modifiers: Default::default(),
                touch_phase: gpui::TouchPhase::Moved,
            });
            draw(&mut visual);
            let last = bounds(&mut visual, &format!("rail-bot-fixture:{}", count - 1));
            visual.simulate_click(last.center(), gpui::Modifiers::default());
            settle(&shell, &mut visual);
            assert_eq!(
                shell.read_with(&visual, |s, _| s.active()),
                Some(Tab::Bot(format!("fixture:{}", count - 1)))
            );
            click(&mut visual, "shell-profile");
            draw(&mut visual);
            assert!(
                visual.debug_bounds("profile-settings").is_some(),
                "footer still accepts clicks"
            );
            visual.simulate_keystrokes("escape");
        }
        assert!(visual.simulate_close());
    }
}

#[gpui::test]
fn bots_rosters_and_fetch_failures_are_window_scoped(cx: &mut TestAppContext) {
    let first = Fixture::start_mode(false, "--bots");
    let second = Fixture::start_mode(false, "--bots");
    configure(
        &first,
        json!({"bots":[native("o8:first", "thoughts-absent")]}),
    );
    configure(
        &second,
        json!({"bots":[native("o8:second", "thoughts-absent")]}),
    );
    let (a, mut av) = open(
        first.client.clone(),
        first.root.join("a.json"),
        State::default(),
        cx,
    );
    let (b, mut bv) = open(
        second.client.clone(),
        second.root.join("b.json"),
        State::default(),
        cx,
    );
    settle(&a, &mut av);
    settle(&b, &mut bv);
    assert!(av.debug_bounds("rail-bot-o8:first").is_some());
    assert!(av.debug_bounds("rail-bot-o8:second").is_none());
    assert!(bv.debug_bounds("rail-bot-o8:second").is_some());
    assert!(
        bv.debug_bounds("rail-bot-status-o8:second-online")
            .is_some()
    );
    configure(&first, json!({"rosterFailing":true}));
    a.update(&mut av, |s, _| s.surfaces.bots.fetched = None);
    settle(&a, &mut av);
    assert!(av.debug_bounds("rail-bots-retry").is_some());
    assert!(
        av.debug_bounds("rail-bot-o8:first").is_some(),
        "retain the last known entry"
    );
    assert!(
        av.debug_bounds("rail-bot-status-o8:first-online").is_none(),
        "failed fetches cannot retain a green status"
    );
    draw(&mut bv);
    assert!(bv.debug_bounds("rail-bots-retry").is_none());
    assert!(
        bv.debug_bounds("rail-bot-status-o8:second-online")
            .is_some()
    );
    configure(&first, json!({"rosterFailing":false}));
    click(&mut av, "rail-bots-retry");
    settle(&a, &mut av);
    assert!(av.debug_bounds("rail-bots-retry").is_none());
    assert!(av.debug_bounds("rail-bot-status-o8:first-online").is_some());
}

#[gpui::test]
fn bots_native_thread_route_reuses_sessions_and_switches_workspace(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--bots");
    let sessions = fixture.client.sidebar_sessions().unwrap();
    let first = sessions
        .iter()
        .find(|s| s.id == "thoughts-composer-first")
        .unwrap();
    let second = sessions
        .iter()
        .find(|s| s.id == "thoughts-composer-second")
        .unwrap();
    let cross = sessions
        .iter()
        .find(|s| s.repo_path != first.repo_path)
        .unwrap();
    configure(
        &fixture,
        json!({"bots":[native("o8:local", &second.id), native("o8:cross", &cross.id)]}),
    );
    let file = fixture.root.join("native-bots.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    settle(&shell, &mut visual);
    ready(&shell, &mut visual);
    shell.update_in(&mut visual, |s, window, cx| {
        s.execute(Command::Session(first.id.clone()), window, cx)
    });
    ready(&shell, &mut visual);
    let original = selected(&shell, &visual).1;
    // Command dispatch is the rail's production entry point, also used by restored Bot tabs.
    shell.update_in(&mut visual, |s, window, cx| {
        s.execute(Command::Bot("o8:local".into()), window, cx)
    });
    settle(&shell, &mut visual);
    ready(&shell, &mut visual);
    assert_eq!(
        selected(&shell, &visual),
        (second.id.clone(), original),
        "reuse the existing native session surface"
    );
    assert_eq!(
        shell.read_with(&visual, |s, _| s.active()),
        Some(Tab::Session(first.id.clone()))
    );
    click(&mut visual, "rail-bot-o8:cross");
    settle(&shell, &mut visual);
    ready(&shell, &mut visual);
    assert_eq!(
        shell.read_with(&visual, |s, _| s.state.selected.clone()),
        cross.repo_path
    );
    assert_eq!(selected(&shell, &visual).0, cross.id);
    assert!(!shell.read_with(&visual, |s, _| {
        s.content.values().any(|c| matches!(c, Content::Bot(_)))
    }));
    let saved = State::load(&file).unwrap();
    assert_eq!(saved.selected, cross.repo_path);
    assert!(visual.simulate_close());
    let (restored, mut next) = open(fixture.client.clone(), file, saved, &mut visual.cx);
    settle(&restored, &mut next);
    ready(&restored, &mut next);
    assert_eq!(selected(&restored, &next).0, cross.id);
}

#[gpui::test]
fn bots_missing_native_targets_and_unknown_persisted_ids_are_explicit(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--bots");
    configure(
        &fixture,
        json!({"bots":[native("o8:missing", "thoughts-absent")]}),
    );
    let file = fixture.root.join("missing-bot.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    settle(&shell, &mut visual);
    ready(&shell, &mut visual);
    shell.update_in(&mut visual, |s, window, cx| {
        s.execute(Command::Bot("o8:missing".into()), window, cx)
    });
    settle(&shell, &mut visual);
    ready(&shell, &mut visual);
    assert!(visual.debug_bounds("bot-native-unavailable").is_some());
    assert_eq!(
        shell.read_with(&visual, |s, _| s.active()),
        Some(Tab::Bot("o8:missing".into()))
    );
    shell.update_in(&mut visual, |s, window, cx| {
        s.execute(Command::Bot("deleted:bot".into()), window, cx)
    });
    settle(&shell, &mut visual);
    ready(&shell, &mut visual);
    assert!(visual.debug_bounds("bot-thread-error").is_some());
    let saved = State::load(&file).unwrap();
    assert!(visual.simulate_close());
    let (restored, mut next) = open(fixture.client.clone(), file, saved, &mut visual.cx);
    settle(&restored, &mut next);
    ready(&restored, &mut next);
    assert_eq!(
        restored.read_with(&next, |s, _| s.active()),
        Some(Tab::Bot("deleted:bot".into()))
    );
    assert!(next.debug_bounds("bot-thread-error").is_some());
}

// Content readiness does not imply that an asynchronous catalog read finished.
// Pump production maintenance until the requested catalog condition is true.
fn hydrate_late_catalog(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        cx.run_until_parked();
        if shell.read_with(cx, |s, _| {
            s.sessions.iter().any(|v| v.id == "thoughts-bots-late")
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "late native target must hydrate into the catalog"
        );
        shell.update_in(cx, |s, window, cx| s.tick(true, window, cx));
        draw(cx);
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[gpui::test]
fn bots_restored_native_target_opens_after_catalog_hydration(cx: &mut TestAppContext) {
    restored_native_target(cx, true);
}

#[gpui::test]
fn bots_restored_native_target_opens_when_catalog_finishes_after_home(cx: &mut TestAppContext) {
    restored_native_target(cx, false);
}

fn restored_native_target(cx: &mut TestAppContext, hydrate_before_home: bool) {
    let fixture = Fixture::start_mode(false, "--bots --settings");
    let sessions = fixture.client.sidebar_sessions().unwrap();
    let target_workspace = sessions
        .iter()
        .find(|s| s.id == "thoughts-composer-first")
        .unwrap()
        .repo_path
        .clone()
        .unwrap();
    let source_workspace = sessions
        .iter()
        .find(|s| s.repo_path.as_ref() != Some(&target_workspace))
        .unwrap()
        .repo_path
        .clone()
        .unwrap();
    configure(
        &fixture,
        json!({"bots":[native("o8:late", "thoughts-bots-late")]}),
    );
    let file = fixture.root.join("late-bot.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    settle(&shell, &mut visual);
    ready(&shell, &mut visual);
    shell.update_in(&mut visual, |s, window, cx| {
        s.switch(source_workspace.clone(), window, cx)
    });
    shell.update_in(&mut visual, |s, window, cx| {
        s.execute(Command::Bot("o8:late".into()), window, cx)
    });
    settle(&shell, &mut visual);
    ready(&shell, &mut visual);
    assert!(visual.debug_bounds("bot-native-unavailable").is_some());
    let saved = State::load(&file).unwrap();
    assert!(visual.simulate_close());
    let (restored, mut next) = open(fixture.client.clone(), file, saved, &mut visual.cx);
    settle(&restored, &mut next);
    ready(&restored, &mut next);
    assert!(next.debug_bounds("bot-native-unavailable").is_some());
    restored.update_in(&mut next, |s, window, cx| {
        s.execute(Command::Settings, window, cx)
    });
    settle(&restored, &mut next);
    assert!(restored.read_with(&next, |s, _| s.surfaces.settings.view.is_some()));
    if hydrate_before_home {
        configure(&fixture, json!({"addNativeThread":true}));
        restored.update(&mut next, |s, cx| s.load(cx));
        hydrate_late_catalog(&restored, &mut next);
    } else {
        assert!(!restored.read_with(&next, |s, _| {
            s.sessions.iter().any(|v| v.id == "thoughts-bots-late")
        }));
    }
    assert!(
        restored.read_with(&next, |s, _| s.surfaces.settings.view.is_some()),
        "late targets cannot dismiss Settings"
    );
    assert_eq!(
        restored.read_with(&next, |s, _| s.active()),
        Some(Tab::Bot("o8:late".into()))
    );
    click(&mut next, "shell-home");
    assert!(!restored.read_with(&next, |s, _| s.surfaces.settings.view.is_some()));
    if !hydrate_before_home {
        // The target cannot arrive during the Home click: it does not exist yet.
        configure(&fixture, json!({"addNativeThread":true}));
        restored.update(&mut next, |s, cx| s.load(cx));
    }
    hydrate_late_catalog(&restored, &mut next);
    settle(&restored, &mut next);
    ready(&restored, &mut next);
    assert_eq!(selected(&restored, &next).0, "thoughts-bots-late");
    assert_eq!(
        restored.read_with(&next, |s, _| s.state.selected.clone()),
        Some(target_workspace)
    );
    assert!(
        !restored.read_with(&next, |s, _| s
            .state
            .workspaces
            .values()
            .any(|w| w.tabs.contains(&Tab::Bot("o8:late".into())))),
        "resolved placeholders are consumed in persisted state"
    );
    assert!(!restored.read_with(&next, |s, _| {
        s.content.values().any(|c| matches!(c, Content::Bot(_)))
    }));
    next.simulate_keystrokes("ctrl-w");
    settle(&restored, &mut next);
    assert_ne!(
        restored.read_with(&next, |s, _| s.active()),
        Some(Tab::Session("thoughts-bots-late".into()))
    );
    restored.update_in(&mut next, |s, window, cx| {
        s.switch(source_workspace.clone(), window, cx)
    });
    settle(&restored, &mut next);
    assert_eq!(
        restored.read_with(&next, |s, _| s.state.selected.clone()),
        Some(source_workspace),
        "returning to the source workspace cannot redirect again"
    );
}

#[gpui::test]
fn bots_resolved_click_retires_placeholders_in_other_workspaces(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--bots");
    let sessions = fixture.client.sidebar_sessions().unwrap();
    let a = sessions
        .iter()
        .find(|s| s.id == "thoughts-composer-first")
        .unwrap()
        .repo_path
        .clone()
        .unwrap();
    let b = sessions
        .iter()
        .find(|s| s.repo_path.as_ref() != Some(&a))
        .unwrap()
        .repo_path
        .clone()
        .unwrap();
    configure(
        &fixture,
        json!({"bots":[native("o8:late", "thoughts-bots-late")]}),
    );
    let file = fixture.root.join("other-workspace.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    settle(&shell, &mut visual);
    ready(&shell, &mut visual);
    shell.update_in(&mut visual, |s, window, cx| {
        s.switch(a.clone(), window, cx);
        s.execute(Command::Bot("o8:late".into()), window, cx);
    });
    settle(&shell, &mut visual);
    assert!(visual.debug_bounds("bot-native-unavailable").is_some());
    shell.update_in(&mut visual, |s, window, cx| s.switch(b.clone(), window, cx));
    configure(&fixture, json!({"addNativeThread":true}));
    shell.update(&mut visual, |s, cx| s.load(cx));
    settle(&shell, &mut visual);
    assert_eq!(
        shell.read_with(&visual, |s, _| s.state.selected.clone()),
        Some(b.clone()),
        "hidden placeholders cannot redirect"
    );
    click(&mut visual, "rail-bot-o8:late");
    settle(&shell, &mut visual);
    ready(&shell, &mut visual);
    assert_eq!(selected(&shell, &visual).0, "thoughts-bots-late");
    let saved = State::load(&file).unwrap();
    assert!(
        saved
            .workspaces
            .values()
            .all(|w| !w.tabs.contains(&Tab::Bot("o8:late".into())))
    );
    assert!(!shell.read_with(&visual, |s, _| {
        s.content.values().any(|c| matches!(c, Content::Bot(_)))
    }));
    visual.simulate_keystrokes("ctrl-w");
    settle(&shell, &mut visual);
    let after_close = shell.read_with(&visual, |s, _| s.active());
    settle(&shell, &mut visual);
    assert_eq!(
        shell.read_with(&visual, |s, _| s.active()),
        after_close,
        "closing cannot reopen an old placeholder"
    );
    shell.update_in(&mut visual, |s, window, cx| s.switch(b.clone(), window, cx));
    settle(&shell, &mut visual);
    shell.update_in(&mut visual, |s, window, cx| s.switch(a.clone(), window, cx));
    settle(&shell, &mut visual);
    assert_eq!(shell.read_with(&visual, |s, _| s.active()), after_close);
}
