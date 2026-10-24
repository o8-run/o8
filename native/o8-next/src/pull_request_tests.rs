use super::*;
use gpui::{TestAppContext, VisualTestContext};
use std::{
    io::{BufRead, BufReader, Read},
    process::{Child, Command, Stdio},
    time::Instant,
};

struct Fixture {
    server: Child,
    client: Client,
    workspace: String,
}
impl Fixture {
    fn new() -> Self {
        let mut server = Command::new("node")
            .current_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .args([
                "--import",
                "./scripts/register-server-only-stub.mjs",
                "--import",
                "tsx",
                "scripts/next/pull-request-server.ts",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut reader = BufReader::new(server.stdout.take().unwrap());
        let origin = reader
            .by_ref()
            .lines()
            .find_map(|l| {
                serde_json::from_str::<Value>(&l.ok()?).ok()?["origin"]
                    .as_str()
                    .map(str::to_owned)
            })
            .expect("PR fixture origin");
        std::thread::spawn(move || for _ in reader.lines() {});
        let client =
            Client::authenticated(&origin, Some("fixture-next-pr-operator".into())).unwrap();
        let status: Value = client.get("/api/panel/status", &[]).unwrap();
        let workspace = std::fs::canonicalize(string(&status, "repo"))
            .unwrap()
            .to_string_lossy()
            .into_owned();
        Self {
            server,
            client,
            workspace,
        }
    }
    fn receipts(&self) -> Vec<Value> {
        array(
            &self.client.get::<Value>("/api/panel/status", &[]).unwrap(),
            "receipts",
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-TERM", &self.server.id().to_string()])
            .status();
        let _ = self.server.wait();
    }
}
fn draw(cx: &mut VisualTestContext) {
    cx.update(|w, cx| {
        w.refresh();
        w.draw(cx).clear();
        w.refresh();
        w.draw(cx).clear();
    });
}
fn settle(cx: &mut VisualTestContext) {
    cx.run_until_parked();
    draw(cx);
}
fn click(cx: &mut VisualTestContext, id: &str) {
    draw(cx);
    let b = cx
        .debug_bounds(Box::leak(id.to_owned().into_boxed_str()))
        .unwrap_or_else(|| panic!("missing {id}"));
    cx.simulate_click(b.center(), gpui::Modifiers::default());
    settle(cx);
}
fn input(view: &Entity<PullRequests>, cx: &mut VisualTestContext, text: &str) {
    view.update_in(cx, |s, w, cx| {
        s.editor.update(cx, |e, cx| e.clear(cx));
        s.editor.read(cx).focus.focus(w);
    });
    cx.simulate_input(text);
    draw(cx);
}
fn perform(view: &Entity<PullRequests>, cx: &mut VisualTestContext, action: &str) {
    click(cx, &format!("pr-{action}"));
    assert!(
        view.read_with(cx, |s, _| s.confirmation.is_some()),
        "prepare {action}"
    );
    click(cx, "pr-confirm");
    assert!(
        !view.read_with(cx, |s, _| s.delivery().uncertain),
        "{action} must settle"
    );
}

#[gpui::test]
fn pull_requests_real_server_actions_and_paint(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let start = Instant::now();
    let (view, cx) = cx.add_window_view(|w, cx| {
        PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx)
    });
    settle(cx);
    let open_ms = view.read_with(cx, |s, _| {
        s.ready_painted_at
            .get()
            .unwrap()
            .duration_since(start)
            .as_secs_f64()
            * 1000.
    });
    assert_eq!(view.read_with(cx, |s, _| s.rows.len()), 1);
    click(cx, "pr-more");
    assert_eq!(view.read_with(cx, |s, _| s.rows.len()), 4);
    draw(cx);
    let bounds = cx.debug_bounds("pr-row-7").unwrap();
    let selection_start = Instant::now();
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
    settle(cx);
    let selection_ms = view.read_with(cx, |s, _| {
        s.painted_at
            .get()
            .unwrap()
            .duration_since(selection_start)
            .as_secs_f64()
            * 1000.
    });
    assert_eq!(
        view.read_with(cx, |s, _| s.detail["number"].as_u64()),
        Some(7)
    );
    let mut interactions = vec![];
    for tab in ["summary", "changes", "checks", "reviews"]
        .into_iter()
        .cycle()
        .take(20)
    {
        draw(cx);
        let bounds = cx
            .debug_bounds(Box::leak(format!("pr-tab-{tab}").into_boxed_str()))
            .unwrap();
        let start = Instant::now();
        cx.simulate_click(bounds.center(), gpui::Modifiers::default());
        settle(cx);
        interactions.push(view.read_with(cx, |s, _| {
            s.painted_at
                .get()
                .unwrap()
                .duration_since(start)
                .as_secs_f64()
                * 1000.
        }));
        view.read_with(cx, |s, _| assert_eq!(s.painted.get(), s.revision));
    }
    for id in ["pr-link", "pr-number", "pr-checkout", "pr-open"] {
        click(cx, id);
    }
    input(&view, cx, "Fixture feedback");
    perform(&view, cx, "comment");
    input(&view, cx, "Fixture review");
    perform(&view, cx, "review-comment");
    perform(&view, cx, "approve");
    input(&view, cx, "Please add coverage");
    perform(&view, cx, "request-changes");
    perform(&view, cx, "draft");
    assert!(view.read_with(cx, |s, _| s.detail["draft"] == true));
    click(cx, "pr-merge-squash");
    assert!(view.read_with(cx, |s, _| s.confirmation.is_none()));
    perform(&view, cx, "ready");
    perform(&view, cx, "enable-auto-merge");
    perform(&view, cx, "disable-auto-merge");
    click(cx, "pr-merge-rebase");
    assert!(view.read_with(cx, |s, _| s.confirmation.is_none()));
    click(cx, "pr-merge-squash");
    click(cx, "pr-cancel");
    assert!(view.read_with(cx, |s, _| s.confirmation.is_none()));
    perform(&view, cx, "merge-squash");
    assert!(view.read_with(cx, |s, _| !s.detail["mergedAt"].is_null()));
    click(cx, "pr-detail-close");
    click(cx, "pr-more");
    click(cx, "pr-row-8");
    perform(&view, cx, "close");
    let bodies: Vec<_> = fixture
        .receipts()
        .into_iter()
        .filter(|r| r["method"] == "POST")
        .map(|r| r["body"].clone())
        .collect();
    for action in [
        "comment",
        "review-comment",
        "approve",
        "request-changes",
        "draft",
        "ready",
        "enable-auto-merge",
        "disable-auto-merge",
        "merge",
        "close",
    ] {
        assert!(
            bodies.iter().any(|b| b["action"] == action),
            "server receipt {action}"
        );
    }
    for b in &bodies {
        assert_eq!(b["repo"], "example/repo");
        assert_eq!(b["commitSha"], "a".repeat(40));
    }
    let receipt = json!({"endpoint":"Linux headless GPUI CPU scene paint; no font shaping, GPU or compositor", "openToFirstFrameMs":open_ms,"detailSelectionToFrameMs":selection_ms,"interactionToFrameMs":interactions});
    if let Ok(file) = std::env::var("O8_NEXT_PR_RESULTS") {
        std::fs::write(file, serde_json::to_vec_pretty(&receipt).unwrap()).unwrap();
    }
    println!("PR_MEASUREMENT {receipt}");
}

#[gpui::test]
fn pull_requests_uncertain_delivery_and_partial_close(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (view, cx) = cx.add_window_view(|w, cx| {
        PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx)
    });
    settle(cx);
    click(cx, "pr-row-7");
    input(&view, cx, "Fixture lose response");
    click(cx, "pr-comment");
    click(cx, "pr-confirm");
    assert!(view.read_with(cx, |s, _| s.delivery().uncertain));
    let count = fixture
        .receipts()
        .iter()
        .filter(|r| r["method"] == "POST")
        .count();
    click(cx, "pr-comment");
    click(cx, "pr-merge-squash");
    assert_eq!(
        fixture
            .receipts()
            .iter()
            .filter(|r| r["method"] == "POST")
            .count(),
        count
    );
    click(cx, "pr-detail-close");
    click(cx, "pr-row-7");
    assert!(view.read_with(cx, |s, _| s.delivery().uncertain));
    click(cx, "pr-acknowledge");
    assert!(!view.read_with(cx, |s, _| s.delivery().uncertain));
    input(&view, cx, "Fixture partial close");
    perform(&view, cx, "close-with-comment");
    assert!(view.read_with(cx, |s, _| s.delivery().partial_close));
    click(cx, "pr-comment");
    assert!(view.read_with(cx, |s, _| s.confirmation.is_none()));
    perform(&view, cx, "retry-close");
    let comments: Value = fixture
        .client
        .get("/api/panel/prs/7", &[("repo", "example/repo")])
        .unwrap();
    assert_eq!(
        array(&comments["pr"], "issueComments")
            .iter()
            .filter(|c| c["body"] == "Fixture partial close")
            .count(),
        1
    );
}

#[gpui::test]
fn pull_requests_filters_empty_retry_and_server_merge_refusal(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (view, cx) = cx.add_window_view(|w, cx| {
        PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx)
    });
    settle(cx);
    for id in [
        "pr-filter-author",
        "pr-filter-label",
        "pr-filter-baseRefName",
        "pr-filter-draft",
        "pr-filter-checks",
        "pr-scope",
        "pr-layout",
        "pr-sort",
        "pr-state",
        "pr-refresh",
    ] {
        click(cx, id);
    }
    view.update_in(cx, |s, w, cx| {
        s.search.read(cx).focus.focus(w);
    });
    cx.simulate_input("no-match");
    draw(cx);
    assert_eq!(view.read_with(cx, |s, cx| s.visible(cx).len()), 0);
    // Reset through the same page-selection path, then pin a stale confirmation.
    view.update(cx, |s, cx| {
        s.search.update(cx, |e, cx| e.clear(cx));
        s.filters.clear();
        s.scope = "all".into();
        s.state = "open".into();
        s.load(false, cx);
    });
    settle(cx);
    click(cx, "pr-row-7");
    click(cx, "pr-merge-squash");
    fixture
        .client
        .pr_post(
            "/api/panel/prs/7",
            &json!({"repo":"example/repo","action":"comment","comment":"Fixture advance head"}),
        )
        .unwrap();
    click(cx, "pr-confirm");
    assert!(view.read_with(cx, |s, _| s.delivery().uncertain));
    assert!(view.read_with(cx, |s, _| s.detail["mergedAt"].is_null()));
    click(cx, "pr-acknowledge");
    assert_eq!(
        view.read_with(cx, |s, _| string(&s.detail, "headSha").to_owned()),
        "d".repeat(40)
    );
    perform(&view, cx, "merge-merge");
}

