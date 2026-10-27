//! Full shell -> virtual native list -> production HTTP -> persisted record.
use super::*;
use crate::shell::test_support::*;
use gpui::{ScrollDelta, ScrollStrategy, ScrollWheelEvent};
use std::io::Write;

#[gpui::test]
fn sidebar_bootstrap_keeps_registered_active_workspace(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--shell --composer");
    fixture
        .client
        .project_request(
            "POST",
            "/api/projects",
            &json!({"name":"Active fixture","slug":"active-fixture"}),
        )
        .unwrap();
    let projects: Value = fixture.client.get("/api/projects", &[]).unwrap();
    let project = projects["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["slug"] == "active-fixture")
        .unwrap();
    let repo = fixture
        .client
        .project_request(
            "POST",
            "/api/panel/repos",
            &json!({"action":"add","localPath":fixture.folders[0]}),
        )
        .unwrap();
    fixture
        .client
        .project_request(
            "POST",
            &format!("/api/projects/{}/repos", project["id"].as_str().unwrap()),
            &json!({"repoId":repo["repo"]["id"]}),
        )
        .unwrap();
    fixture
        .client
        .project_request(
            "POST",
            "/api/panel/projects/active",
            &json!({"projectId":project["id"]}),
        )
        .unwrap();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("catalog.json"),
        State::default(),
        cx,
    );
    wait_for(&shell, &mut visual, |s, _| s.connected);
    shell.read_with(&visual, |s, _| {
        assert!(
            s.workspaces
                .iter()
                .any(|path| crate::client::same_workspace(path, &fixture.folders[0])),
            "sidebar bootstrap must retain registered repositories without chats"
        );
        assert!(
            s.state
                .selected
                .as_ref()
                .is_some_and(|path| crate::client::same_workspace(path, &fixture.folders[0])),
            "the active project must retain its workspace at startup"
        );
        assert!(
            s.sessions
                .iter()
                .any(|session| session.id == "thoughts-composer-first"),
            "saved chats in other workspaces remain available"
        );
    });
}

