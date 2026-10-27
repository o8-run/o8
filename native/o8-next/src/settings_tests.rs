//! Real keyboard/mouse -> shell -> GPUI settings -> production HTTP -> persisted store.
use super::*;
use crate::shell::test_support::*;
use gpui::Modifiers;

fn click(cx: &mut VisualTestContext, selector: &str) {
    draw(cx);
    let selector: &'static str = Box::leak(selector.to_owned().into_boxed_str());
    if selector.starts_with("key-")
        || selector.starts_with("setting-")
        || selector.starts_with("edit-")
        || selector.starts_with("settings-confirm-")
        || selector == "settings-cancel-remove"
    {
        for _ in 0..20 {
            let target = cx
                .debug_bounds(selector)
                .unwrap_or_else(|| panic!("missing native control: {selector}"));
            let viewport = cx
                .debug_bounds("settings-scroll")
                .expect("settings scroll viewport");
            if viewport.contains(&target.center()) {
                break;
            }
            cx.simulate_event(gpui::ScrollWheelEvent {
                position: viewport.center(),
                delta: gpui::ScrollDelta::Pixels(gpui::point(
                    gpui::px(0.),
                    gpui::px(if target.center().y > viewport.bottom() {
                        -200.
                    } else {
                        200.
                    }),
                )),
                ..Default::default()
            });
            draw(cx);
        }
    }
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("missing native control: {selector}"));
    cx.simulate_click(bounds.center(), Modifiers::default());
}
fn settle(cx: &mut VisualTestContext) {
    for _ in 0..8 {
        cx.run_until_parked();
        draw(cx);
    }
}
fn frame(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    for _ in 0..20 {
        cx.run_until_parked();
        draw(cx);
        if shell.read_with(cx, |s, cx| {
            s.surfaces.settings.view.as_ref().is_some_and(|s| {
                let s = s.read(cx);
                !s.busy && s.painted.get() == s.revision
            })
        }) {
            return;
        }
    }
    panic!("settings response must reach CPU scene paint");
}
fn error(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Option<String> {
    shell.read_with(cx, |s, cx| {
        s.surfaces
            .settings
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .error
            .clone()
    })
}
fn timed_action(shell: &Entity<Shell>, cx: &mut VisualTestContext, selector: &str) -> f64 {
    let start = Instant::now();
    click(cx, selector);
    frame(shell, cx);
    start.elapsed().as_secs_f64() * 1000.
}
fn start(cx: &mut TestAppContext) -> (Fixture, Entity<Shell>, VisualTestContext, f64) {
    let fixture = Fixture::start(true);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("settings.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("s e t t i n g s");
    let time = Instant::now();
    visual.simulate_keystrokes("enter");
    frame(&shell, &mut visual);
    assert_eq!(error(&shell, &mut visual), None);
    assert!(
        visual.debug_bounds("settings-loaded").is_some(),
        "Settings must load through the shell and fixture server"
    );
    let elapsed = time.elapsed().as_secs_f64() * 1000.;
    (fixture, shell, visual, elapsed)
}
fn request(fixture: &Fixture, method: &str, path: &str, body: Value) -> (u16, Value) {
    let result = ureq::request(method, &format!("{}{path}", fixture.origin))
        .set("Authorization", "Bearer fixture-shell-bearer")
        .send_json(body);
    let response = match result {
        Ok(r) => r,
        Err(ureq::Error::Status(_, r)) => r,
        Err(e) => panic!("fixture transport: {e}"),
    };
    (response.status(), response.into_json().unwrap())
}
fn values(fixture: &Fixture) -> Value {
    fixture
        .client
        .get::<Value>("/api/panel/operator-defaults", &[("include", "values")])
        .unwrap()["values"]
        .clone()
}
fn search(cx: &mut VisualTestContext, query: &str) {
    click(cx, "settings-search");
    cx.simulate_keystrokes("ctrl-a backspace");
    cx.simulate_input(query);
    settle(cx);
}
fn edit(cx: &mut VisualTestContext, field: &str, text: &str) {
    search(cx, field);
    click(cx, &format!("edit-{field}"));
    click(cx, "settings-editor");
    cx.simulate_keystrokes("ctrl-a backspace");
    cx.simulate_input(text);
}

#[gpui::test]
fn settings_fixture_all_default_controls_persist_and_refresh(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, open_ms) = start(cx);
    let cx = &mut visual;
    let mut frames = vec![];
    request(
        &fixture,
        "POST",
        "/__fixture/settings",
        json!({"healLocked":false}),
    );
    click(cx, "settings-refresh");
    settle(cx);
    for field in [
        "autoTitleInferenceEnabled",
        "presentationQuietMode",
        "productTelemetryEnabled",
        "crashReportsEnabled",
        "telemetryOptIn",
        "supervisorAutoEscalate",
        "reviewContinuation",
        "packetExplainerEnabled",
        "buyinDocEnabled",
        "commitAttributionEnabled",
        "codexAppThreads",
        "promptCachingEnabled",
        "brainUseClaudeCli",
        "brainWarmupEnabled",
        "healBotEnabled",
    ] {
        search(cx, field);
        let value = values(&fixture)[field].clone();
        let previous = value.as_bool().unwrap_or_else(|| {
            assert_eq!(
                field, "productTelemetryEnabled",
                "only usage consent is nullable"
            );
            assert!(value.is_null(), "unanswered usage consent must be null");
            false
        });
        let start = Instant::now();
        click(cx, &format!("setting-{field}"));
        frame(&shell, cx);
        assert_eq!(error(&shell, cx), None, "native action {field}");
        frames.push(start.elapsed().as_secs_f64() * 1000.);
        assert_eq!(values(&fixture)[field], !previous, "persisted {field}");
    }
    search(cx, "presentationQuietMode");
    click(cx, "setting-presentationQuietMode");
    settle(cx);
    // Selectors are the choices shown by desktop Settings, not arbitrary JSON writes.
    for (field, index, expected) in [
        ("notificationsReviewReady", 0, json!("off")),
        ("overlapGate", 1, json!("strict")),
        ("requireApproval", 0, json!("always")),
        ("updateAutoApply", 0, json!("off")),
        ("workspaceManifestPolicy", 1, json!("one-approval")),
        ("prLinkDestination", 1, json!("browser")),
        ("workspaceParkingMode", 0, json!("manual")),
        ("brainRoutingMode", 1, json!("subscription")),
        ("brainCodexEffort", 3, json!("high")),
        ("thinkingEffort", 3, json!("high")),
        ("classAComposer", 0, json!("auto")),
        ("workersUseBrain", 2, json!("all")),
    ] {
        search(cx, field);
        frames.push(timed_action(
            &shell,
            cx,
            &format!("setting-{field}-{index}"),
        ));
        assert_eq!(values(&fixture)[field], expected, "persisted {field}");
    }
    for (field, text, expected) in [
        ("parallelCap", "8", json!(8)),
        ("meteredPacketCostCapUsd", "4.5", json!(4.5)),
        ("meteredPacketInputTokenCap", "12000", json!(12000)),
        ("uiLoopMaxIterations", "4", json!(4)),
        ("uiLoopMaxMinutes", "10", json!(10)),
        ("uiLoopMaxDiffBytes", "65536", json!(65536)),
        ("uiLoopMaxDiffFiles", "8", json!(8)),
        ("uiLoopPreviewTimeoutMs", "9000", json!(9000)),
        ("branchPrefix", "fixture-next", json!("fixture-next")),
        ("worktreeMaxCount", "4", json!(4)),
        ("worktreeMaxTotalGb", "8", json!(8)),
        ("storageReserveRatio", "20", json!(0.2)),
        ("storageReserveFloorGb", "8", json!(8)),
        ("brainCodexModel", "gpt-5.4", json!("gpt-5.4")),
    ] {
        edit(cx, field, text);
        frames.push(timed_action(&shell, cx, "settings-save"));
        assert_eq!(values(&fixture)[field], expected, "persisted {field}");
    }
    // A second desktop-shaped client changes the same file. The next native
    // action refreshes effective values and retains unrelated writes.
    assert_eq!(
        request(
            &fixture,
            "POST",
            "/api/panel/operator-defaults",
            json!({"branchPrefix":"desktop-fixture"})
        )
        .0,
        200
    );
    search(cx, "branchPrefix");
    click(cx, "settings-refresh");
    settle(cx);
    edit(cx, "branchPrefix", "discarded");
    click(cx, "settings-cancel");
    assert_eq!(values(&fixture)["branchPrefix"], "desktop-fixture");
    // No settings or drafts enter shell view-state persistence.
    let saved = fs::read_to_string(shell.read_with(cx, |s, _| s.file.clone())).unwrap();
    assert!(!saved.contains("desktop-fixture") && !saved.contains("discarded"));
    assert_eq!(frames.len(), 41);
    if let Ok(path) = std::env::var("O8_NEXT_SETTINGS_RESULTS") {
        fs::write(path, serde_json::to_vec_pretty(&json!({"endpoint":"headless GPUI CPU scene paint", "profile":"debug", "openToFirstFrameMs":open_ms, "interactionToFrameMs":frames, "defaultControls":41})).unwrap()).unwrap();
    }
}

#[gpui::test]
fn settings_fixture_validation_locks_loading_errors_and_empty(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, _) = start(cx);
    let cx = &mut visual;
    search(cx, "healBotEnabled");
    click(cx, "setting-healBotEnabled");
    assert_eq!(
        values(&fixture)["healBotEnabled"],
        false,
        "environment lock must refuse a write"
    );
    search(cx, "presentationQuietMode");
    click(cx, "setting-presentationQuietMode");
    frame(&shell, cx);
    let notifications = values(&fixture)["notificationsReviewReady"].clone();
    search(cx, "notificationsReviewReady");
    click(
        cx,
        if notifications == "on" {
            "setting-notificationsReviewReady-0"
        } else {
            "setting-notificationsReviewReady-1"
        },
    );
    settle(cx);
    assert_eq!(
        values(&fixture)["notificationsReviewReady"],
        notifications,
        "quiet mode must refuse notification edits"
    );
    search(cx, "presentationQuietMode");
    click(cx, "setting-presentationQuietMode");
    frame(&shell, cx);
    edit(cx, "parallelCap", "0");
    let before = values(&fixture)["parallelCap"].clone();
    click(cx, "settings-save");
    settle(cx);
    assert!(error(&shell, cx).is_some());
    assert_eq!(values(&fixture)["parallelCap"], before);
    click(cx, "settings-cancel");
    search(cx, "no settings match this query");
    assert!(cx.debug_bounds("settings-empty").is_some());
    request(
        &fixture,
        "POST",
        "/__fixture/settings",
        json!({"loseResponse":true}),
    );
    click(cx, "settings-nav-general");
    settle(cx);
    edit(cx, "branchPrefix", "fixture-committed-response-lost");
    click(cx, "settings-save");
    frame(&shell, cx);
    assert!(error(&shell, cx).unwrap().contains("unconfirmed"));
    assert_eq!(
        values(&fixture)["branchPrefix"],
        "fixture-committed-response-lost"
    );
    // An unsuccessful refresh must keep the write refusal in force.
    request(
        &fixture,
        "POST",
        "/__fixture/settings",
        json!({"nextStatus":503}),
    );
    click(cx, "settings-refresh");
    frame(&shell, cx);
    click(cx, "settings-save");
    assert_eq!(
        values(&fixture)["branchPrefix"],
        "fixture-committed-response-lost"
    );
    click(cx, "settings-refresh");
    frame(&shell, cx);
    assert_eq!(error(&shell, cx), None);
    click(cx, "settings-cancel");
    request(
        &fixture,
        "POST",
        "/__fixture/settings",
        json!({"nextStatus":503}),
    );
    click(cx, "settings-refresh");
    settle(cx);
    assert!(error(&shell, cx).is_some());
    click(cx, "settings-refresh");
    settle(cx);
    assert_eq!(error(&shell, cx), None);
    request(
        &fixture,
        "POST",
        "/__fixture/settings",
        json!({"delayMs":150}),
    );
    // simulate_click drains background work before returning. Observe the
    // notified pending state during the real click, rather than checking it
    // after the fixture response has already arrived.
    let pending = std::rc::Rc::new(std::cell::Cell::new(false));
    let observed = pending.clone();
    let settings = shell.read_with(cx, |s, _| {
        s.surfaces.settings.view.as_ref().unwrap().clone()
    });
    let subscription = cx.update(|_, cx| {
        cx.observe(&settings, move |settings, cx| {
            if settings.read(cx).busy {
                observed.set(true);
            }
        })
    });
    click(cx, "settings-refresh");
    draw(cx);
    assert!(
        pending.get(),
        "the pending read must notify a loading state"
    );
    drop(subscription);
    assert!(cx.debug_bounds("settings-loading").is_some());
    settle(cx);
    request(
        &fixture,
        "POST",
        "/__fixture/settings",
        json!({"emptyKeys":true}),
    );
    click(cx, "settings-nav-keys");
    settle(cx);
    assert!(shell.read_with(cx, |s, cx| {
        s.surfaces
            .settings
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .keys
            .as_ref()
            .is_some_and(|keys| keys.providers.is_empty())
    }));
    assert!(cx.debug_bounds("settings-empty").is_some());
}

