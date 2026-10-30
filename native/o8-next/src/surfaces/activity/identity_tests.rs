//! Repository identity matrix through real Git/registry routes and headless GPUI.
use super::tests::{activity_click, activity_open, activity_scope, activity_view};
use super::*;
use crate::shell::test_support::*;

fn check_identity_matrix(cx: &mut TestAppContext, option: &str, count: usize) {
    let fixture = Fixture::start_mode(false, option);
    let topology = fixture
        .client
        .activity_request("GET", "/api/activity-fixture", &[], None)
        .unwrap();
    let repos = topology["identityRepos"].as_array().unwrap();
    assert_eq!(repos.len(), 2, "Two real repository opens are required");
    assert_eq!(repos[0]["sha"], repos[1]["sha"]);
    if option.contains("same-repo") {
        assert_eq!(
            repos[0]["id"], repos[1]["id"],
            "Canonical aliases register once"
        );
    } else {
        assert_ne!(repos[0]["id"], repos[1]["id"]);
    }
    assert_eq!(
        repos[0]["commonDir"] == repos[1]["commonDir"],
        option.contains("worktrees") || option.contains("same-repo")
    );
    let (shell, mut visual, _) = activity_open(&fixture, cx);
    activity_scope(&mut visual, "activity-scope-all");
    activity_click(&mut visual, "activity-filter-commit");
    let view = activity_view(&shell, &mut visual);
    let rows = view.read_with(&visual, |view, _| {
        view.rows
            .iter()
            .filter(|row| row.kind == "commit")
            .cloned()
            .collect::<Vec<_>>()
    });
    assert_eq!(
        rows.len(),
        count,
        "Distinct roots survive; repeated opens deduplicate"
    );
    assert!(rows.iter().all(|row| row.id == rows[0].id));
    let mut failures = Vec::new();
    let mut check = |ok: bool, message: String| {
        if !ok {
            failures.push(message);
        }
    };
    let ids = rows
        .iter()
        .map(feed::Row::selector)
        .collect::<std::collections::BTreeSet<_>>();
    check(ids.len() == count, "row control IDs collide".into());
    for (index, row) in rows.iter().enumerate() {
        // GPUI requires a static debug selector; this test owns at most two.
        let selector = Box::leak(row.selector().into_boxed_str());
        let bounds = visual
            .debug_bounds(selector)
            .expect("painted commit control");
        visual.simulate_click(bounds.center(), gpui::Modifiers::default());
        visual.run_until_parked();
        draw(&mut visual);
        check(
            view.read_with(&visual, |v, _| v.expanded.as_ref() == Some(&row.key())),
            format!("row {index}: click did not expand selected row"),
        );
        check(
            view.read_with(&visual, |v, _| v.keyboard.as_ref() == Some(&row.selector())),
            format!("row {index}: click did not select its keyboard control"),
        );
        check(
            view.read_with(&visual, |v, _| {
                rows.iter().filter(|r| Some(r.key()) == v.expanded).count() == 1
            }),
            format!("row {index}: click expanded more than one row"),
        );
        visual.simulate_keystrokes("enter");
        draw(&mut visual);
        check(
            view.read_with(&visual, |v, _| v.expanded.is_none()),
            format!("row {index}: Enter did not collapse clicked row"),
        );
        visual.simulate_keystrokes("escape");
        draw(&mut visual);
    }
    // Traverse one full Tab cycle. Duplicate IDs resolve to the first matching
    // control and trap traversal before the following row/mission controls.
    let controls = view.read_with(&visual, |v, _| v.controls.clone());
    for (index, (id, action)) in controls.iter().enumerate() {
        visual.simulate_keystrokes("tab");
        draw(&mut visual);
        check(
            view.read_with(&visual, |v, _| v.keyboard.as_ref() == Some(id)),
            format!("Tab did not reach control {index}"),
        );
        if let pane::Action::Expand(row) = action {
            visual.simulate_keystrokes("enter");
            draw(&mut visual);
            check(
                view.read_with(&visual, |v, _| {
                    v.expanded.as_ref() == Some(&row.key())
                        && rows.iter().filter(|r| Some(r.key()) == v.expanded).count() == 1
                }),
                format!("row {index}: Tab/Enter did not expand exactly one row"),
            );
            visual.simulate_keystrokes("space");
            draw(&mut visual);
            check(
                view.read_with(&visual, |v, _| v.expanded.is_none()),
                format!("row {index}: Space did not retain selected row"),
            );
        }
    }
    visual.simulate_keystrokes("tab");
    draw(&mut visual);
    check(
        view.read_with(&visual, |v, _| v.keyboard.as_ref() == Some(&controls[0].0)),
        "Tab focus is trapped instead of wrapping to the first control".into(),
    );
    activity_click(&mut visual, "activity-refresh");
    let refreshed = view.read_with(&visual, |v, _| {
        v.rows
            .iter()
            .filter(|r| r.kind == "commit")
            .map(feed::Row::selector)
            .collect::<std::collections::BTreeSet<_>>()
    });
    check(refreshed == ids, "Refresh changed stable row IDs".into());
    assert!(failures.is_empty(), "{option}:\n{}", failures.join("\n"));
    println!(
        "identity matrix: {option}: {count} row(s); click/select, expand, Tab cycle, Enter/Space and refresh PASS"
    );
}

#[gpui::test]
fn activity_identity_matrix_remote_forks(cx: &mut TestAppContext) {
    check_identity_matrix(cx, "--activity --activity-forks", 2);
}
#[gpui::test]
fn activity_identity_matrix_local_clones(cx: &mut TestAppContext) {
    check_identity_matrix(cx, "--activity --activity-local-clones", 2);
}
#[gpui::test]
fn activity_identity_matrix_linked_worktrees(cx: &mut TestAppContext) {
    check_identity_matrix(cx, "--activity --activity-worktrees", 2);
}
#[gpui::test]
fn activity_identity_matrix_same_repository_twice(cx: &mut TestAppContext) {
    check_identity_matrix(cx, "--activity --activity-same-repo", 1);
}
