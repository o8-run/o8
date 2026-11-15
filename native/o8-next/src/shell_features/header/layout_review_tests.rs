use super::*;
use crate::shell::test_support::*;
#[gpui::test]
fn review_layout_fifteen_tabs_at_both_zooms(cx: &mut TestAppContext) {
    let mut shrinking_cases = 0;
    for zoom in [0.7, 1., 2.] {
        let f = Fixture::new();
        let mut state = crate::shell_state::State::default();
        state.bounds = [0., 0., 1200., 816.];
        let (s, mut v) = open_past_setup(f.client.clone(), f.root.join("header-range.json"), state, cx);
        ready(&s, &mut v);
        let all_tabs = s.update_in(&mut v, |s, w, cx| {
            w.set_zoom(zoom, cx);
            s.surfaces.sidebar.hidden = true;
            s.state.right_panel.visible = false;
            let scope = s.state.selected.clone().unwrap();
            let first = s.active().unwrap();
            let mut tabs = vec![first];
            let template = s.sessions.iter().find(|t| t.workspace() == scope).unwrap().clone();
            for i in 1..13 {
                let mut thread = template.clone();
                thread.id = format!("review-width-{i}");
                thread.title = if i == 12 { "A very long title ".repeat(60) } else { "Chat".into() };
                thread.is_worktree = Some(false);
                tabs.push(Tab::Session(thread.id.clone()));
                s.sessions.push(thread);
            }
            for thread in &mut s.sessions { thread.is_worktree = Some(false); }
            tabs.insert(1, Tab::Inbox);
            tabs.insert(2, Tab::Terminal);
            let label_key = s.key(&Tab::Inbox);
            s.state.tab_labels.insert(label_key, "W".repeat(80));
            let saved = s.state.workspaces.get_mut(&scope).unwrap();
            saved.tabs = tabs[..3].to_vec();
            saved.active = 0;
            tabs
        });
        draw(&mut v);
        std::thread::sleep(Duration::from_millis(500));
        for _ in 0..4 { draw(&mut v); }
        let three = v.debug_bounds("surface-tab-title-0").unwrap().size.width;
        assert!(v.debug_bounds("surface-tab-title-1").unwrap().size.width <= px(180.), "renamed fixed titles stay capped");
        s.update(&mut v, |s, _| {
            let scope = s.state.selected.clone().unwrap();
            s.state.workspaces.get_mut(&scope).unwrap().tabs = all_tabs;
        });
        draw(&mut v);
        // Insertion motion clips full-size pills inside growing wrappers for 450 ms.
        // Measure their settled layout, keeping every geometry assertion intact.
        std::thread::sleep(Duration::from_millis(500));
        for _ in 0..4 { draw(&mut v); }
        let strip = v.debug_bounds("surface-tabs").unwrap();
        let controls = v.debug_bounds("thread-header-controls").unwrap();
        let viewport = v.update(|window, _| window.viewport_size());
        assert!(controls.right() <= viewport.width, "controls stay inside the zoomed viewport");
        assert!(controls.left() - strip.right() <= px(5.), "no empty badge slot");
        let mut previous = None;
        let mut overflow = false;
        for i in 0..15 {
            let tab = v.debug_bounds(Box::leak(format!("surface-tab-{i}").into_boxed_str()));
            if let Some(tab) = tab {
                if let Some(right) = previous { assert!(tab.left() >= right, "tabs never overlap: zoom={zoom}, tab={i}, left={:?}, previous={right:?}", tab.left()); }
                previous = Some(tab.right());
                if tab.right() > strip.right() { overflow = true; }
                if tab.left() >= strip.left() && tab.right() <= strip.right() {
                    let close = v.debug_bounds(Box::leak(format!("surface-tab-close-{i}").into_boxed_str())).expect("fully visible tab has its close control");
                    assert!(close.left() >= tab.left() && close.right() <= tab.right(), "close stays fully in tab");
                }
                if i == 1 { assert!(tab.size.width <= px(220.), "renamed fixed tab stays bounded"); }
                if i == 2 { assert!(tab.size.width < px(120.), "short fixed tab keeps its natural width"); }
            } else { overflow = true; }
        }
        assert!(overflow, "15 tabs exceed this viewport at zoom {zoom}");
        assert!(v.debug_bounds("surface-tabs-overflow-right").is_some(), "right overflow has a control");
        let title = v.debug_bounds("surface-tab-title-0").unwrap();
        assert!(title.size.width >= px(120.) && title.size.width <= px(180.));
        assert!(title.size.width <= three, "adding tabs must never widen chat titles");
        if three > px(120.5) {
            assert!(title.size.width < three, "titles must shrink from 3 to 15 tabs at zoom {zoom}");
            shrinking_cases += 1;
        }
    }
    assert!(shrinking_cases >= 2, "strict shrinking must occur at 0.7 and 1.0 zoom; 2.0 is already at the minimum");
}
