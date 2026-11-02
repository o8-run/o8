use super::tests::{activity_click, activity_open, activity_view};
use crate::shell::test_support::*;

#[gpui::test]
fn activity_commit_details_open_native_diff_and_return_to_feed(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(
        false,
        "--activity --activity-local-clones --activity-commit",
    );
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    activity_click(&mut visual, "activity-filter-commit");
    let view = activity_view(&shell, &mut visual);
    let selector = view.read_with(&visual, |v, _| {
        v.rows
            .iter()
            .find(|r| r.kind == "commit")
            .unwrap()
            .selector()
    });
    activity_click(&mut visual, Box::leak(selector.into_boxed_str()));
    activity_click(&mut visual, "activity-view-commit");
    assert!(visual.debug_bounds("activity-commit-viewer").is_some());
    assert!(
        visual.debug_bounds("diff-viewport").is_some(),
        "commit details reuse the native diff control"
    );
    assert!(
        view.read_with(&visual, |v, cx| {
            let (_, diff) = v.commit.as_ref().unwrap();
            let diff = diff.read(cx);
            diff.ready && diff.document.head.len() == 40 && !diff.document.files.is_empty()
        }),
        "the existing commit route must return a real revision, not just an empty viewer"
    );
    activity_click(&mut visual, "diff-file-0");
    activity_click(&mut visual, "activity-commit-back");
    assert!(visual.debug_bounds("activity-filter-commit").is_some());
    assert!(view.read_with(&visual, |v, _| v.filter == "commit" && v.expanded.is_some()));
}
