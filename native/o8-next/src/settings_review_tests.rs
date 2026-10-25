//! Review regressions through real shell controls and the production route host.
use super::*;

#[gpui::test]
fn settings_review_toml_never_reads_or_copies_saved_secrets(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, _) = start(cx);
    let cx = &mut visual;
    let state: Value = fixture
        .client
        .get("/api/panel/operator-defaults", &[("include", "values")])
        .unwrap();
    let canary = ["fixture-private", "canary-value"].join("-");
    let raw = format!("[operator]\nparallel_cap = 3\n[accepted_table]\ntoken = {canary:?}\n");
    assert_eq!(
        request(
            &fixture,
            "POST",
            "/api/panel/operator-defaults",
            json!({
                "settingsToml":raw, "settingsTomlRevision":state["settingsToml"]["revision"]
            })
        )
        .0,
        200,
        "the ordinary desktop route accepts this TOML table"
    );
    click(cx, "settings-file-open");
    frame(&shell, cx);
    click(cx, "settings-editor");
    cx.simulate_keystrokes("ctrl-a ctrl-c");
    let copied = cx
        .update(|_, cx| cx.read_from_clipboard().and_then(|c| c.text()))
        .unwrap_or_default();
    assert!(
        !copied.contains(&canary),
        "saved TOML secrets must never reach the editor clipboard"
    );
    cx.simulate_keystrokes("ctrl-a backspace");
    cx.simulate_input("[operator]\nparallel_cap = 6\n");
    click(cx, "settings-save");
    frame(&shell, cx);
    assert_eq!(error(&shell, cx), None);
    let saved: Value = fixture
        .client
        .get("/api/panel/operator-defaults", &[("include", "values")])
        .unwrap();
    assert!(
        saved["settingsToml"]["text"]
            .as_str()
            .unwrap()
            .contains(&canary),
        "safe edits preserve hidden entries"
    );
    assert_eq!(saved["values"]["parallelCap"], 6);
    click(cx, "settings-file-open");
    frame(&shell, cx);
    click(cx, "settings-editor");
    cx.simulate_keystrokes("ctrl-a ctrl-c");
    let copied = cx
        .update(|_, cx| cx.read_from_clipboard().and_then(|c| c.text()))
        .unwrap_or_default();
    assert!(
        !copied.contains(&canary),
        "POST responses must not repopulate a secret either"
    );
    click(cx, "settings-cancel");
    let path = fs::canonicalize(saved["settingsToml"]["path"].as_str().unwrap()).unwrap();
    fs::write(
        path,
        format!("[accepted_table]\ntoken = {canary:?} trailing-invalid-text\n"),
    )
    .unwrap();
    click(cx, "settings-file-open");
    frame(&shell, cx);
    assert!(
        error(&shell, cx).is_some(),
        "a malformed file must stay in the error state"
    );
    let log = fs::read_to_string(fixture.root.join("fixture.log")).unwrap();
    assert!(
        !log.contains(&canary),
        "saved TOML secrets must never reach logs"
    );
}

#[gpui::test]
fn settings_review_edit_reloads_the_desktop_value(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, _) = start(cx);
    let cx = &mut visual;
    assert_eq!(
        request(
            &fixture,
            "POST",
            "/api/panel/operator-defaults",
            json!({"branchPrefix":"desktop-newer"})
        )
        .0,
        200
    );
    search(cx, "branchPrefix");
    click(cx, "edit-branchPrefix");
    frame(&shell, cx);
    click(cx, "settings-editor");
    cx.simulate_keystrokes("ctrl-a ctrl-c");
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|c| c.text())),
        Some("desktop-newer".into())
    );
}

#[gpui::test]
fn settings_review_stale_save_preserves_the_desktop_value(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, _) = start(cx);
    let cx = &mut visual;
    edit(cx, "branchPrefix", "native-stale");
    assert_eq!(
        request(
            &fixture,
            "POST",
            "/api/panel/operator-defaults",
            json!({"branchPrefix":"desktop-wins"})
        )
        .0,
        200
    );
    click(cx, "settings-save");
    frame(&shell, cx);
    assert!(error(&shell, cx).is_some(), "a stale save must be refused");
    assert_eq!(values(&fixture)["branchPrefix"], "desktop-wins");
    click(cx, "settings-file-reload");
    frame(&shell, cx);
    click(cx, "settings-editor");
    cx.simulate_keystrokes("ctrl-a ctrl-c");
    assert_eq!(
        cx.update(|_, cx| cx.read_from_clipboard().and_then(|c| c.text())),
        Some("desktop-wins".into())
    );
    cx.simulate_keystrokes("ctrl-a backspace");
    cx.simulate_input("native-current");
    click(cx, "settings-save");
    frame(&shell, cx);
    assert_eq!(error(&shell, cx), None);
    assert_eq!(values(&fixture)["branchPrefix"], "native-current");
    edit(cx, "branchPrefix", "draft-after-refresh");
    assert_eq!(
        request(
            &fixture,
            "POST",
            "/api/panel/operator-defaults",
            json!({"branchPrefix":"desktop-after-edit"})
        )
        .0,
        200
    );
    click(cx, "settings-refresh");
    frame(&shell, cx);
    click(cx, "settings-save");
    frame(&shell, cx);
    assert!(
        error(&shell, cx).is_some(),
        "refreshing the list must not rebase an old draft"
    );
    assert_eq!(values(&fixture)["branchPrefix"], "desktop-after-edit");
}

#[gpui::test]
fn settings_review_updates_the_running_desktop_presentation(cx: &mut TestAppContext) {
    let (fixture, shell, mut visual, _) = start(cx);
    let cx = &mut visual;
    let live = || {
        request(
            &fixture,
            "POST",
            "/__fixture/settings",
            json!({"presentation":true}),
        )
        .1
    };
    assert_eq!(
        live()["presentation"],
        json!({"quiet":false,"notifications":true})
    );
    // A direct native recording override is independent of a persisted change.
    let transient = request(
        &fixture,
        "POST",
        "/__fixture/settings",
        json!({"presentation":true,"transientQuiet":true}),
    )
    .1;
    assert_eq!(transient["presentation"]["quiet"], true);
    assert_eq!(live()["presentation"]["quiet"], true);
    request(
        &fixture,
        "POST",
        "/__fixture/settings",
        json!({"presentation":true,"transientQuiet":false}),
    );
    search(cx, "presentationQuietMode");
    click(cx, "setting-presentationQuietMode");
    frame(&shell, cx);
    assert_eq!(
        live()["presentation"]["quiet"],
        true,
        "the running desktop must suppress overlays now"
    );
    click(cx, "setting-presentationQuietMode");
    frame(&shell, cx);
    assert_eq!(
        live()["presentation"]["quiet"],
        false,
        "leaving quiet mode restores the live state"
    );
    search(cx, "notificationsReviewReady");
    for (index, enabled) in [(0, false), (1, true)] {
        click(cx, &format!("setting-notificationsReviewReady-{index}"));
        frame(&shell, cx);
        assert_eq!(
            live()["presentation"]["notifications"],
            enabled,
            "the running desktop notification gate must change now"
        );
    }
}
