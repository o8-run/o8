use super::*;
use crate::shell::test_support::*;
fn setup(cx: &mut TestAppContext) -> (Fixture, Entity<Shell>, VisualTestContext) {
    let f = Fixture::new();
    let (s, mut v) = open_past_setup(f.client.clone(), f.root.join("panel-review.json"), crate::shell_state::State::default(), cx);
    ready(&s, &mut v);
    (f, s, v)
}
#[gpui::test]
fn review_panel_lower_browser_survives_project_and_disk_round_trip(cx: &mut TestAppContext) {
    let (f, s, mut v) = setup(cx);
    s.update_in(&mut v, |s, w, cx| {
        let a = s.state.selected.clone().unwrap();
        let b = s.workspaces.iter().find(|p| **p != a).unwrap().clone();
        let p = s.features.get::<Panel>();
        p.lower = Some(Tool::Browser);
        p.lower_tabs = vec![Tool::Browser];
        layout::save(s);
        s.switch(b, w, cx);
        layout::sync(s, w, cx);
        s.switch(a.clone(), w, cx);
        layout::sync(s, w, cx);
        assert!(s.features.get::<Panel>().lower_tabs.contains(&Tool::Browser));
        let file = f.root.join("lower-browser.json");
        s.state.save(&file).unwrap();
        let loaded = crate::shell_state::State::load(&file).unwrap();
        assert_eq!(loaded.right_panel.secondary_tabs[&a], ["browser"]);
        assert_eq!(loaded.right_panel.lower_tools[&a], "browser");
    });
}
#[gpui::test]
fn review_panel_unchanged_restore_does_not_persist(cx: &mut TestAppContext) {
    let (_f, s, mut v) = setup(cx);
    s.update_in(&mut v, |s, w, cx| {
        s.features.get::<Panel>().scope = None;
        s.review_persist_calls = 0;
        let before = serde_json::to_value(&s.state.right_panel).unwrap();
        layout::sync(s, w, cx);
        assert_eq!(serde_json::to_value(&s.state.right_panel).unwrap(), before);
        assert_eq!(s.review_persist_calls, 0, "unchanged startup/project restore must not submit a write");
    });
}
#[gpui::test]
fn review_panel_title_cache_visits_only_open_tabs(cx: &mut TestAppContext) {
    let (_f, s, mut v) = setup(cx);
    s.update(&mut v, |s, cx| {
        let mut catalog = s.sessions.clone();
        for i in 0..2000 {
            let mut thread = catalog[0].clone();
            thread.id = format!("review-unopened-{i}");
            catalog.push(thread);
        }
        s.install_sessions(catalog, false, cx);
        let count = s.state.workspaces.values().flat_map(|w| &w.tabs).filter(|t| matches!(t, Tab::Session(_))).count();
        s.review_title_visits = 0;
        s.persist();
        assert!(s.review_title_visits <= count, "title caching must look up only open threads");
    });
}