#[gpui::test]
fn sidebar_selection_leaves_projects_and_settings(cx: &mut TestAppContext) {
    let fixture = Fixture::with_options(&["--sidebar", "--settings"]);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("panels.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    settle(&shell, cx);
    let selected = shell.read_with(cx, |s, cx| {
        s.surfaces.sidebar.view.as_ref().unwrap().read(cx).rows[2]
            .id
            .clone()
            .unwrap()
    });
    for (button, panel) in [
        ("shell-settings", "settings-page"),
        ("shell-projects", "project-new"),
    ] {
        click(cx, button);
        settle(&shell, cx);
        assert!(cx.debug_bounds(panel).is_some());
        click(cx, "thread-row-2");
        settle(&shell, cx);
        assert!(
            shell.read_with(cx, |s, _| s.surfaces.settings.view.is_none()
                && !s.surfaces.projects.open),
            "selecting a thread must display its session surface"
        );
        assert_eq!(active_id(&shell, cx), selected);
    }
}

#[test]
fn sidebar_message_between_pages_keeps_every_thread() {
    let fixture = Fixture::with_options(&["--sidebar", "--sidebar-paging-message"]);
    let sessions = fixture
        .client
        .sidebar_sessions()
        .expect("an incoming message between pages must not fail sidebar discovery");
    let desktop: Value = fixture
        .client
        .get("/api/v2/chat-history/list", &[("include", "orchestrator")])
        .unwrap();
    let expected: std::collections::BTreeSet<_> = desktop["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row["tabId"].as_str())
        .filter(|id| id.starts_with("thoughts-sidebar-"))
        .collect();
    let actual: Vec<_> = sessions
        .iter()
        .filter(|row| row.id.starts_with("thoughts-sidebar-"))
        .collect();
    assert_eq!(expected.len(), 2000);
    assert_eq!(
        actual.len(),
        2000,
        "offset overlap must not skip a later row"
    );
    assert_eq!(
        actual
            .iter()
            .map(|row| row.id.as_str())
            .collect::<std::collections::BTreeSet<_>>(),
        expected,
        "the paged native list must retain every desktop record exactly once"
    );
    assert_eq!(actual[0].id, "thoughts-sidebar-0001");
    assert_eq!(actual[0].status, "running");
    assert_eq!(actual[0].message_count, 3);
    let persisted: Value = fixture
        .client
        .get(
            "/api/v2/chat-history",
            &[("tabId", "thoughts-sidebar-0001")],
        )
        .unwrap();
    assert!(
        persisted["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == "paging-live-user")
    );
}

#[test]
fn sidebar_repeated_full_page_retains_available_threads() {
    let fixture = Fixture::with_options(&["--sidebar", "--sidebar-repeat-page"]);
    let sessions = fixture
        .client
        .sidebar_sessions()
        .expect("a repeated page must keep the sidebar available");
    assert_eq!(
        sessions
            .iter()
            .filter(|row| row.id.starts_with("thoughts-sidebar-"))
            .count(),
        500
    );
    let unique: std::collections::BTreeSet<_> = sessions.iter().map(|row| &row.id).collect();
    assert_eq!(
        unique.len(),
        sessions.len(),
        "bounded repeated-page fallback must deduplicate records"
    );
}

fn oracle(fixture: &Fixture) -> Value {
    let output = Process::new("node")
        .current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .args([
            "--import",
            "./scripts/register-server-only-stub.mjs",
            "--import",
            "tsx",
            "scripts/next/sidebar-oracle.ts",
            &fixture.origin,
        ])
        .env("O8_NEXT_API_TOKEN", "fixture-shell-bearer")
        .output()
        .unwrap();
    assert!(output.status.success(), "desktop route oracle");
    serde_json::from_slice(&output.stdout).unwrap()
}
fn settle(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    for _ in 0..5 {
        cx.run_until_parked();
        shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
        draw(cx);
    }
}
fn click(cx: &mut VisualTestContext, selector: &'static str) {
    draw(cx);
    if selector == "thread-archive" || selector == "thread-rename" {
        let sidebar = cx.debug_bounds("thread-list").unwrap();
        cx.simulate_mouse_move(sidebar.center(), None, gpui::Modifiers::default());
        draw(cx);
    }
    let bounds = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("missing {selector}"));
    cx.simulate_click(bounds.center(), gpui::Modifiers::default());
}
#[track_caller]
fn wait_for(
    shell: &Entity<Shell>,
    cx: &mut VisualTestContext,
    predicate: impl Fn(&Shell, &App) -> bool,
) {
    let started = Instant::now();
    loop {
        settle(shell, cx);
        if shell.read_with(cx, |s, cx| predicate(s, cx)) {
            return;
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "native event and HTTP result must become visible: {}",
            shell.read_with(cx, |s, cx| s
                .surfaces
                .sidebar
                .view
                .as_ref()
                .unwrap()
                .read(cx)
                .diagnostic())
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
fn active_id(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> String {
    shell.read_with(cx, |s, cx| {
        match s.content.get(&s.key(&s.active().unwrap())).unwrap() {
            Content::Session(surface) => surface.read(cx).shell_selected(),
            _ => panic!("session surface"),
        }
    })
}
fn assert_oracle(shell: &Entity<Shell>, cx: &VisualTestContext, expected: Value) {
    let sessions = shell.read_with(cx, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .sessions
            .clone()
    });
    let expected: Vec<_> = expected
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["kind"] == "thread")
        .collect();
    assert_eq!(
        sessions.len(),
        expected.len(),
        "retain every desktop route record, including disclosed groups"
    );
    for row in expected {
        let session = sessions
            .iter()
            .find(|s| row["id"] == s.id)
            .expect("desktop record must remain available");
        assert_eq!(row["title"], session.title);
        assert_eq!(row["status"], session.status);
        assert_eq!(
            row["workspace"],
            session.repo_path.as_deref().unwrap_or("Unassigned")
        );
    }
}

#[gpui::test]
fn sidebar_group_order_search_keyboard_rename_archive_and_live_events(cx: &mut TestAppContext) {
    let fixture = Fixture::with_sidebar(true);
    let expected = oracle(&fixture);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("interactions.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    assert_oracle(&shell, cx, expected);
    // Search uses the production editor's Unicode/IME and text input contract.
    cx.simulate_keystrokes("ctrl-f");
    cx.simulate_input("Sidebar thread 1999");
    settle(&shell, cx);
    shell.read_with(cx, |s, cx| {
        assert_eq!(
            s.surfaces
                .sidebar
                .view
                .as_ref()
                .unwrap()
                .read(cx)
                .rows
                .iter()
                .filter(|r| r.id.is_some())
                .count(),
            1
        )
    });
    cx.simulate_keystrokes("f8");
    draw(cx);
    cx.simulate_keystrokes("home enter");
    ready(&shell, cx);
    assert_eq!(active_id(&shell, cx), "thoughts-sidebar-1999");
    cx.simulate_keystrokes("escape f8 f2");
    cx.simulate_input("Renamed native 界");
    cx.simulate_keystrokes("enter");
    wait_for(&shell, cx, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .sessions
            .iter()
            .any(|r| r.id == "thoughts-sidebar-1999" && r.title == "Renamed native 界")
    });
    let record: Value = fixture
        .client
        .get(
            "/api/v2/chat-history",
            &[("tabId", "thoughts-sidebar-1999")],
        )
        .unwrap();
    assert_eq!(record["title"], "Renamed native 界");
    assert_eq!(
        record["messages"].as_array().unwrap().len(),
        2,
        "rename preserves transcript records"
    );
    cx.simulate_keystrokes("f8");
    draw(cx);
    cx.simulate_keystrokes("delete");
    wait_for(&shell, cx, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .sessions
            .iter()
            .any(|r| r.id == "thoughts-sidebar-1999" && r.status == "archived")
    });
    let archived: Value = fixture
        .client
        .get(
            "/api/v2/chat-history",
            &[("tabId", "thoughts-sidebar-1999")],
        )
        .unwrap();
    assert!(archived["archivedAt"].as_str().is_some());
    assert_oracle(&shell, cx, oracle(&fixture));
    // A second client writes through the same API; only a real socket event
    // can make the native list observe it before the five-minute fallback.
    fixture
        .client
        .patch_thread(
            "thoughts-sidebar-1998",
            json!({"title":"Changed by desktop"}),
        )
        .unwrap();
    wait_for(&shell, cx, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .sessions
            .iter()
            .any(|r| r.id == "thoughts-sidebar-1998" && r.title == "Changed by desktop")
    });
    let live_id = "thoughts-sidebar-0014";
    let live_record: Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", live_id)])
        .unwrap();
    let agent = ureq::AgentBuilder::new()
        .try_proxy_from_env(false)
        .redirects(0)
        .build();
    let write_turn = |role: &str, timestamp: u64| {
        let response = agent.post(&format!("{}/api/v2/chat-history", fixture.origin))
            .set("Authorization", "Bearer fixture-shell-bearer")
            .send_json(json!({"tabId":live_id,"repoPath":live_record["repoPath"],"messages":[{
                "id":format!("live-{role}"),"role":role,"content":"Live state fixture","timestamp":timestamp
            }]})).unwrap();
        assert_eq!(response.status(), 200);
    };
    write_turn("user", 1791000000000);
    wait_for(&shell, cx, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .rows
            .iter()
            .any(|r| r.id.as_deref() == Some(live_id) && r.running && r.unread)
    });
    write_turn("assistant", 1791000000001);
    wait_for(&shell, cx, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .rows
            .iter()
            .any(|r| {
                r.id.as_deref() == Some(live_id) && r.status == "ready" && !r.running && r.unread
            })
    });
    // Original worker key opens its persisted worker history in the same Surface.
    cx.simulate_keystrokes("ctrl-f");
    cx.simulate_input("Grid runtime worker");
    settle(&shell, cx);
    let row = shell.read_with(cx, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .rows
            .iter()
            .position(|r| r.id.as_deref() == Some("pi-builtin-owned:grid-runtime"))
            .unwrap()
    });
    assert_eq!(row, 2);
    click(cx, "thread-row-2");
    ready(&shell, cx);
    assert_eq!(active_id(&shell, cx), "pi-builtin-owned:grid-runtime");
    cx.simulate_keystrokes("f8");
    draw(cx);
    cx.simulate_keystrokes("escape");
    draw(cx);
    cx.simulate_keystrokes("home down enter");
    ready(&shell, cx);
    assert_ne!(active_id(&shell, cx), "pi-builtin-owned:grid-runtime");
}

