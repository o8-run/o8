//! Correction-round regressions through the actual shell, editors and HTTP host.
use super::*;

fn worker_state(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Value {
    shell.read_with(cx, |s, cx| {
        match s.content.get(&s.key(&s.active().unwrap())).unwrap() {
            Content::Issues(issues) => issues.read(cx).worker_state(cx),
            _ => Value::Null,
        }
    })
}

#[gpui::test]
fn round1_repository_switch_survives_a_frame_between_mouse_events(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (_, mut visual, _) = open(&fixture, cx);
    let cx = &mut visual;
    click(cx, "issue-new");
    input(cx, "issue-title", "Focused editor draft");
    for index in [1, 0, 1, 0] {
        let (selector, expected, row) = if index == 1 {
            ("issue-repo-1", "fixture/beta", "issue-view-17")
        } else {
            ("issue-repo-0", "fixture/alpha", "issue-view-7")
        };
        wait(cx, selector);
        let center = cx.debug_bounds(selector).unwrap().center();
        cx.simulate_mouse_down(center, gpui::MouseButton::Left, gpui::Modifiers::default());
        draw(cx);
        cx.simulate_mouse_up(center, gpui::MouseButton::Left, gpui::Modifiers::default());
        wait(cx, row);
        assert_eq!(scene(cx)["repo"], expected);
    }
}
fn repository(cx: &mut VisualTestContext, selector: &'static str, slug: &str, issue: &'static str) {
    click(cx, selector);
    wait(cx, issue);
    assert_eq!(scene(cx)["repo"], slug);
}

#[gpui::test]
fn round1_repository_drafts_survive_a_b_a(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (_, mut visual, _) = open(&fixture, cx);
    let cx = &mut visual;
    click(cx, "issue-new");
    input(cx, "issue-title", "Alpha unsent title");
    input(cx, "issue-body", "Alpha unsent body");
    input(cx, "issue-label", "bug");
    cx.simulate_keystrokes("enter");
    draw(cx);
    repository(cx, "issue-repo-1", "fixture/beta", "issue-view-17");
    click(cx, "issue-new");
    input(cx, "issue-title", "Beta unsent title");
    input(cx, "issue-body", "Beta unsent body");
    repository(cx, "issue-repo-0", "fixture/alpha", "issue-view-7");
    click(cx, "issue-new");
    click(cx, "issue-create");
    wait(cx, "issue-created-9");
    let alpha: Value = fixture
        .client
        .get("/api/panel/issues/9", &[("repo", "fixture/alpha")])
        .unwrap();
    assert_eq!(alpha["issue"]["title"], "Alpha unsent title");
    assert_eq!(alpha["issue"]["body"], "Alpha unsent body");
    assert_eq!(alpha["issue"]["labels"][0]["name"], "bug");
    repository(cx, "issue-repo-1", "fixture/beta", "issue-view-17");
    click(cx, "issue-new");
    click(cx, "issue-create");
    wait(cx, "issue-created-9");
    let beta: Value = fixture
        .client
        .get("/api/panel/issues/9", &[("repo", "fixture/beta")])
        .unwrap();
    assert_eq!(beta["issue"]["title"], "Beta unsent title");
    assert_eq!(beta["issue"]["body"], "Beta unsent body");
}

#[gpui::test]
fn round1_timed_out_create_retry_commits_once(cx: &mut TestAppContext) {
    let fixture = Fixture::with_flags(false, &["--issues-delay-create"]);
    let (_, mut visual, _) = open(&fixture, cx);
    let cx = &mut visual;
    click(cx, "issue-new");
    input(cx, "issue-title", "Delayed native creation");
    input(cx, "issue-body", "Committed before delayed answer");
    click(cx, "issue-create");
    wait(cx, "issue-error");
    assert!(
        scene(cx)["error"]
            .as_str()
            .unwrap()
            .contains("selected server")
    );
    input(cx, "issue-title", "Changed while creation is unconfirmed");
    click(cx, "issue-create");
    assert!(scene(cx)["error"].as_str().unwrap().contains("unconfirmed"));
    input(cx, "issue-title", "Delayed native creation");
    click(cx, "issue-create");
    wait(cx, "issue-ready");
    let result: Value = fixture
        .client
        .get(
            "/api/panel/issues",
            &[("repo", "fixture/alpha"), ("fresh", "1")],
        )
        .unwrap();
    let copies = result["issues"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["title"] == "Delayed native creation")
        .count();
    assert_eq!(
        copies, 1,
        "a 6.5-second committed response must not create another GitHub issue after the 5-second client timeout"
    );
    wait(cx, "issue-created-9");
}

#[gpui::test]
fn round1_symlink_worker_survives_real_refresh_and_send(cx: &mut TestAppContext) {
    let fixture = Fixture::with_flags(false, &["--issues-symlink"]);
    let (shell, mut visual, _) = open(&fixture, cx);
    let cx = &mut visual;
    click(cx, "issue-link-7");
    click(cx, "issue-task-composer");
    wait(cx, "issue-worker");
    draw(cx);
    assert_eq!(
        worker_state(&shell, cx)["selected"],
        "thoughts-composer-first"
    );
    let center = cx.debug_bounds("session-refresh").unwrap().center();
    cx.simulate_click(center, gpui::Modifiers::default());
    draw(cx);
    assert_eq!(
        worker_state(&shell, cx)["selected"],
        "thoughts-composer-first",
        "refresh must retain a canonical-equivalent workspace session"
    );
    let center = cx.debug_bounds("composer-input").unwrap().center();
    cx.simulate_click(center, gpui::Modifiers::default());
    cx.simulate_input("Message after alias refresh");
    cx.simulate_keystrokes("enter");
    draw(cx);
    let sessions = fixture.client.sessions().unwrap();
    let worker = sessions
        .iter()
        .find(|s| s.id == "thoughts-composer-first")
        .unwrap();
    let queue = fixture.client.queue(worker).unwrap();
    assert!(
        queue["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["payload"]["text"] == "Message after alias refresh")
    );
}
