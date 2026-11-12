use super::*;
use crate::shell::test_support::*;
#[gpui::test]
fn review_header_fifteen_tabs_at_both_zooms(cx: &mut TestAppContext) {
    for zoom in [1., 2.] {
        let f = Fixture::new();
        let mut state = crate::shell_state::State::default();
        state.bounds = [0., 0., 1200., 816.];
        let (s, mut v) = open_past_setup(f.client.clone(), f.root.join("header-range.json"), state, cx);
        ready(&s, &mut v);
        s.update_in(&mut v, |s, w, cx| {
            w.set_zoom(zoom, cx);
            s.surfaces.sidebar.hidden = true;
            s.state.right_panel.visible = false;
            let scope = s.state.selected.clone().unwrap();
            let first = s.active().unwrap();
            let mut tabs = vec![first];
            let template = s.sessions.iter().find(|t| t.workspace() == scope).unwrap().clone();
            for i in 1..14 {
                let mut thread = template.clone();
                thread.id = format!("review-width-{i}");
                thread.title = if i == 13 { "A very long title ".repeat(60) } else { "Chat".into() };
                thread.is_worktree = Some(false);
                tabs.push(Tab::Session(thread.id.clone()));
                s.sessions.push(thread);
            }
            for thread in &mut s.sessions { thread.is_worktree = Some(false); }
            tabs.push(Tab::Inbox);
            let saved = s.state.workspaces.get_mut(&scope).unwrap();
            saved.tabs = tabs;
            saved.active = 0;
        });
        for _ in 0..4 { draw(&mut v); }
        let strip = v.debug_bounds("surface-tabs").unwrap();
        let controls = v.debug_bounds("thread-header-controls").unwrap();
        assert!(controls.left() - strip.right() <= px(5.), "no empty badge slot");
        let mut previous = None;
        let mut overflow = false;
        for i in 0..15 {
            let tab = v.debug_bounds(Box::leak(format!("surface-tab-{i}").into_boxed_str()));
            if let Some(tab) = tab {
                if let Some(right) = previous { assert!(tab.left() >= right, "tabs never overlap"); }
                previous = Some(tab.right());
                if tab.right() > strip.right() { overflow = true; }
                if tab.left() >= strip.left() && tab.right() <= strip.right() {
                    let close = v.debug_bounds(Box::leak(format!("surface-tab-close-{i}").into_boxed_str())).expect("fully visible tab has its close control");
                    assert!(close.left() >= tab.left() && close.right() <= tab.right(), "close stays fully in tab");
                }
                if i == 14 { assert!(tab.size.width < px(120.), "fixed Inbox tab has natural width"); }
            } else { overflow = true; }
        }
        assert!(overflow, "15 tabs exceed this viewport at zoom {zoom}");
        assert!(v.debug_bounds("surface-tabs-overflow-right").is_some(), "right overflow has a control");
        let title = v.debug_bounds("surface-tab-title-0").unwrap();
        assert!(title.size.width >= px(120.) && title.size.width <= px(180.));
    }
}