#[gpui::test]
fn sidebar_search_matches_desktop_message_text_route(cx: &mut TestAppContext) {
    let fixture = Fixture::with_sidebar(true);
    let desktop: Value = fixture
        .client
        .get(
            "/api/v2/chat-history/list",
            &[
                ("include", "orchestrator"),
                ("archived", "include"),
                ("q", "Fixture question"),
            ],
        )
        .unwrap();
    let expected: std::collections::BTreeSet<_> = desktop["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row["tabId"].as_str().map(str::to_owned))
        .filter(|id| id.starts_with("thoughts-sidebar-"))
        .collect();
    assert_eq!(expected.len(), 2000);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("message-search.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    cx.simulate_keystrokes("ctrl-f");
    cx.simulate_input("Fixture question");
    wait_for(&shell, cx, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .rows
            .iter()
            .filter(|row| row.id.is_some())
            .count()
            == expected.len()
    });
    let actual: std::collections::BTreeSet<_> = shell.read_with(cx, |s, cx| {
        s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .rows
            .iter()
            .filter_map(|row| row.id.clone())
            .collect()
    });
    assert_eq!(
        actual, expected,
        "native message search must return the same persisted records as desktop"
    );
}

#[gpui::test]
fn sidebar_unassigned_thread_opens_session(cx: &mut TestAppContext) {
    let fixture = Fixture::with_sidebar(true);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("unassigned.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    cx.simulate_keystrokes("ctrl-f");
    cx.simulate_input("Unassigned fixture chat");
    settle(&shell, cx);
    click(cx, "thread-row-2");
    ready(&shell, cx);
    assert_eq!(active_id(&shell, cx), "thoughts-unassigned");
}

#[gpui::test]
fn sidebar_worker_archive_real_path(cx: &mut TestAppContext) {
    let fixture = Fixture::with_sidebar(true);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("worker-archive.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    cx.simulate_keystrokes("ctrl-f");
    cx.simulate_input("Grid runtime worker");
    settle(&shell, cx);
    click(cx, "thread-row-2");
    ready(&shell, cx);
    // Opening the worker focuses its content. Focus the sidebar through its
    // real shortcut before clicking the footer control hidden outside it.
    cx.simulate_keystrokes("f8");
    settle(&shell, cx);
    click(cx, "thread-archive");
    wait_for(&shell, cx, |s, cx| {
        !s.surfaces
            .sidebar
            .view
            .as_ref()
            .unwrap()
            .read(cx)
            .sessions
            .iter()
            .any(|s| s.id == "pi-builtin-owned:grid-runtime")
    });
    let state: Value = fixture
        .client
        .get(
            "/api/runtime/archive",
            &[("sessionKeys", "pi-builtin-owned:grid-runtime")],
        )
        .unwrap();
    assert_eq!(
        state["states"]["pi-builtin-owned:grid-runtime"], "archived",
        "native worker archive must persist in the desktop runtime store"
    );
}

#[path = "measurement.rs"]
mod measurement;

#[gpui::test]
fn sidebar_real_path_matches_desktop_and_opens_session(cx: &mut TestAppContext) {
    let fixture = Fixture::with_sidebar(true);
    let desktop: Value = fixture
        .client
        .get("/api/v2/chat-history/list", &[("include", "orchestrator")])
        .unwrap();
    let expected = desktop["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| {
            s["tabId"]
                .as_str()
                .unwrap()
                .starts_with("thoughts-sidebar-")
        })
        .count();
    assert_eq!(expected, 2000);
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("sidebar.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    shell.read_with(&visual, |s, _| {
        assert_eq!(
            s.sessions
                .iter()
                .filter(|s| s.id.starts_with("thoughts-sidebar-"))
                .count(),
            expected,
            "native shell must expose every desktop fixture thread rather than the first 500"
        );
    });
    assert!(
        visual.debug_bounds("thread-list").is_some(),
        "native grouped sidebar must be in the app shell"
    );
}

#[gpui::test]
fn sidebar_retained_session_selection_tracks_the_rail(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = fixture.root.join("selected.json");
    let (shell, cx) = cx.add_window_view(|window, cx| {
        Shell::new(
            fixture.client.clone(),
            file.clone(),
            State::default(),
            window,
            cx,
        )
    });
    ready(&shell, cx);
    let before = shell.read_with(cx, |s, _| {
        match s.content.get(&s.key(&s.active().unwrap())).unwrap() {
            Content::Session(session) => session.entity_id(),
            _ => panic!("session"),
        }
    });
    cx.simulate_keystrokes("down");
    cx.run_until_parked();
    shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
    ready(&shell, cx);
    let after = shell.read_with(cx, |s, _| {
        match s.content.get(&s.key(&s.active().unwrap())).unwrap() {
            Content::Session(session) => session.entity_id(),
            _ => panic!("session"),
        }
    });
    assert_eq!(
        before, after,
        "changing the session in the sidebar must retain the existing Surface and its drafts"
    );
    shell.read_with(cx, |s, cx| {
        let Content::Session(surface) = s.content.get(&s.key(&s.active().unwrap())).unwrap() else {
            panic!("session");
        };
        assert_eq!(
            s.surfaces
                .sidebar
                .view
                .as_ref()
                .unwrap()
                .read(cx)
                .selected
                .as_ref(),
            Some(&surface.read(cx).shell_selected()),
            "the shell sidebar selection must follow the retained session surface"
        );
    });
}

impl Fixture {
    fn with_sidebar(sidebar: bool) -> Self {
        Self::with_options(if sidebar { &["--sidebar"] } else { &[] })
    }
    fn with_options(options: &[&str]) -> Self {
        Self::start_mode(false, &options.join(" "))
    }
}

#[path = "project_header_tests.rs"]
mod project_header_tests;

#[path = "project_keyboard_tests.rs"]
mod project_keyboard_tests;

#[path = "project_round2_tests.rs"]
mod project_round2_tests;

#[path = "recents_tests.rs"]
mod recents_tests;
