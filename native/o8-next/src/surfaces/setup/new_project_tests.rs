//! New project and no-project threads through the production setup routes.
use super::click;
use crate::shell::test_support::*;
use crate::shell::*;

fn page(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Option<&'static str> {
    shell.read_with(cx, |s, cx| {
        s.surfaces
            .setup
            .view
            .as_ref()
            .and_then(|v| v.read(cx).painted_page())
    })
}
fn error(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Option<String> {
    shell.read_with(cx, |s, cx| {
        s.surfaces
            .setup
            .view
            .as_ref()
            .and_then(|v| v.read(cx).error().map(str::to_owned))
    })
}
fn active_session(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Session {
    shell.read_with(cx, |s, _| {
        let Some(Tab::Session(id)) = s.active() else {
            panic!("setup must open a conversation");
        };
        s.sessions
            .iter()
            .find(|session| session.id == id)
            .unwrap()
            .clone()
    })
}
/// Tools become available on the fixture's second refresh.
fn connect_tools(cx: &mut VisualTestContext) {
    click(cx, "setup-refresh");
    click(cx, "setup-refresh");
    click(cx, "setup-lead-codex");
    click(cx, "setup-use");
}

#[gpui::test]
fn setup_new_project_states_create_register_and_open(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--onboarding --onboarding-new-project --transcript");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("new-project.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    click(cx, "setup-new-project");
    assert_eq!(page(&shell, cx), Some("new-project"));
    assert!(cx.debug_bounds("setup-new-project-form").is_some());

    // Empty name: Create explains instead of calling gh.
    click(cx, "setup-create");
    assert_eq!(
        error(&shell, cx).as_deref(),
        Some("Name the new repository.")
    );

    // A saved machine is listed but cannot be chosen yet; this machine can.
    click(cx, "setup-machine-00000000-0000-4000-8000-000000000001");
    assert!(error(&shell, cx).is_some_and(|e| e.contains("another machine")));
    click(cx, "setup-machine-local");
    assert_eq!(error(&shell, cx), None);

    // gh's own refusal shows inline and the page stays open.
    click(cx, "setup-new-project-name");
    cx.simulate_input("taken-name");
    click(cx, "setup-visibility-public");
    click(cx, "setup-create");
    let refused = error(&shell, cx).expect("gh error shown inline");
    assert!(
        refused.contains("Name already exists on this account"),
        "{refused}"
    );
    assert_eq!(page(&shell, cx), Some("new-project"));
    let registered: Value = fixture.client.get("/api/panel/repos", &[]).unwrap();
    assert!(!registered.to_string().contains("taken-name"));

    click(cx, "setup-cancel-new-project");
    click(cx, "setup-new-project");
    click(cx, "setup-new-project-name");
    cx.simulate_input("fixture-new-site");
    click(cx, "setup-create");
    let registered: Value = fixture.client.get("/api/panel/repos", &[]).unwrap();
    let created = registered["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|r| {
            r["localPath"]
                .as_str()
                .filter(|p| p.ends_with("/Developer/fixture-new-site"))
        })
        .expect("the created repository is registered from the projects folder")
        .to_owned();
    // A fresh machine still connects tools and answers privacy before the first thread.
    assert_eq!(page(&shell, cx), Some("tools"));
    connect_tools(cx);
    click(cx, "setup-consent");
    assert!(shell.read_with(cx, |s, _| s.surfaces.setup.view.is_none()));
    assert_eq!(
        shell.read_with(cx, |s, _| s.state.selected.clone()),
        Some(created.clone()),
        "the new project opens as the active project"
    );
    assert_eq!(active_session(&shell, cx).repo_path, Some(created));
    assert!(cx.debug_bounds("composer-input").is_some());
}

#[gpui::test]
fn setup_without_project_opens_a_thread_that_sends(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--onboarding --transcript");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("no-project.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    cx.run_until_parked();
    draw(cx);
    click(cx, "setup-change-tools");
    connect_tools(cx);
    assert_eq!(page(&shell, cx), Some("projects"));
    click(cx, "setup-explore");
    click(cx, "setup-consent");
    assert!(shell.read_with(cx, |s, _| s.surfaces.setup.view.is_none()));
    let session = active_session(&shell, cx);
    assert_eq!(session.repo_path, None, "the thread starts with no project");
    assert_eq!(
        shell
            .read_with(cx, |s, _| s.state.selected.clone())
            .as_deref(),
        Some("Unassigned")
    );
    click(cx, "composer-input");
    cx.simulate_input("No project first message");
    cx.simulate_keystrokes("enter");
    cx.run_until_parked();
    draw(cx);
    let queued = fixture.client.queue(&session).unwrap();
    let item = queued["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["payload"]["text"] == "No project first message")
        .expect("a no-project send persists through the production queue");
    assert!(
        item["repoPath"]
            .as_str()
            .is_some_and(|p| p.ends_with(&format!("/thread-scratch/{}", session.id))),
        "the agent runs in the thread's scratch folder: {item}"
    );
    let history: Value = fixture
        .client
        .get("/api/v2/chat-history", &[("tabId", &session.id)])
        .unwrap();
    assert!(
        history["repoPath"].is_null(),
        "the thread keeps no project: {}",
        history["repoPath"]
    );
}
