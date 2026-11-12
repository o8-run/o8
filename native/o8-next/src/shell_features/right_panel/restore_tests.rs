use super::*;
use crate::shell::test_support::*;

#[gpui::test]
fn project_restore_does_not_create_side_chat_or_add_tool_tab(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let mut state = crate::shell_state::State::default();
    state.bounds = [0., 0., 1680., 1050.];
    let (shell, mut visual) = open_past_setup(
        fixture.client.clone(),
        fixture.root.join("panel-restore.json"),
        state,
        cx,
    );
    ready(&shell, &mut visual);
    shell.update_in(&mut visual, |s, window, cx| {
        let other = s
            .workspaces
            .iter()
            .find(|w| Some(*w) != s.state.selected.as_ref())
            .unwrap()
            .clone();
        s.state.right_panel.primary = "side-chat".into();
        s.state.right_panel.visible = true;
        s.switch(other.clone(), window, cx);
        let focus = window.focused(cx);
        layout::sync(s, window, cx);
        assert!(
            !s.state.right_panel.side_chats.contains_key(&other),
            "restoration never starts a conversation"
        );
        assert!(
            s.features.get::<Panel>().tabs.is_empty(),
            "restoration never adds a tab"
        );
        assert_eq!(window.focused(cx), focus);
    });
}

#[gpui::test]
fn project_restore_does_not_lose_saved_thread_title(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open_past_setup(
        fixture.client.clone(),
        fixture.root.join("saved-title.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    shell.update(&mut visual, |s, _| {
        let tab = s.active().unwrap();
        let title = super::super::header::tab_label(s, &tab);
        assert_ne!(title, "Chat", "fixture has a loaded title");
        s.persist();
        let file = fixture.root.join("title-state.json");
        s.state.save(&file).unwrap();
        s.state = crate::shell_state::State::load(&file).unwrap();
        // A restart has saved window state before it receives the catalog.
        s.sessions.clear();
        assert_eq!(super::super::header::tab_label(s, &tab), title);
    });
}