#[gpui::test]
fn settings_fixture_provider_keys_presence_save_cancel_remove_enable_check_and_refusals(
    cx: &mut TestAppContext,
) {
    let (fixture, shell, mut visual, _) = start(cx);
    let cx = &mut visual;
    click(cx, "settings-nav-keys");
    settle(cx);
    for provider in ["openrouter", "deepseek", "anthropic", "openai"] {
        click(cx, &format!("key-edit-{provider}"));
        click(cx, "settings-editor");
        cx.simulate_input("fixture-unsaved-key");
        click(cx, "settings-cancel");
        click(cx, &format!("key-edit-{provider}"));
        click(cx, "settings-editor");
        cx.simulate_input("fixture-refused-key");
        click(cx, "settings-save");
        settle(cx);
        assert!(error(&shell, cx).is_some());
        // The submitted secret has already left the input, including its undo history.
        cx.simulate_keystrokes("ctrl-z");
        draw(cx);
        assert!(cx.debug_bounds("settings-secret-empty").is_some());
        click(cx, "settings-cancel");
        click(cx, &format!("key-edit-{provider}"));
        click(cx, "settings-editor");
        cx.simulate_input("fixture-new-key-value");
        cx.update(|_, cx| {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string("clipboard-marker".into()))
        });
        cx.simulate_keystrokes("ctrl-a ctrl-c");
        assert_eq!(
            cx.update(|_, cx| cx.read_from_clipboard().and_then(|c| c.text())),
            Some("clipboard-marker".into())
        );
        click(cx, "settings-save");
        settle(cx);
        assert_eq!(error(&shell, cx), None, "native {provider} save");
        let native = shell.read_with(cx, |s, cx| {
            format!(
                "{:?}",
                s.surfaces.settings.view.as_ref().unwrap().read(cx).keys
            )
        });
        assert!(
            !native.contains("fixt") && !native.contains("alue") && !native.contains("maskedKey")
        );
        let inventory: Value = fixture.client.get("/api/v2/keys", &[]).unwrap();
        assert!(
            inventory["providers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["id"] == provider && p["configured"] == true)
        );
        click(cx, &format!("key-enabled-{provider}"));
        settle(cx);
        if provider == "openrouter" {
            click(cx, "key-check-openrouter");
            settle(cx);
            assert!(
                error(&shell, cx).is_some(),
                "checking a disabled connection is refused by the server"
            );
        }
        click(cx, &format!("key-enabled-{provider}"));
        settle(cx);
        if provider == "openrouter" {
            click(cx, "key-check-openrouter");
            settle(cx);
        }
        click(cx, &format!("key-remove-{provider}"));
        click(cx, "settings-cancel-remove");
        click(cx, &format!("key-remove-{provider}"));
        click(cx, "settings-confirm-remove");
        settle(cx);
        let inventory: Value = fixture.client.get("/api/v2/keys", &[]).unwrap();
        assert!(
            inventory["providers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|p| p["id"] == provider && p["configured"] == false)
        );
    }
    let saved = fs::read_to_string(shell.read_with(cx, |s, _| s.file.clone())).unwrap();
    assert!(!saved.contains("fixture-new-key") && !saved.contains("fixture-refused"));
}

#[gpui::test]
fn settings_fixture_unauthorized_and_close_restore_shell(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, _) = start(cx);
    let cx = &mut visual;
    click(cx, "settings-close");
    draw(cx);
    assert!(shell.read_with(cx, |s, _| s.surfaces.settings.view.is_none()));
    cx.simulate_keystrokes("ctrl-,");
    settle(cx);
    assert!(cx.debug_bounds("settings-loaded").is_some());
    // The same entry point renders an explicit 401 instead of an empty success.
    let denied =
        Client::authenticated(&fixture.origin, Some("fixture-invalid-operator".into())).unwrap();
    let (denied_shell, mut visual) = open(
        denied,
        fixture.root.join("denied.json"),
        State::default(),
        &mut cx.cx,
    );
    visual.simulate_keystrokes("ctrl-,");
    settle(&mut visual);
    assert!(error(&denied_shell, &mut visual).is_some());
    assert!(denied_shell.read_with(&visual, |s, cx| {
        s.surfaces
            .settings
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .snapshot
            .is_none()
    }));
    drop(shell);
}

