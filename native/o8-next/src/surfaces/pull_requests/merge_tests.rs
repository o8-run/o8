use super::*;
use std::io::Write;

fn desktop_allowed(detail: &Value) -> bool {
    let mut child = Command::new("node")
        .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .args([
            "--import",
            "./scripts/register-server-only-stub.mjs",
            "--import",
            "tsx",
            "scripts/next/pull-request-desktop-probe.ts",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(json!({"detail":detail}).to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "desktop control probe: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    result["allowed"].as_bool().unwrap()
}

#[gpui::test]
fn pull_requests_native_and_desktop_merge_gates_match(cx: &mut TestAppContext) {
    for (case, expected) in [
        ("checks-failed", false),
        ("checks-pending", false),
        ("checks-neutral", false),
        ("checks-unavailable", false),
        ("review-changes", false),
        ("held", false),
        ("blocked", false),
        ("runtime-live", false),
        ("runtime-unknown", false),
        ("archived-held", false),
        ("explicit-pr-other-branch", false),
        ("fork-collision", true),
        ("review-approved", true),
        ("ready", true),
    ] {
        let fixture = Fixture::new();
        fixture
            .client
            .pr_post("/__fixture/pr-gates", &json!({"scenario":case}))
            .unwrap();
        let (view, visual) = cx.add_window_view(|w, cx| {
            PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx)
        });
        settle(visual);
        click(visual, "pr-row-7");
        let detail = view.read_with(visual, |s, _| s.detail.clone());
        assert!(!detail.is_null(), "{case}: production PR detail must load");
        let native = view.read_with(visual, |s, cx| s.can("merge", "squash", cx));
        let desktop = desktop_allowed(&detail);
        assert_eq!(
            native, desktop,
            "{case}: real native and desktop merge controls must agree on the same payload"
        );
        assert_eq!(native, expected, "{case}: preserve each merge refusal");
    }
}

fn merge_posts(fixture: &Fixture) -> usize {
    fixture
        .receipts()
        .iter()
        .filter(|r| r["method"] == "POST" && r["path"] == "/api/panel/prs/7")
        .count()
}

fn mission_availability(cx: &mut TestAppContext, case: &str, allowed: bool) {
    let fixture = Fixture::new();
    fixture
        .client
        .pr_post("/__fixture/pr-gates", &json!({"scenario":case}))
        .unwrap();
    let (view, visual) = cx.add_window_view(|w, cx| {
        PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx)
    });
    settle(visual);
    click(visual, "pr-row-7");
    choose(visual, "pr-merge-squash");
    if view.read_with(visual, |s, _| s.confirmation.is_some()) {
        click(visual, "pr-confirm");
    }
    assert_eq!(
        merge_posts(&fixture),
        usize::from(allowed),
        "{case}: unavailable state must not be treated as empty; legacy and absent initial state remain usable"
    );
}

#[gpui::test]
fn pull_requests_corrupt_registry_refuses_merge(cx: &mut TestAppContext) {
    mission_availability(cx, "corrupt-registry", false);
}
#[gpui::test]
fn pull_requests_corrupt_review_source_refuses_merge(cx: &mut TestAppContext) {
    mission_availability(cx, "corrupt-review-source", false);
}
#[gpui::test]
fn pull_requests_corrupt_repair_source_refuses_merge(cx: &mut TestAppContext) {
    mission_availability(cx, "corrupt-repair-source", false);
}
#[gpui::test]
fn pull_requests_missing_packet_branch_refuses_merge(cx: &mut TestAppContext) {
    mission_availability(cx, "missing-packet-branch", false);
}
#[gpui::test]
fn pull_requests_corrupt_control_refuses_merge(cx: &mut TestAppContext) {
    mission_availability(cx, "corrupt-control", false);
}
#[gpui::test]
fn pull_requests_invalid_control_shape_refuses_merge(cx: &mut TestAppContext) {
    mission_availability(cx, "invalid-control-shape", false);
}
#[gpui::test]
fn pull_requests_legacy_empty_state_allows_merge(cx: &mut TestAppContext) {
    for case in ["legacy-null", "legacy-empty", "absent-control"] {
        mission_availability(cx, case, true);
    }
}

#[gpui::test]
fn pull_requests_unrelated_unassigned_draft_allows_merge(cx: &mut TestAppContext) {
    mission_availability(cx, "unrelated-draft", true);
}

#[gpui::test]
fn pull_requests_unknown_packet_repository_is_not_absence(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fixture
        .client
        .pr_post(
            "/__fixture/pr-gates",
            &json!({"scenario":"owner-unavailable"}),
        )
        .unwrap();
    let (view, visual) = cx.add_window_view(|w, cx| {
        PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx)
    });
    settle(visual);
    click(visual, "pr-row-7");
    choose(visual, "pr-merge-squash");
    if view.read_with(visual, |s, _| s.confirmation.is_some()) {
        click(visual, "pr-confirm");
    }
    assert_eq!(
        merge_posts(&fixture),
        0,
        "an unavailable held PR owner must not disappear from merge governance"
    );
}

