use super::*;
use crate::shell::test_support::*;

fn setup(cx: &mut TestAppContext) -> (Fixture, Entity<Shell>, VisualTestContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open_past_setup(
        fixture.client.clone(),
        fixture.root.join("review-tabs.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    (fixture, shell, visual)
}

#[gpui::test]
fn review_tabs_forty_plain_sidebar_opens_keep_one_tab(cx: &mut TestAppContext) {
    let (_fixture, shell, mut visual) = setup(cx);
    shell.update_in(&mut visual, |s, window, cx| {
        let active = s.active().unwrap();
        let scope = s.state.selected.clone().unwrap();
        let template = s
            .sessions
            .iter()
            .find(|v| v.workspace() == scope)
            .unwrap()
            .clone();
        let saved = s.state.workspaces.get_mut(&scope).unwrap();
        saved.tabs = vec![active.clone()];
        saved.active = 0;
        for i in 0..40 {
            let mut thread = template.clone();
            thread.id = format!("review-browse-{i}");
            let id = thread.id.clone();
            s.sessions.push(thread);
            s.open_thread(id.clone(), window, cx);
            assert_eq!(s.current().unwrap().tabs.len(), 1, "plain click {i}");
            assert_eq!(s.active(), Some(active.clone()), "stable tab identity");
            let Tab::Session(original) = &active else {
                panic!("chat")
            };
            assert_eq!(
                s.current()
                    .unwrap()
                    .selections
                    .get(original)
                    .unwrap_or(original),
                &id
            );
        }
    });
}

#[gpui::test]
fn review_tabs_plain_sidebar_open_focuses_an_existing_tab(cx: &mut TestAppContext) {
    let (_fixture, shell, mut visual) = setup(cx);
    shell.update_in(&mut visual, |s, window, cx| {
        let first = s.active().unwrap();
        let scope = s.state.selected.clone().unwrap();
        let mut thread = s
            .sessions
            .iter()
            .find(|v| v.workspace() == scope)
            .unwrap()
            .clone();
        thread.id = "review-already-open".into();
        s.sessions.push(thread.clone());
        s.execute(Command::Session(thread.id.clone()), window, cx);
        let second = s.active().unwrap();
        let count = s.current().unwrap().tabs.len();
        let index = s
            .current()
            .unwrap()
            .tabs
            .iter()
            .position(|v| v == &first)
            .unwrap();
        select_tab(s, index, window, cx);
        s.open_thread(thread.id, window, cx);
        assert_eq!(s.active(), Some(second));
        assert_eq!(s.current().unwrap().tabs.len(), count);
    });
}

#[gpui::test]
fn review_tabs_cmd_sidebar_click_adds_one_tab(cx: &mut TestAppContext) {
    let (_fixture, shell, mut visual) = setup(cx);
    let (list, thread, count) = shell.update(&mut visual, |s, _| {
        let scope = s.state.selected.clone().unwrap();
        let mut thread = s
            .sessions
            .iter()
            .find(|v| v.workspace() == scope)
            .unwrap()
            .clone();
        thread.id = "review-cmd-open".into();
        s.sessions.push(thread.clone());
        (
            s.surfaces.sidebar.view.clone().unwrap(),
            thread,
            s.current().unwrap().tabs.len(),
        )
    });
    list.update_in(&mut visual, |list, window, cx| {
        let mut row = list
            .rows
            .iter()
            .find(|row| row.id.is_some())
            .unwrap()
            .clone();
        row.id = Some(thread.id.clone());
        std::rc::Rc::make_mut(&mut list.rows).push(row);
        list.sessions.push(thread.clone());
        list.click_thread(
            thread.id.clone(),
            gpui::Modifiers {
                platform: true,
                ..Default::default()
            },
            window,
            cx,
        );
    });
    visual.run_until_parked();
    shell.read_with(&visual, |s, _| {
        assert_eq!(s.current().unwrap().tabs.len(), count + 1);
        assert_eq!(s.active(), Some(Tab::Session(thread.id)));
    });
}

#[gpui::test]
fn review_tabs_close_history_survives_project_round_trip(cx: &mut TestAppContext) {
    let (_fixture, shell, mut visual) = setup(cx);
    shell.update_in(&mut visual, |s, window, cx| {
        let p = s.state.selected.clone().unwrap();
        let q = s.workspaces.iter().find(|v| *v != &p).unwrap().clone();
        let template = s
            .sessions
            .iter()
            .find(|v| v.workspace() == p)
            .unwrap()
            .clone();
        let a = s.active().unwrap();
        let mut added = Vec::new();
        for id in ["review-B", "review-C"] {
            let mut thread = template.clone();
            thread.id = id.into();
            s.sessions.push(thread);
            added.push(Tab::Session(id.into()));
        }
        let saved = s.state.workspaces.get_mut(&p).unwrap();
        saved.tabs = vec![added[0].clone(), a, added[1].clone()];
        saved.active = 1;
        record_visit(s);
        select_tab(s, 2, window, cx);
        record_visit(s);
        select_tab(s, 0, window, cx);
        record_visit(s);
        s.switch(q, window, cx);
        record_visit(s);
        s.switch(p, window, cx);
        record_visit(s);
        close_tab(s, 0, window, cx);
        assert_eq!(s.active(), Some(added[1].clone()), "A → C → B returns to C");
    });
}

// Literal bytes emitted by State::save at 86d717c0bf698184f0efccdd04a5154d419b8ccf.
#[test]
fn review_tabs_load_pre_pr_literal_v1_state() {
    let file = scratch_path("legacy-v1-tabs");
    fs::write(&file, include_str!("v1-thread-tabs.json")).unwrap();
    let state = crate::shell_state::State::load(&file).unwrap();
    fs::remove_file(file).unwrap();
    assert_eq!(state.version, 1);
    assert_eq!(state.selected.as_deref(), Some("/fixture/project-p"));
    let saved = &state.workspaces["/fixture/project-p"];
    assert_eq!(
        saved.tabs,
        vec![Tab::Session("legacy-tab".into()), Tab::Terminal]
    );
    assert_eq!(saved.selections["legacy-tab"], "thoughts-composer-first");
    assert_eq!(
        state.tab_labels["/fixture/project-p|Session(\"legacy-tab\")"],
        "Saved title"
    );
}
