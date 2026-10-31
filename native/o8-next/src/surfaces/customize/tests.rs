use crate::shell::test_support::*;
use crate::shell::*;

#[path = "review_tests.rs"]
mod review;

fn custom_click(cx: &mut VisualTestContext, selector: &'static str) {
    draw(cx);
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("missing control: {selector}"));
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    cx.run_until_parked();
    draw(cx);
}

#[gpui::test]
fn customize_inventory_and_prompt_crud(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--customize");
    let repos: Value = fixture.client.get("/api/panel/repos", &[]).unwrap();
    let repo = repos["repos"][0]["localPath"].as_str().unwrap().to_owned();
    let state = State {
        selected: Some(repo.clone()),
        ..State::default()
    };
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("customize.json"),
        state,
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    // More opens one destination at a time: Customize replaces Projects.
    custom_click(cx, "rail-more");
    custom_click(cx, "rail-more-projects");
    assert!(shell.read_with(cx, |s, _| s.surfaces.projects.open));
    custom_click(cx, "rail-more");
    custom_click(cx, "rail-more-customize");
    assert!(
        !shell.read_with(cx, |s, _| s.surfaces.projects.open),
        "Projects stays open"
    );
    custom_click(cx, "shell-home");
    let start = Instant::now();
    custom_click(cx, "rail-more");
    custom_click(cx, "rail-more-customize");
    let open_ms = start.elapsed().as_secs_f64() * 1000.;
    custom_click(cx, "custom-tab-agents");
    custom_click(cx, "custom-copy-0");
    assert!(
        cx.read_from_clipboard()
            .unwrap()
            .text()
            .unwrap()
            .contains("Fixture")
    );
    custom_click(cx, "custom-personal");
    custom_click(cx, "custom-copy-0");
    assert!(
        cx.read_from_clipboard()
            .unwrap()
            .text()
            .unwrap()
            .contains("Personal")
    );
    custom_click(cx, "custom-workspace");
    custom_click(cx, "custom-tab-skills");
    custom_click(cx, "custom-copy-0");
    assert!(
        cx.read_from_clipboard()
            .unwrap()
            .text()
            .unwrap()
            .contains("Read-only fixture skill")
    );
    custom_click(cx, "custom-tab-hooks");
    custom_click(cx, "custom-copy-0");
    assert!(
        cx.read_from_clipboard()
            .unwrap()
            .text()
            .unwrap()
            .contains("command")
    );
    custom_click(cx, "custom-tab-connections");
    assert!(cx.debug_bounds("custom-row-0").is_some());
    custom_click(cx, "custom-tab-rules");
    custom_click(cx, "custom-copy-0");
    assert!(
        cx.read_from_clipboard()
            .unwrap()
            .text()
            .unwrap()
            .contains("Fixture instruction")
    );
    custom_click(cx, "custom-tab-prompts");
    assert!(cx.debug_bounds("custom-empty").is_some());
    custom_click(cx, "custom-new");
    custom_click(cx, "custom-save");
    assert!(
        cx.debug_bounds("custom-error").is_some(),
        "server validation must retain the editor"
    );
    custom_click(cx, "custom-title");
    cx.simulate_input("Saved fixture");
    custom_click(cx, "custom-body");
    cx.simulate_input("Reusable fixture text");
    custom_click(cx, "custom-tags");
    cx.simulate_input("review, fixture");
    custom_click(cx, "custom-save");
    let saved: Value = fixture
        .client
        .get(
            "/api/prompt-library",
            &[("repoPath", &repo), ("scope", "available")],
        )
        .unwrap();
    assert_eq!(saved["prompts"][0]["title"], "Saved fixture");
    assert_eq!(saved["prompts"][0]["tags"], json!(["review", "fixture"]));
    assert_eq!(
        fs::canonicalize(saved["prompts"][0]["repoPath"].as_str().unwrap()).unwrap(),
        fs::canonicalize(&repo).unwrap()
    );
    custom_click(cx, "custom-copy-0");
    assert_eq!(
        cx.read_from_clipboard().unwrap().text().unwrap(),
        "Reusable fixture text"
    );
    custom_click(cx, "custom-edit-0");
    custom_click(cx, "custom-title");
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("Cancelled");
    custom_click(cx, "custom-cancel");
    let cancelled: Value = fixture
        .client
        .get("/api/prompt-library", &[("repoPath", &repo)])
        .unwrap();
    assert_eq!(cancelled["prompts"][0]["title"], "Saved fixture");
    custom_click(cx, "custom-edit-0");
    custom_click(cx, "custom-title");
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("Updated fixture");
    custom_click(cx, "custom-save");
    let updated: Value = fixture
        .client
        .get("/api/prompt-library", &[("repoPath", &repo)])
        .unwrap();
    assert_eq!(updated["prompts"][0]["title"], "Updated fixture");
    custom_click(cx, "custom-search");
    let start = Instant::now();
    cx.simulate_input("unmatched");
    draw(cx);
    let interaction = start.elapsed().as_secs_f64() * 1000.;
    assert!(cx.debug_bounds("custom-no-matches").is_some());
    cx.simulate_keystrokes("ctrl-a backspace");
    draw(cx);
    let retained_view = shell.read_with(cx, |s, _| {
        s.surfaces.customize.view.as_ref().unwrap().entity_id()
    });
    custom_click(cx, "shell-home");
    custom_click(cx, "rail-more");
    custom_click(cx, "rail-more-customize");
    assert_eq!(
        retained_view,
        shell.read_with(cx, |s, _| s
            .surfaces
            .customize
            .view
            .as_ref()
            .unwrap()
            .entity_id()),
        "reopening Customize must retain its view and selection"
    );
    custom_click(cx, "custom-copy-0");
    assert_eq!(
        cx.read_from_clipboard().unwrap().text().unwrap(),
        "Reusable fixture text"
    );

    custom_click(cx, "custom-refresh");
    custom_click(cx, "custom-delete-0");
    custom_click(cx, "custom-delete-cancel");
    let retained: Value = fixture
        .client
        .get("/api/prompt-library", &[("repoPath", &repo)])
        .unwrap();
    assert_eq!(retained["prompts"].as_array().unwrap().len(), 1);
    custom_click(cx, "custom-delete-0");
    custom_click(cx, "custom-delete-confirm");
    let empty: Value = fixture
        .client
        .get("/api/prompt-library", &[("repoPath", &repo)])
        .unwrap();
    assert_eq!(empty["prompts"], json!([]));
    custom_click(cx, "shell-home");
    println!(
        "O8_NEXT_CUSTOMIZE_EVIDENCE {}",
        json!({"endpoint":"headless GPUI CPU scene; no GPU/compositor","openToFirstFrameMs":open_ms,"interactionToFrameMs":interaction})
    );
}

#[gpui::test]
fn customize_auth_error_and_retry(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--customize-denied");
    let (_shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("denied.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    custom_click(cx, "rail-more");
    custom_click(cx, "rail-more-customize");
    assert!(cx.debug_bounds("custom-error").is_some());
    custom_click(cx, "custom-refresh");
    assert!(cx.debug_bounds("custom-error").is_some());
}
