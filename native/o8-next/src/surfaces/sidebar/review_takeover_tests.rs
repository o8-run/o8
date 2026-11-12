use super::ThreadList;
use crate::shell::test_support::*;
use crate::shell::{Command, Shell, Tab};
use gpui::{Entity, FocusHandle};
use std::collections::BTreeSet;
use std::time::Duration;

fn setup(cx: &mut TestAppContext) -> (Fixture, Entity<Shell>, VisualTestContext) {
    let fixture = Fixture::start_mode(true, "--shell --composer --sidebar --settings");
    let (shell, mut visual) = open_past_setup(
        fixture.client.clone(),
        fixture.root.join("review-takeover.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    (fixture, shell, visual)
}

struct Retained {
    workspace: Option<String>,
    active: Option<Tab>,
    selected: Option<String>,
    follow: bool,
    focus: Option<FocusHandle>,
}
fn retained(s: &Entity<Shell>, list: &Entity<ThreadList>, v: &mut VisualTestContext) -> Retained {
    let (workspace, active) = s.read_with(v, |s, _| (s.state.selected.clone(), s.active()));
    let (selected, follow) =
        list.read_with(v, |list, _| (list.selected.clone(), list.follow_selection));
    let focus = v.update(|window, cx| window.focused(cx));
    Retained {
        workspace,
        active,
        selected,
        follow,
        focus,
    }
}
fn assert_retained(
    s: &Entity<Shell>,
    list: &Entity<ThreadList>,
    v: &mut VisualTestContext,
    before: &Retained,
) {
    let after = retained(s, list, v);
    assert_eq!(after.workspace, before.workspace, "background project");
    assert_eq!(after.active, before.active, "background active tab");
    assert_eq!(
        after.selected, before.selected,
        "background sidebar selection"
    );
    assert_eq!(after.follow, before.follow, "background follow_selection");
    assert_eq!(after.focus, before.focus, "background keyboard focus");
}
fn list(s: &Entity<Shell>, v: &VisualTestContext) -> Entity<ThreadList> {
    s.read_with(v, |s, _| s.surfaces.sidebar.view.clone().unwrap())
}
fn pending(
    s: &Entity<Shell>,
    list: &Entity<ThreadList>,
    v: &mut VisualTestContext,
    expired: bool,
) -> String {
    let created = s.update(v, |s, _| {
        let scope = s.state.selected.as_ref().unwrap();
        let mut thread = s
            .sessions
            .iter()
            .find(|t| &t.workspace() == scope)
            .unwrap()
            .clone();
        thread.id = "review-delayed-created".into();
        s.sessions.push(thread.clone());
        thread
    });
    let id = created.id.clone();
    list.update(v, |list, _| {
        list.sessions.push(created);
        if expired {
            list.expect_open_since(&id, Instant::now() - Duration::from_secs(46));
        } else {
            list.expect_open(&id);
        }
    });
    id
}
fn deliver(list: &Entity<ThreadList>, v: &mut VisualTestContext) {
    list.update(v, |list, cx| list.open_pending(cx));
    v.run_until_parked();
}
fn displays(s: &Shell, id: &str) -> usize {
    let saved = s.current().unwrap();
    saved
        .tabs
        .iter()
        .filter(|tab| match tab {
            Tab::Session(key) => saved.selections.get(key).unwrap_or(key) == id,
            _ => false,
        })
        .count()
}

#[gpui::test]
fn review_takeover_new_thread_menu_in_other_repo_comes_to_front(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(true, "--shell --composer --sidebar --settings");
    let first: Value = fixture
        .client
        .get(
            "/api/v2/chat-history",
            &[("tabId", "thoughts-composer-first")],
        )
        .unwrap();
    let a = first["repoPath"].as_str().unwrap().to_owned();
    let b = fixture.folders[0].clone();
    let project: Value = fixture
        .client
        .project_request(
            "POST",
            "/api/projects",
            &json!({"name":"Review project","slug":"review-project"}),
        )
        .unwrap();
    let project = project["project"]["id"].as_str().unwrap();
    for path in [&a, &b] {
        let repo: Value = fixture
            .client
            .project_request(
                "POST",
                "/api/panel/repos",
                &json!({"action":"add","localPath":path}),
            )
            .unwrap();
        fixture
            .client
            .project_request(
                "POST",
                &format!("/api/projects/{project}/repos"),
                &json!({"repoId":repo["repo"]["id"]}),
            )
            .unwrap();
    }
    fixture
        .client
        .project_request(
            "POST",
            "/api/panel/projects/active",
            &json!({"projectId":project}),
        )
        .unwrap();
    let (shell, mut visual) = open_past_setup(
        fixture.client.clone(),
        fixture.root.join("other-repo.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    shell.update_in(&mut visual, |s, window, cx| {
        s.switch(a.clone(), window, cx);
        s.execute(
            Command::Session("thoughts-composer-first".into()),
            window,
            cx,
        );
        assert_eq!(s.state.selected.as_ref(), Some(&a));
    });
    ready(&shell, &mut visual);
    let list = list(&shell, &visual);
    list.update(&mut visual, |list, cx| {
        assert!(list.knows_repo(&a) && list.knows_repo(&b));
        list.new_menu = true;
        // The exact action shared by header New thread -> repo B and folder New thread.
        list.new_thread(b.clone(), cx);
        assert!(!list.new_menu);
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let created = loop {
        visual.run_until_parked();
        draw(&mut visual);
        if let Some(id) = shell.read_with(&visual, |s, _| {
            s.sessions
                .iter()
                .find(|t| t.id.starts_with("thoughts-next-") && t.workspace() == b)
                .map(|t| t.id.clone())
        }) {
            break id;
        }
        assert!(
            Instant::now() < deadline,
            "new thread must reach the catalog"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    shell.read_with(&visual, |s, _| {
        assert_eq!(
            s.state.selected.as_ref(),
            Some(&b),
            "uncancelled repo B creation is foreground"
        );
        let saved = s.current().unwrap();
        let Tab::Session(key) = &saved.tabs[saved.active] else {
            panic!("chat")
        };
        assert_eq!(saved.selections.get(key).unwrap_or(key), &created);
    });
}

fn overlay_navigation(cx: &mut TestAppContext, settings: bool) {
    let (_fixture, shell, mut visual) = setup(cx);
    shell.update_in(&mut visual, |s, window, cx| {
        s.open_thread("thoughts-composer-first".into(), window, cx);
    });
    ready(&shell, &mut visual);
    let list = list(&shell, &visual);
    let id = shell.update_in(&mut visual, |s, window, cx| {
        // Start the actual POST and open the overlay before its completion is drained.
        let id = s.start_thread(true, cx).unwrap();
        let command = if settings {
            Command::Settings
        } else {
            Command::Projects
        };
        // Registration calls the shared opener directly, as non-command callers do.
        let registration = command.registration();
        (registration.open)(s, command, window, cx);
        id
    });
    let before = retained(&shell, &list, &mut visual);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        visual.run_until_parked();
        draw(&mut visual);
        if shell.read_with(&visual, |s, _| {
            s.sessions.iter().any(|thread| thread.id == id)
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "new thread must reach the catalog"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_retained(&shell, &list, &mut visual, &before);
    shell.read_with(&visual, |s, _| {
        assert_eq!(displays(s, &id), 1);
        if settings {
            assert!(s.surfaces.settings.view.is_some());
        } else {
            assert!(s.surfaces.projects.open);
        }
    });
}
#[gpui::test]
fn review_takeover_settings_open_revokes_foreground_permission(cx: &mut TestAppContext) {
    overlay_navigation(cx, true);
}
#[gpui::test]
fn review_takeover_projects_open_revokes_foreground_permission(cx: &mut TestAppContext) {
    overlay_navigation(cx, false);
}

#[gpui::test]
fn review_takeover_background_collision_allocates_a_unique_tab(cx: &mut TestAppContext) {
    let (_fixture, shell, mut visual) = setup(cx);
    let list = list(&shell, &visual);
    let target = shell.update_in(&mut visual, |s, window, cx| {
        let Tab::Session(target) = s.active().unwrap() else {
            panic!("chat")
        };
        let mut other = s.sessions.iter().find(|t| t.id == target).unwrap().clone();
        other.id = "review-different-shown-thread".into();
        s.sessions.push(other.clone());
        s.open_thread(other.id, window, cx);
        target
    });
    list.update(&mut visual, |list, _| {
        list.expect_open_since(&target, Instant::now() - Duration::from_secs(46))
    });
    let before = retained(&shell, &list, &mut visual);
    deliver(&list, &mut visual);
    assert_retained(&shell, &list, &mut visual, &before);
    shell.read_with(&visual, |s, _| {
        let tabs = &s.current().unwrap().tabs;
        assert_eq!(tabs.len(), 2);
        let identities: BTreeSet<_> = tabs.iter().map(|t| format!("{t:?}")).collect();
        assert_eq!(
            identities.len(),
            2,
            "background insert never duplicates stable identity"
        );
        assert_eq!(displays(s, &target), 1);
    });
}

#[gpui::test]
fn review_takeover_existing_background_tab_is_reused_even_at_capacity(cx: &mut TestAppContext) {
    let (_fixture, shell, mut visual) = setup(cx);
    let list = list(&shell, &visual);
    let target = pending(&shell, &list, &mut visual, true);
    shell.update(&mut visual, |s, _| {
        let saved = s
            .state
            .workspaces
            .get_mut(s.state.selected.as_ref().unwrap())
            .unwrap();
        let active = saved.tabs[saved.active].clone();
        saved.tabs = vec![active, Tab::Session(target.clone())];
        for i in 2..32 {
            saved.tabs.push(Tab::Session(format!("review-cap-{i}")));
        }
        saved.active = 0;
    });
    let before = retained(&shell, &list, &mut visual);
    deliver(&list, &mut visual);
    assert_retained(&shell, &list, &mut visual, &before);
    shell.read_with(&visual, |s, _| {
        assert_eq!(s.current().unwrap().tabs.len(), 32);
        assert_eq!(displays(s, &target), 1);
    });
}

#[gpui::test]
fn review_takeover_background_capacity_has_feedback_without_focus_change(cx: &mut TestAppContext) {
    let (_fixture, shell, mut visual) = setup(cx);
    let list = list(&shell, &visual);
    let id = pending(&shell, &list, &mut visual, true);
    shell.update(&mut visual, |s, _| {
        let saved = s
            .state
            .workspaces
            .get_mut(s.state.selected.as_ref().unwrap())
            .unwrap();
        let active = saved.tabs[saved.active].clone();
        saved.tabs = vec![active];
        for i in 1..32 {
            saved.tabs.push(Tab::Session(format!("review-full-{i}")));
        }
        saved.active = 0;
    });
    draw(&mut visual);
    assert!(visual.debug_bounds("toast-stack-0").is_none());
    let before = retained(&shell, &list, &mut visual);
    list.update(&mut visual, |list, cx| list.open_pending(cx));
    draw(&mut visual);
    assert!(
        visual.debug_bounds("toast-stack-0").is_some(),
        "capacity must never fail silently"
    );
    assert_retained(&shell, &list, &mut visual, &before);
    shell.read_with(&visual, |s, _| {
        assert_eq!(s.current().unwrap().tabs.len(), 32);
        assert_eq!(displays(s, &id), 0);
    });
}

#[gpui::test]
fn review_takeover_expired_creation_preserves_sidebar_and_focus(cx: &mut TestAppContext) {
    let (_fixture, shell, mut visual) = setup(cx);
    let list = list(&shell, &visual);
    let id = pending(&shell, &list, &mut visual, true);
    let before = retained(&shell, &list, &mut visual);
    deliver(&list, &mut visual);
    assert_retained(&shell, &list, &mut visual, &before);
    shell.read_with(&visual, |s, _| assert_eq!(displays(s, &id), 1));
}
