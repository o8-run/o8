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
