use super::*;
use crate::shell::test_support::*;

#[gpui::test]
fn thread_tab_open_resolves_legacy_displayed_thread(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open_past_setup(
        fixture.client.clone(),
        fixture.root.join("tabs.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    shell.update_in(&mut visual, |s, window, cx| {
        let shown = match s.active().unwrap() {
            Tab::Session(id) => id,
            _ => panic!("chat"),
        };
        let workspace = s.state.selected.clone().unwrap();
        let saved = s.state.workspaces.get_mut(&workspace).unwrap();
        saved.tabs = vec![Tab::Session("legacy-tab".into())];
        saved.active = 0;
        saved.selections.insert("legacy-tab".into(), shown.clone());
        let legacy = fixture.root.join("legacy-state.json");
        s.state.save(&legacy).unwrap();
        s.state = crate::shell_state::State::load(&legacy).unwrap();
        s.execute(Command::Session(shown), window, cx);
        assert_eq!(s.current().unwrap().tabs.len(), 1, "reuse displayed thread");
        assert_eq!(s.active(), Some(Tab::Session("legacy-tab".into())));
        s.execute(Command::Session("legacy-tab".into()), window, cx);
        let saved = s.current().unwrap();
        assert_eq!(saved.tabs.len(), 2);
        assert_ne!(
            saved.tabs[0], saved.tabs[1],
            "legacy identity remains unique"
        );
        let Tab::Session(original) = &saved.tabs[1] else {
            panic!("chat")
        };
        assert_eq!(
            saved.selections.get(original).unwrap_or(original),
            "legacy-tab"
        );
    });
}

#[gpui::test]
fn thread_tab_close_returns_to_last_visit(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open_past_setup(
        fixture.client.clone(),
        fixture.root.join("close-tabs.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    shell.update_in(&mut visual, |s, window, cx| {
        let original = s.active().unwrap();
        let saved = s
            .state
            .workspaces
            .get_mut(s.state.selected.as_ref().unwrap())
            .unwrap();
        saved
            .tabs
            .extend([Tab::Session("second".into()), Tab::Session("third".into())]);
        record_visit(s);
        select_tab(s, 2, window, cx);
        record_visit(s);
        close_tab(s, 2, window, cx);
        assert_eq!(
            s.active(),
            Some(original),
            "return to last visited, not neighbour"
        );
    });
}

#[gpui::test]
fn thread_tab_rename_keeps_identity_across_reorder(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open_past_setup(
        fixture.client.clone(),
        fixture.root.join("rename-tabs.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    shell.update_in(&mut visual, |s, window, cx| {
        let original = s.active().unwrap();
        let key = s.key(&original);
        super::super::header_tabs::rename(s, 0, "Retained title".into(), window, cx);
        let saved = s
            .state
            .workspaces
            .get_mut(s.state.selected.as_ref().unwrap())
            .unwrap();
        saved.tabs.insert(0, Tab::Session("inserted".into()));
        saved.active = 1;
        // Starting another rename commits the first one, just as its blur does.
        super::super::header_tabs::rename(s, 0, "Other".into(), window, cx);
        assert_eq!(
            s.state.tab_labels.get(&key).map(String::as_str),
            Some("Retained title")
        );
    });
}

#[gpui::test]
fn thread_tab_backward_cycle_selects_previous_tab(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open_past_setup(
        fixture.client.clone(),
        fixture.root.join("backward-tabs.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    shell.update_in(&mut visual, |s, window, cx| {
        let saved = s
            .state
            .workspaces
            .get_mut(s.state.selected.as_ref().unwrap())
            .unwrap();
        saved
            .tabs
            .extend([Tab::Session("second".into()), Tab::Session("third".into())]);
        saved.active = 0;
        s.key_down(
            &gpui::KeyDownEvent {
                keystroke: gpui::Keystroke::parse("ctrl-shift-tab").unwrap(),
                is_held: false,
            },
            window,
            cx,
        );
        assert_eq!(s.current().unwrap().active, 2);
    });
}