#[gpui::test]
fn pull_requests_incomplete_reviews_cannot_confirm_merge(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (view, visual) = cx.add_window_view(|w, cx| {
        PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx)
    });
    settle(visual);
    click(visual, "pr-row-7");
    choose(visual, "pr-merge-squash");
    assert!(view.read_with(visual, |s, _| s.confirmation.is_some()));
    fixture
        .client
        .pr_post(
            "/__fixture/pr-gates",
            &json!({"scenario":"reviews-incomplete"}),
        )
        .unwrap();
    click(visual, "pr-confirm");
    assert_eq!(
        merge_posts(&fixture),
        0,
        "an incomplete review page cannot prove that requested changes are absent"
    );
}

#[gpui::test]
fn pull_requests_packet_repo_overrides_mission_repo(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    fixture
        .client
        .pr_post("/__fixture/pr-gates", &json!({"scenario":"foreign-repo"}))
        .unwrap();
    let (view, visual) = cx.add_window_view(|w, cx| {
        PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx)
    });
    settle(visual);
    click(visual, "pr-row-7");
    assert!(
        view.read_with(visual, |s, cx| s.can("merge", "squash", cx)),
        "a different repository's PR #7 must not inherit this mission's repository identity"
    );
}

#[gpui::test]
fn pull_requests_confirm_refuses_every_changed_gate(cx: &mut TestAppContext) {
    for case in [
        "checks-failed",
        "checks-pending",
        "checks-changed",
        "checks-unavailable",
        "review-changes",
        "review-approved",
        "reviews-incomplete",
        "base-changed",
        "method-changed",
        "runtime-live",
        "runtime-unknown",
        "provider-unavailable",
    ] {
        let fixture = Fixture::new();
        let (view, visual) = cx.add_window_view(|w, cx| {
            PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx)
        });
        settle(visual);
        click(visual, "pr-row-7");
        input(&view, visual, "Keep these review notes");
        choose(visual, "pr-merge-squash");
        assert!(
            view.read_with(visual, |s, _| s.confirmation.is_some()),
            "{case}: prepare initial merge"
        );
        fixture
            .client
            .pr_post("/__fixture/pr-gates", &json!({"scenario":case}))
            .unwrap();
        click(visual, "pr-confirm");
        assert_eq!(
            merge_posts(&fixture),
            0,
            "{case}: changed gates must refuse before POST"
        );
        assert!(
            !view.read_with(visual, |s, cx| s.delivery(cx).uncertain),
            "{case}: a preflight refusal is not uncertain delivery"
        );
        assert_eq!(
            view.read_with(visual, |s, cx| s.editor.read(cx).text.clone()),
            "Keep these review notes"
        );
    }
}

#[gpui::test]
fn pull_requests_confirm_rereads_new_packet_membership(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (view, visual) = cx.add_window_view(|w, cx| {
        PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx)
    });
    settle(visual);
    click(visual, "pr-row-7");
    choose(visual, "pr-merge-squash");
    assert!(view.read_with(visual, |s, _| s.confirmation.is_some()));
    fixture
        .client
        .pr_post("/__fixture/pr-gates", &json!({"packet":"held"}))
        .unwrap();
    click(visual, "pr-confirm");
    assert_eq!(
        merge_posts(&fixture),
        0,
        "Confirm must re-read packet membership and refuse the newly held packet before POST"
    );
    let detail: Value = fixture
        .client
        .get("/api/panel/prs/7", &[("repo", "example/repo")])
        .unwrap();
    assert!(
        detail["pr"]["mergedAt"].is_null(),
        "the newly held packet must not merge"
    );
}

#[gpui::test]
fn pull_requests_merge_finds_blocked_packet_from_linked_worktree(cx: &mut TestAppContext) {
    for owner_in_worktree in [false, true] {
        let fixture = Fixture::new();
        let result = fixture
            .client
            .pr_post(
                "/__fixture/pr-gates",
                &json!({"packet":"blocked","worktree":true,
            "owner": if owner_in_worktree { "worktree" } else { "primary" }}),
            )
            .unwrap();
        let linked = std::fs::canonicalize(string(&result, "worktree"))
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_ne!(linked, fixture.workspace);
        let workspace = if owner_in_worktree {
            fixture.workspace.clone()
        } else {
            linked
        };
        let (view, visual) =
            cx.add_window_view(|w, cx| PullRequests::new(fixture.client.clone(), workspace, w, cx));
        settle(visual);
        click(visual, "pr-row-7");
        assert_eq!(
            view.read_with(visual, |s, _| s.packet.clone()),
            Some("next-pr-controlled".into()),
            "resolve the actual packet across linked worktrees in either direction"
        );
        choose(visual, "pr-merge-squash");
        if view.read_with(visual, |s, _| s.confirmation.is_some()) {
            click(visual, "pr-confirm");
        }
        assert_eq!(
            merge_posts(&fixture),
            0,
            "a blocked packet in any linked worktree must refuse this repository and PR"
        );
        assert!(!view.read_with(visual, |s, cx| s.can("merge", "squash", cx)));
    }
}