#[gpui::test]
fn settings_fixture_toml_save_reload_conflict_and_cancel(cx: &mut TestAppContext) {
    let (fixture, _, mut visual, _) = start(cx);
    let cx = &mut visual;
    click(cx, "settings-file-open");
    settle(cx);
    click(cx, "settings-editor");
    cx.simulate_keystrokes("ctrl-a backspace");
    cx.simulate_input("[operator]\nparallel_cap = 3\n");
    click(cx, "settings-save");
    settle(cx);
    assert_eq!(values(&fixture)["parallelCap"], 3);
    click(cx, "settings-file-open");
    settle(cx);
    click(cx, "settings-editor");
    cx.simulate_keystrokes("ctrl-a backspace");
    cx.simulate_input("[operator]\nparallel_cap = 7\n");
    request(
        &fixture,
        "POST",
        "/api/panel/operator-defaults",
        json!({"parallelCap":5}),
    );
    click(cx, "settings-save");
    settle(cx);
    assert!(cx.debug_bounds("settings-conflict").is_some());
    assert_eq!(values(&fixture)["parallelCap"], 5);
    click(cx, "settings-file-reload");
    settle(cx);
    click(cx, "settings-editor");
    cx.simulate_keystrokes("ctrl-a backspace");
    cx.simulate_input("[operator]\nparallel_cap = 6\n");
    click(cx, "settings-save");
    settle(cx);
    assert_eq!(values(&fixture)["parallelCap"], 6);
    click(cx, "settings-file-open");
    settle(cx);
    click(cx, "settings-cancel");
    assert_eq!(values(&fixture)["parallelCap"], 6);
}

#[path = "settings_review_tests.rs"]
mod review;
