use super::*;
fn saved(f: &Fixture) -> String {
    f.client
        .project_request(
            "POST",
            "/api/prompt-library",
            &json!({"title":"Original", "body":"Original body", "scope":"global"}),
        )
        .unwrap()["prompt"]["id"]
        .as_str()
        .unwrap()
        .into()
}
fn desktop(f: &Fixture, id: &str, body: &str) {
    f.client
        .project_request(
            "PATCH",
            &format!("/api/prompt-library/{id}"),
            &json!({"body":body}),
        )
        .unwrap();
}
fn start(f: &Fixture, cx: &mut TestAppContext) -> VisualTestContext {
    let (_, mut visual) = open(
        f.client.clone(),
        f.root.join("review.json"),
        State::default(),
        cx,
    );
    visual.run_until_parked();
    draw(&mut visual);
    custom_click(&mut visual, "rail-more");
    custom_click(&mut visual, "rail-more-customize");
    custom_click(&mut visual, "custom-tab-prompts");
    visual
}
#[gpui::test]
fn cached_prompt_copy_and_edit_reload_current_text(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--customize");
    let id = saved(&f);
    let cx = &mut start(&f, cx);
    desktop(&f, &id, "Desktop copy");
    custom_click(cx, "custom-copy-0");
    assert_eq!(
        cx.read_from_clipboard().unwrap().text().unwrap(),
        "Desktop copy",
        "Copy must reload the saved prompt"
    );
    desktop(&f, &id, "Desktop edit");
    custom_click(cx, "custom-edit-0");
    custom_click(cx, "custom-body");
    cx.simulate_keystrokes("ctrl-a ctrl-c");
    assert_eq!(
        cx.read_from_clipboard().unwrap().text().unwrap(),
        "Desktop edit",
        "Edit must reload the saved prompt"
    );
}

#[gpui::test]
fn cached_prompt_edit_preserves_the_reloaded_repository(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--customize");
    let id = saved(&f);
    let cx = &mut start(&f, cx);
    let repo = f.root.join("desktop-repository");
    fs::create_dir(&repo).unwrap();
    let repo = fs::canonicalize(repo).unwrap();
    f.client
        .project_request(
            "PATCH",
            &format!("/api/prompt-library/{id}"),
            &json!({"scope":"repo", "repoPath":repo}),
        )
        .unwrap();
    custom_click(cx, "custom-edit-0");
    custom_click(cx, "custom-title");
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("Edited after reload");
    custom_click(cx, "custom-save");
    let current: Value = f
        .client
        .get(&format!("/api/prompt-library/{id}"), &[])
        .unwrap();
    assert_eq!(
        fs::canonicalize(current["prompt"]["repoPath"].as_str().unwrap()).unwrap(),
        repo,
        "editing must preserve the reloaded repository"
    );
}
#[gpui::test]
fn stale_prompt_save_preserves_desktop_edit_and_native_draft(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--customize");
    let id = saved(&f);
    let cx = &mut start(&f, cx);
    custom_click(cx, "custom-edit-0");
    desktop(&f, &id, "Newer desktop edit");
    custom_click(cx, "custom-body");
    cx.simulate_keystrokes("ctrl-a");
    cx.simulate_input("Native draft");
    custom_click(cx, "custom-save");
    let current: Value = f
        .client
        .get(&format!("/api/prompt-library/{id}"), &[])
        .unwrap();
    assert_eq!(
        current["prompt"]["body"], "Newer desktop edit",
        "stale Save must refuse to overwrite a newer revision"
    );
    assert!(cx.debug_bounds("custom-error").is_some());
    assert!(cx.debug_bounds("custom-body").is_some());
}
#[gpui::test]
fn stale_prompt_delete_preserves_desktop_edit(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--customize");
    let id = saved(&f);
    let cx = &mut start(&f, cx);
    custom_click(cx, "custom-delete-0");
    desktop(&f, &id, "Newer desktop edit");
    custom_click(cx, "custom-delete-confirm");
    let current: Value = f.client.get("/api/prompt-library", &[]).unwrap();
    assert!(
        current["prompts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == id && p["body"] == "Newer desktop edit"),
        "stale Delete must refuse to delete a newer revision"
    );
    assert!(cx.debug_bounds("custom-error").is_some());
}
#[gpui::test]
fn credential_metadata_never_reaches_customization_copy(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--customize");
    let cx = &mut start(&f, cx);
    custom_click(cx, "custom-tab-hooks");
    custom_click(cx, "custom-copy-0");
    let hook = cx.read_from_clipboard().unwrap().text().unwrap();
    assert_eq!(hook, "command", "hook rows expose only safe metadata");
    custom_click(cx, "custom-tab-connections");
    custom_click(cx, "custom-copy-0");
    let mcp = cx.read_from_clipboard().unwrap().text().unwrap();
    assert_eq!(
        mcp, "http · fixture.example",
        "MCP metadata must omit URL credentials, path and query"
    );
}
#[gpui::test]
fn agent_and_skill_bodies_contain_only_descriptions(cx: &mut TestAppContext) {
    let f = Fixture::start_mode(false, "--customize");
    let cx = &mut start(&f, cx);
    custom_click(cx, "custom-tab-agents");
    custom_click(cx, "custom-copy-0");
    assert_eq!(
        cx.read_from_clipboard().unwrap().text().unwrap(),
        "Fixture guidance"
    );
    custom_click(cx, "custom-tab-skills");
    custom_click(cx, "custom-copy-0");
    assert_eq!(
        cx.read_from_clipboard().unwrap().text().unwrap(),
        "Read-only fixture skill"
    );
}
