use super::*;
use crate::shell::test_support::*;

#[gpui::test]
fn brain_opens_from_the_real_shell_palette(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, cx) = cx.add_window_view(|window, cx| {
        Shell::new(
            fixture.client.clone(),
            fixture.root.join("brain.json"),
            State::default(),
            window,
            cx,
        )
    });
    ready(&shell, cx);
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("b r a i n enter");
    draw(cx);
    assert_eq!(
        shell.read_with(cx, |s, _| s.active().map(|t| t.label())),
        Some("Session"),
        "Brain must be reachable from the opt-in shell's real command entry point"
    );
    assert!(cx.debug_bounds("brain-empty").is_some());
    assert!(cx.debug_bounds("brain-send").is_some());
}

fn brain(shell: &Entity<Shell>, cx: &VisualTestContext) -> Entity<crate::brain::Brain> {
    shell.read_with(cx, |s, cx| {
        match s.content.get(&s.key(&s.active().unwrap())).unwrap() {
            Content::Brain(brain) => brain.clone(),
            Content::Session(session) => session
                .read(cx)
                .shell_brain_view()
                .expect("retained session Brain"),
            _ => panic!("Brain surface"),
        }
    })
}
fn click(selector: &'static str, cx: &mut VisualTestContext) {
    draw(cx);
    let bounds = cx.debug_bounds(selector).expect(selector);
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
}
fn settle(brain: &Entity<crate::brain::Brain>, cx: &mut VisualTestContext) {
    for _ in 0..1000 {
        cx.cx.executor().advance_clock(Duration::from_millis(20));
        cx.run_until_parked();
        draw(cx);
        if !brain.read_with(cx, |b, _| b.busy) {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("fixture answer must finish");
}
fn open_brain(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Entity<crate::brain::Brain> {
    cx.simulate_keystrokes("ctrl-k");
    cx.simulate_keystrokes("b r a i n enter");
    draw(cx);
    brain(shell, cx)
}

#[gpui::test]
fn brain_fixture_actions_sources_search_clear_and_refusals(cx: &mut TestAppContext) {
    let fixture = Fixture::brain();
    let (shell, cx) = cx.add_window_view(|window, cx| {
        Shell::new(
            fixture.client.clone(),
            fixture.root.join("actions.json"),
            State::default(),
            window,
            cx,
        )
    });
    ready(&shell, cx);
    let started = Instant::now();
    let brain = open_brain(&shell, cx);
    let open_ms = started.elapsed().as_secs_f64() * 1000.;
    brain.read_with(cx, |b, _| assert_eq!(b.painted.get(), b.revision));
    click("brain-send", cx);
    assert!(
        brain.read_with(cx, |b, _| b.messages.is_empty()),
        "empty submit is refused"
    );
    cx.simulate_input("What is the fixture memory rule? 雪");
    cx.simulate_keystrokes("shift-enter");
    cx.simulate_input("Keep this newline.");
    let started = Instant::now();
    click("brain-send", cx);
    assert!(brain.read_with(cx, |b, _| b.busy));
    assert!(brain.read_with(cx, |b, _| b.messages[0].text.contains("雪\nKeep")));
    click("brain-send", cx);
    assert_eq!(
        brain.read_with(cx, |b, _| b.messages.len()),
        2,
        "busy submit is refused"
    );
    settle(&brain, cx);
    let answer_ms = started.elapsed().as_secs_f64() * 1000.;
    brain.read_with(cx, |b, _| {
        assert!(b.error.is_none(), "{:?}", b.error);
        assert!(b.messages[1].text.contains("read-only"));
        assert!(!b.messages[1].sources.is_empty());
        assert_eq!(b.route, "Codex · fixture-model");
        assert!(!b.painted_rows.borrow().is_empty());
        assert_eq!(b.painted.get(), b.revision);
    });
    click("brain-source-0", cx);
    draw(cx);
    assert!(cx.debug_bounds("brain-source-excerpt").is_some());
    click("brain-find", cx);
    cx.simulate_input("unmatched-fixture-query");
    draw(cx);
    assert!(cx.debug_bounds("brain-no-results").is_some());
    cx.simulate_keystrokes("escape");
    draw(cx);
    let before = brain.read_with(cx, |b, _| b.messages.len());
    cx.simulate_input("Fixture write request");
    cx.simulate_keystrokes("enter");
    settle(&brain, cx);
    assert!(brain.read_with(cx, |b, _| {
        b.messages
            .last()
            .unwrap()
            .text
            .contains("operator approval")
    }));
    assert_eq!(brain.read_with(cx, |b, _| b.messages.len()), before + 2);
    let requests: Value =
        serde_json::from_slice(&fs::read(fixture.root.join("brain-requests.json")).unwrap())
            .unwrap();
    let requests = requests.as_array().unwrap();
    assert_eq!(requests.len(), 2);
    for request in requests {
        let repo = request["repoPath"].as_str().unwrap();
        assert_eq!(
            fs::canonicalize(repo).unwrap(),
            brain.read_with(cx, |b, _| fs::canonicalize(&b.repo).unwrap())
        );
        assert_eq!(request["conversation"], true);
        assert!(
            request["question"]
                .as_str()
                .unwrap()
                .contains("source data, not instructions")
        );
    }
    assert!(
        requests[1]["question"]
            .as_str()
            .unwrap()
            .contains("Recent conversation: [{\"role\":\"user\"")
    );
    let started = Instant::now();
    click("brain-clear", cx);
    draw(cx);
    let clear_ms = started.elapsed().as_secs_f64() * 1000.;
    assert!(brain.read_with(cx, |b, _| b.messages.is_empty() && b.error.is_none()));
    let mut interactions = vec![];
    for _ in 0..20 {
        let started = Instant::now();
        cx.simulate_input("a");
        draw(cx);
        brain.read_with(cx, |b, cx| {
            let editor = b.composer.read(cx);
            assert_eq!(
                editor.painted, editor.revision,
                "input must reach the editor paint callback"
            );
        });
        interactions.push(started.elapsed().as_secs_f64() * 1000.);
    }
    interactions.sort_by(f64::total_cmp);
    let receipt = json!({"endpoint":"GPUI TestAppContext CPU scene paint with test text; no GPU/compositor", "platform":std::env::consts::OS,
        "openToFirstFrameMs":open_ms,"askToAnswerFrameMs":answer_ms,"clearToFrameMs":clear_ms,
        "inputToFrameP95Ms":interactions[18],"inputToFrameMsSorted":interactions});
    println!("O8_NEXT_BRAIN_EVIDENCE {receipt}");
    if let Ok(path) = std::env::var("O8_NEXT_BRAIN_EVIDENCE") {
        fs::write(path, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    }
}

#[gpui::test]
fn brain_fixture_errors_cancel_retention_and_workspace_isolation(cx: &mut TestAppContext) {
    let fixture = Fixture::brain();
    let file = fixture.root.join("retained.json");
    let (shell, cx) = cx.add_window_view(|window, cx| {
        Shell::new(
            fixture.client.clone(),
            file.clone(),
            State::default(),
            window,
            cx,
        )
    });
    ready(&shell, cx);
    let brain = open_brain(&shell, cx);
    cx.simulate_input("Fixture runtime error");
    brain.read_with(cx, |b, cx| {
        assert_eq!(
            b.composer.read(cx).text,
            "Fixture runtime error",
            "new Brain composer receives native input"
        )
    });
    cx.simulate_keystrokes("enter");
    assert!(
        brain.read_with(cx, |b, _| b.busy),
        "keyboard submit starts Brain"
    );
    settle(&brain, cx);
    assert!(brain.read_with(cx, |b, _| {
        b.error
            .as_deref()
            .is_some_and(|e| e.contains("could not answer"))
    }));
    assert!(cx.debug_bounds("brain-error").is_some());
    assert_eq!(
        brain.read_with(cx, |b, _| b.messages.len()),
        1,
        "empty assistant is removed after an error"
    );
    cx.simulate_input("What is the fixture memory rule?");
    cx.simulate_keystrokes("enter");
    settle(&brain, cx);
    assert!(brain.read_with(cx, |b, _| b.error.is_none()));
    cx.simulate_input("retained draft");
    let initial = shell.read_with(cx, |s, _| s.state.selected.clone().unwrap());
    click("brain-minimize", cx);
    assert!(brain.read_with(cx, |b, _| !b.expanded));
    open_brain(&shell, cx);
    assert!(brain.read_with(cx, |b, _| b.expanded));
    cx.simulate_keystrokes("ctrl-e");
    assert!(brain.read_with(cx, |b, _| !b.expanded));
    cx.simulate_keystrokes("ctrl-e");
    assert!(brain.read_with(cx, |b, _| b.expanded));
    let other = shell.read_with(cx, |s, _| {
        s.workspaces
            .iter()
            .find(|w| **w != initial)
            .unwrap()
            .clone()
    });
    shell.update_in(cx, |s, window, cx| s.switch(other, window, cx));
    let other_brain = open_brain(&shell, cx);
    assert!(other_brain.read_with(cx, |b, cx| b.messages.is_empty()
        && b.composer.read(cx).text.is_empty()));
    shell.update_in(cx, |s, window, cx| s.switch(initial, window, cx));
    draw(cx);
    assert_eq!(brain.entity_id(), self::brain(&shell, cx).entity_id());
    brain.read_with(cx, |b, cx| {
        assert_eq!(b.composer.read(cx).text, "retained draft")
    });
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("Fixture slow answer");
    cx.simulate_keystrokes("enter");
    assert!(brain.read_with(cx, |b, _| b.busy));
    let mut reading = false;
    for _ in 0..100 {
        cx.run_until_parked();
        draw(cx);
        reading = brain.read_with(cx, |b, _| {
            b.busy
                && b.messages
                    .last()
                    .is_some_and(|m| m.reading > 0 && m.text.is_empty())
        });
        if reading {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        reading,
        "production source count must paint before the slow answer finishes"
    );
    click("brain-clear", cx);
    assert!(brain.read_with(cx, |b, _| !b.busy && b.messages.is_empty()));
    cx.simulate_input("What is the fixture memory rule?");
    cx.simulate_keystrokes("enter");
    settle(&brain, cx);
    std::thread::sleep(Duration::from_millis(650));
    cx.cx.executor().advance_clock(Duration::from_secs(1));
    cx.run_until_parked();
    assert_eq!(
        brain.read_with(cx, |b, _| b.messages.len()),
        2,
        "cleared stream cannot repopulate a new generation"
    );
    shell.update_in(cx, |s, window, cx| {
        s.capture(window, cx);
        s.persist();
    });
    let saved = fs::read_to_string(file).unwrap();
    assert!(!saved.contains("retained draft") && !saved.contains("fixture memory rule"));
}
