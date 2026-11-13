use super::*;

#[gpui::test]
fn pull_requests_submitted_reviews_survive_refresh_and_changed_head(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fixture
        .client
        .pr_post(
            "/__fixture/pr-gates",
            &json!({"scenario":"submitted-reviews"}),
        )
        .unwrap();
    let (view, visual) = cx.add_window_view(|w, cx| {
        PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx)
    });
    settle(visual);
    click(visual, "pr-row-7");
    click(visual, "pr-tab-reviews");
    for id in [
        "pr-discussion-submitted-501",
        "pr-discussion-submitted-502",
        "pr-review-source-submitted-501",
        "pr-review-source-submitted-502",
    ] {
        assert!(
            visual.debug_bounds(id).is_some(),
            "render the submitted review, not just a summary: {id}"
        );
    }
    for (width, height) in [(900., 700.), (1680., 1050.)] {
        visual.simulate_resize(gpui::size(gpui::px(width), gpui::px(height)));
        draw(visual);
        for id in [
            "pr-review-source-submitted-501",
            "pr-review-source-submitted-502",
        ] {
            let bounds = visual.debug_bounds(id).unwrap();
            assert!(
                bounds.right() <= gpui::px(width),
                "review source must fit the window"
            );
        }
    }
    let original = view.read_with(visual, |s, _| s.detail["submittedReviews"].clone());
    view.update_in(visual, |s, window, _| s.focus.focus(window));
    visual.simulate_keystrokes("tab enter");
    assert_eq!(
        visual.cx.opened_url().as_deref(),
        Some("https://github.com/example/repo/pull/7#pullrequestreview-501")
    );
    visual.simulate_keystrokes("tab enter");
    assert_eq!(
        visual.cx.opened_url().as_deref(),
        Some("https://github.com/example/repo/pull/7#pullrequestreview-502")
    );
    assert_eq!(original.as_array().unwrap().len(), 2);
    assert!(view.read_with(visual, |s, _| s.detail["reviewDecision"].is_null()));
    assert_eq!(original[0]["reviewedHeadSha"], "c".repeat(40));
    // Re-open through the real read path; then change source code without erasing review history.
    fixture
        .client
        .pr_post("/__fixture/pr-gates", &json!({"scenario":"head-advanced"}))
        .unwrap();
    view.update(visual, |s, cx| s.select(7, cx));
    settle(visual);
    view.read_with(visual, |s, _| {
        assert_eq!(s.detail["headSha"], "d".repeat(40));
        assert_eq!(s.detail["submittedReviews"], original);
    });
    click(visual, "pr-tab-reviews");
    assert!(visual.debug_bounds("pr-discussion-submitted-501").is_some());
    assert!(visual.debug_bounds("pr-discussion-submitted-502").is_some());
}

#[gpui::test]
fn pull_requests_change_map_reads_selected_head_and_filters_diff(cx: &mut TestAppContext) {
    let fixture = Fixture::with_args(&["--change-map"]);
    let (view, visual) = cx.add_window_view(|w, cx| {
        PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx)
    });
    settle(visual);
    click(visual, "pr-row-7");
    assert!(visual.debug_bounds("change-map-summary").is_some());
    view.read_with(visual, |s, _| {
        assert_eq!(s.map.delta["status"], "ready", "{}", s.map.summary());
        assert_eq!(s.map.delta["summary"]["addedEdges"], 1);
    });
    click(visual, "change-map-summary");
    let index = view.read_with(visual, |s, _| {
        s.map.delta["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .position(|n| n["path"] == "entry.ts")
            .unwrap()
    });
    click(visual, &format!("change-map-node-{index}"));
    view.read_with(visual, |s, _| {
        assert_eq!(s.tab, "changes");
        assert_eq!(s.map.selected, vec!["entry.ts"]);
        assert!(s.open_files.contains("entry.ts"));
    });
    assert!(visual.debug_bounds("pr-file-0").is_some());
    click(visual, "pr-tab-checks");
    click(visual, "change-map-summary");
    assert_eq!(
        view.read_with(visual, |s, _| s.tab.clone()),
        "checks",
        "disclosure must not navigate to a retained selection"
    );
    click(visual, "change-map-summary");
    assert_eq!(view.read_with(visual, |s, _| s.tab.clone()), "checks");
    // Local edits are not part of the immutable PR evidence.
    std::fs::write(
        std::path::Path::new(&fixture.workspace).join("entry.ts"),
        "export const entry = 2;\n",
    )
    .unwrap();
    view.update(visual, |s, cx| s.select(7, cx));
    settle(visual);
    view.read_with(visual, |s, _| {
        assert_eq!(s.map.delta["status"], "ready");
        assert!(s.map.selected.is_empty());
    });
}

#[gpui::test]
fn pull_requests_change_map_filtered_count_and_empty_recovery(cx: &mut TestAppContext) {
    let fixture = Fixture::with_args(&["--change-map"]);
    let (view, visual) = cx.add_window_view(|w, cx| {
        PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx)
    });
    settle(visual);
    click(visual, "pr-row-7");
    view.update(visual, |s, cx| {
        s.detail["files"].as_array_mut().unwrap().push(json!({
            "path":"other.ts", "additions":3, "deletions":1, "patch":"@@ -1 +1 @@\n-old\n+new"
        }));
        s.detail["changedFiles"] = json!(2);
        s.changed(cx);
    });
    let index = view.read_with(visual, |s, _| {
        s.map.delta["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .position(|node| node["path"] == "entry.ts")
            .unwrap()
    });
    click(visual, "change-map-summary");
    click(visual, &format!("change-map-node-{index}"));
    assert!(
        visual.debug_bounds("pr-changes-count-1").is_some(),
        "the toolbar must count the single selected file"
    );
    view.update(visual, |s, cx| {
        s.map.selected = vec!["not-in-this-diff.ts".into()];
        s.changed(cx);
    });
    draw(visual);
    assert!(visual.debug_bounds("pr-changes-count-0").is_some());
    assert!(visual.debug_bounds("pr-map-no-files").is_some());
    assert!(visual.debug_bounds("pr-file-0").is_none());
    click(visual, "pr-map-show-all");
    view.read_with(visual, |s, _| {
        assert!(s.map.selected.is_empty());
        assert_eq!(s.tab, "changes");
    });
    assert!(visual.debug_bounds("pr-file-0").is_some());
}
