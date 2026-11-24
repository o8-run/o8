use super::*;
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
    visual
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