#[gpui::test]
fn pull_requests_linked_packet_preview_refuses_merge(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (view, cx) = cx.add_window_view(|w, cx| {
        PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx)
    });
    settle(cx);
    click(cx, "pr-more");
    click(cx, "pr-row-8");
    assert_eq!(
        view.read_with(cx, |s, _| s.packet.clone()),
        Some("next-pr-unwired".into())
    );
    assert!(view.read_with(cx, |s, _| s.preview["unwired"] == true));
    assert_eq!(
        view.read_with(cx, |s, _| array(&s.preview, "checks").len()),
        7
    );
    click(cx, "pr-tab-checks");
    click(cx, "pr-merge-squash");
    assert!(view.read_with(cx, |s, _| s.confirmation.is_none()));
    assert!(!fixture.receipts().iter().any(|r| r["method"] == "POST"));
    // A contract fixture for the client-only refusal: even a passing preview
    // cannot authorize a GitHub merge through the separate packet protocol.
    view.update(cx, |s, cx| {
        s.preview =
            json!({"packetId":"next-pr-unwired","wouldMerge":true,"checks":[],"blockers":[]});
        s.changed(cx);
    });
    click(cx, "pr-merge-squash");
    assert!(
        view.read_with(cx, |s, _| s.confirmation.is_none()),
        "a passing preview cannot bypass the governed packet merge path"
    );
    assert!(!fixture.receipts().iter().any(|r| r["method"] == "POST"));
}

