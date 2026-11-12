use super::*;
use crate::shell::test_support::*;

fn cmd_click(cx: &mut TestAppContext, bulk: bool) {
    let f = Fixture::new();
    let (shell, mut visual) = open_past_setup(f.client.clone(), f.root.join("cmd-click.json"), crate::shell_state::State::default(), cx);
    ready(&shell, &mut visual);
    let (list, count) = shell.read_with(&visual, |s, _| (s.surfaces.sidebar.view.clone().unwrap(), s.current().unwrap().tabs.len()));
    let target = list.update_in(&mut visual, |list, w, cx| {
        let ids: Vec<_> = list.rows.iter().filter_map(|row| row.id.clone()).take(2).collect();
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
fn review_click_cmd_opens_without_bulk_selection(cx: &mut TestAppContext) { cmd_click(cx, false); }
#[gpui::test]
fn review_click_cmd_toggles_with_bulk_selection(cx: &mut TestAppContext) { cmd_click(cx, true); }
