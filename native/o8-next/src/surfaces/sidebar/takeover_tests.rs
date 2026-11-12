use crate::shell::test_support::*;
use crate::shell::{Command, Tab};

fn late_new_chat_after_navigation(cx: &mut TestAppContext, navigation: &str) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open_past_setup(
        fixture.client.clone(),
        fixture.root.join("late-chat.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    let (created, original_workspace, other) = shell.update(&mut visual, |s, _| {
        let Tab::Session(id) = s.active().unwrap() else {
            panic!("chat")
        };
        let mut created = s
            .sessions
            .iter()
            .find(|session| session.id == id)
            .unwrap()
            .clone();
        created.id = "late-created-thread".into();
        s.sessions.push(created.clone());
        (
            created,
            s.state.selected.clone().unwrap(),
            s.workspaces
                .iter()
                .find(|w| Some(*w) != s.state.selected.as_ref())
                .unwrap()
                .clone(),
        )
    });
    let id = created.id.clone();
    let list = shell.read_with(&visual, |s, _| s.surfaces.sidebar.view.clone().unwrap());
    list.update(&mut visual, |list, _| {
        list.sessions.push(created);
        list.expect_open(&id);
    });
    shell.update_in(&mut visual, |s, window, cx| {
        if navigation == "tab" {
            s.execute(Command::Session("navigation-tab".into()), window, cx);
        } else {
            s.switch(other.clone(), window, cx);
            if navigation == "back" {
                s.switch(original_workspace.clone(), window, cx);
            }
        }
    });
    let expected_workspace = if navigation == "project" {
        other
    } else {
        original_workspace.clone()
    };
    let active = shell.read_with(&visual, |s, _| s.active());
    list.update(&mut visual, |list, cx| list.open_pending(cx));
    visual.run_until_parked();
    assert_eq!(
        shell.read_with(&visual, |s, _| s.state.selected.clone()),
        Some(expected_workspace)
    );
    assert_eq!(shell.read_with(&visual, |s, _| s.active()), active);
    assert!(shell.read_with(&visual, |s, _| {
        s.state.workspaces[&original_workspace]
            .tabs
            .contains(&Tab::Session(id))
    }));
}

#[gpui::test]
fn late_new_chat_after_project_change_stays_in_background(cx: &mut TestAppContext) {
    late_new_chat_after_navigation(cx, "project");
}
#[gpui::test]
fn late_new_chat_after_tab_change_stays_in_background(cx: &mut TestAppContext) {
    late_new_chat_after_navigation(cx, "tab");
}
#[gpui::test]
fn late_new_chat_after_project_change_back_stays_in_background(cx: &mut TestAppContext) {
    late_new_chat_after_navigation(cx, "back");
}