#[gpui::test]
fn pull_requests_loading_error_retry_and_unavailable(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (view, cx) = cx.add_window_view(|w, cx| {
        let surface = PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx);
        assert!(surface.loading);
        surface
    });
    settle(cx);
    click(cx, "pr-state");
    assert!(
        view.read_with(cx, |s, _| !s.error.is_empty()),
        "closed-page fixture refusal must expose Retry"
    );
    click(cx, "pr-retry");
    assert!(view.read_with(cx, |s, _| s.error.is_empty() && s.rows.is_empty()));
    view.update(cx, |s, cx| {
        s.workspace = std::env::temp_dir().to_string_lossy().into_owned();
        s.load(false, cx);
    });
    settle(cx);
    assert!(view.read_with(cx, |s, _| s.page["unavailable"] == true));
}

#[gpui::test]
fn pull_requests_repository_change_invalidates_old_detail(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (view, cx) = cx.add_window_view(|w, cx| {
        PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx)
    });
    settle(cx);
    click(cx, "pr-row-7");
    input(&view, cx, "Frozen comment");
    click(cx, "pr-comment");
    assert!(view.read_with(cx, |s, _| s.confirmation.is_some()));
    assert!(
        Command::new("git")
            .args([
                "-C",
                &fixture.workspace,
                "remote",
                "set-url",
                "origin",
                "https://github.com/example/other.git"
            ])
            .status()
            .unwrap()
            .success()
    );
    click(cx, "pr-refresh");
    assert!(
        view.read_with(cx, |s, _| s.selected.is_none()),
        "a changed list repository must invalidate the previous detail"
    );
    assert!(!fixture.receipts().iter().any(|r| r["method"] == "POST"));
}

#[gpui::test]
fn pull_requests_structured_preview_refusal_and_rebase(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (view, cx) = cx.add_window_view(|w, cx| {
        PullRequests::new(fixture.client.clone(), fixture.workspace.clone(), w, cx)
    });
    settle(cx);
    click(cx, "pr-more");
    click(cx, "pr-row-9");
    assert!(
        view.read_with(cx, |s, _| s.governance_error.is_empty()),
        "structured preview refusal must retain gate details"
    );
    assert!(view.read_with(cx, |s, _| {
        array(&s.preview, "blockers").contains(&json!("worktree-branch"))
    }));
    click(cx, "pr-merge-squash");
    assert!(view.read_with(cx, |s, _| s.confirmation.is_none()));
    click(cx, "pr-row-10");
    perform(&view, cx, "merge-rebase");
    assert!(
        fixture
            .receipts()
            .iter()
            .any(|r| r["body"]["action"] == "merge" && r["body"]["mergeMethod"] == "rebase")
    );
}
