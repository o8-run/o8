use super::*;

/// The constructor used by the worker card keeps the ordinary working-diff read,
/// then obtains canonical missing-checkout proof from the recorded lane.
#[gpui::test]
fn diff_missing_checkout_from_worker_inspector(cx: &mut TestAppContext) {
    let fixture = Fixture::new(409, "worktree_missing", "lane-orphan");
    let (view, cx) = cx.add_window_view(|window, cx| {
        DiffSurface::in_lane(
            fixture.client(),
            Target::Worktree {
                path: "/fixture/removed-checkout".into(),
                base: None,
                file: None,
            },
            Some("lane-orphan".into()),
            window,
            cx,
        )
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("diff-missing-checkout").is_some());
    assert!(cx.debug_bounds("diff-discard-orphan").is_some());
    assert!(cx.debug_bounds("diff-approve").is_none());
    let gets = fixture.gets.lock().unwrap().clone();
    assert_eq!(gets.len(), 2);
    assert!(gets[0].starts_with("GET /api/worktrees/diff?"));
    assert!(gets[1].starts_with("GET /api/lanes/lane-orphan/diff?"));
    view.update(cx, |view, cx| {
        view.confirm_missing(true, cx);
        view.discard_missing(cx);
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert_eq!(
            view.missing.as_ref().unwrap().failure.as_deref(),
            Some("Fixture discard refused.")
        );
    });
    assert_eq!(
        *fixture.posts.lock().unwrap(),
        vec![json!({"laneId":"lane-orphan"})]
    );
}

#[gpui::test]
fn diff_worker_inspector_keeps_successful_working_diff(cx: &mut TestAppContext) {
    let fixture = Fixture::new(200, "", "lane-present");
    let (view, cx) = cx.add_window_view(|window, cx| {
        DiffSurface::in_lane(
            fixture.client(),
            Target::Worktree {
                path: "/fixture/present-checkout".into(),
                base: None,
                file: None,
            },
            Some("lane-present".into()),
            window,
            cx,
        )
    });
    cx.run_until_parked();
    view.read_with(cx, |view, _| {
        assert!(view.ready && !view.failed && view.missing.is_none())
    });
    assert!(cx.debug_bounds("diff-discard-orphan").is_none());
    let gets = fixture.gets.lock().unwrap();
    assert_eq!(
        gets.len(),
        1,
        "a valid working diff needs no lane proof read"
    );
    assert!(gets[0].starts_with("GET /api/worktrees/diff?"));
}

#[gpui::test]
fn diff_running_worker_cannot_discard_missing_lane(cx: &mut TestAppContext) {
    let fixture = Fixture::new(409, "worktree_missing", "server-lane");
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = DiffSurface::in_lane(
            fixture.client(),
            Target::Worktree {
                path: "/fixture/removed".into(),
                base: None,
                file: None,
            },
            Some("server-lane".into()),
            window,
            cx,
        );
        view.allow_orphan_discard(false);
        view
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("diff-missing-checkout").is_some());
    assert!(cx.debug_bounds("diff-discard-orphan").is_none());
    assert!(cx.debug_bounds("request-changes-open").is_none());
    view.update(cx, |view, cx| {
        view.confirm_missing(true, cx);
        view.discard_missing(cx);
    });
    cx.run_until_parked();
    assert!(fixture.posts.lock().unwrap().is_empty());
}
