use super::*;
use crate::shell::test_support::*;

fn cmd_click(cx: &mut TestAppContext, bulk: bool, drawer: bool) {
    let f = Fixture::new();
    let (shell, mut visual) = open_past_setup(f.client.clone(), f.root.join("cmd-click.json"), crate::shell_state::State::default(), cx);
    ready(&shell, &mut visual);
    let (list, count) = shell.read_with(&visual, |s, _| (s.surfaces.sidebar.view.clone().unwrap(), s.current().unwrap().tabs.len()));
    let target = list.update_in(&mut visual, |list, w, cx| {
        if drawer {
            list.working_section = true;
            list.working_closed = false;
            for session in &mut list.sessions { session.status = "running".into(); }
            list.set_view(super::super::folders::View::Date, cx);
            list.rebuild();
        }
        let rows = list.rows.iter().skip(if drawer { list.drawer_index.expect("Working drawer") + 1 } else { 0 });
        let ids: Vec<_> = rows.filter_map(|row| row.id.clone()).take(2).collect();
        assert_eq!(ids.len(), 2);
        if bulk { list.picked.insert(ids[0].clone()); }
        list.click_thread(ids[1].clone(), Modifiers { platform: true, ..Default::default() }, w, cx);
        if bulk {
            assert!(list.picked.contains(&ids[1]), "Cmd-click adds a bulk selection");
            list.click_thread(ids[1].clone(), Modifiers { platform: true, ..Default::default() }, w, cx);
            assert!(!list.picked.contains(&ids[1]), "Cmd-click removes a bulk selection");
            assert!(list.picked.contains(&ids[0]));
        }
        ids[1].clone()
    });
    visual.run_until_parked();
    shell.read_with(&visual, |s, _| {
        if bulk { assert_eq!(s.current().unwrap().tabs.len(), count); }
        else { assert!(s.thread_content(&target).is_some(), "Cmd-click opens the thread"); }
    });
}
#[gpui::test]
fn review_click_cmd_opens_without_bulk_selection(cx: &mut TestAppContext) { cmd_click(cx, false, false); }
#[gpui::test]
fn review_click_cmd_toggles_with_bulk_selection(cx: &mut TestAppContext) { cmd_click(cx, true, false); }

#[gpui::test]
fn review_click_drawer_cmd_opens_without_bulk(cx: &mut TestAppContext) { cmd_click(cx, false, true); }
#[gpui::test]
fn review_click_drawer_cmd_toggles_with_bulk(cx: &mut TestAppContext) { cmd_click(cx, true, true); }
