//! PR links on thread rows: the badge, its hover list, a click opening the
//! right panel's PR viewer and Ctrl/Cmd-click leaving it closed (browser).
use super::*;
use super::settle_tests::start;
use super::thread_list::pr_links::{PrLink, badge_text};

const FIRST: &str = "thoughts-composer-first";
const SECOND: &str = "thoughts-composer-second";

fn link(number: u64, title: &str, state: &str) -> PrLink {
    PrLink {
        repository_full_name: "o8-run/o8".into(),
        number,
        title: Some(title.into()),
        state: Some(state.into()),
    }
}
fn shown(shell: &Entity<Shell>, cx: &mut VisualTestContext, id: &str) {
    let index = shell.read_with(cx, |s, cx| {
        s.surfaces.sidebar.view.as_ref().unwrap().read(cx).rows.iter().position(|r| r.id.as_deref() == Some(id))
    });
    let index = index.unwrap_or_else(|| panic!("{id} is listed"));
    shell.update(cx, |s, cx| {
        s.surfaces.sidebar.view.clone().unwrap().update(cx, |l, cx| {
            l.scroll.scroll_to_item(index, ScrollStrategy::Center);
            cx.notify();
        });
    });
    draw(cx);
}

#[test]
fn badge_names_one_pr_and_counts_several() {
    assert_eq!(badge_text(&[link(19424, "a", "open")]), "19424");
    assert_eq!(badge_text(&[link(1, "a", "open"), link(2, "b", "merged")]), "+2");
}

#[gpui::test]
fn sidebar_pr_badge_lists_links_and_opens_the_viewer(cx: &mut TestAppContext) {
    let (_fixture, shell, mut visual, _project) = start("--shell --composer --sidebar", cx);
    shell.update(&mut visual, |s, cx| {
        s.surfaces.sidebar.view.clone().unwrap().update(cx, |l, cx| {
            l.set_pr_links(FIRST, vec![link(5141, "Inbox pins and order", "merged"), link(5160, "Update ceiling", "open")]);
            l.set_pr_links(SECOND, vec![link(5163, "Single", "open")]);
            cx.notify();
        });
    });
    shown(&shell, &mut visual, FIRST);
    let badge: &'static str = Box::leak(format!("thread-pr-badge-{FIRST}").into_boxed_str());
    let at = visual.debug_bounds(badge).expect("PR badge on the row").center();
    visual.simulate_mouse_move(at, None, gpui::Modifiers::default());
    draw(&mut visual);
    assert!(visual.debug_bounds("thread-pr-list").is_some(), "hover lists the PRs");
    let item = visual.debug_bounds("thread-pr-item-1").expect("second PR listed").center();
    visual.simulate_mouse_move(item, None, gpui::Modifiers::default());
    visual.simulate_click(item, gpui::Modifiers::default());
    wait_for(&shell, &mut visual, |_, _| true);
    draw(&mut visual);
    assert!(visual.debug_bounds("panel-pr-o8-run/o8-5160").is_some(), "the right panel opened #5160");
    assert!(visual.debug_bounds("thread-pr-list").is_none(), "choosing closes the list");

    // Cmd/Ctrl-click goes to the browser, not the panel.
    shown(&shell, &mut visual, SECOND);
    let single: &'static str = Box::leak(format!("thread-pr-badge-{SECOND}").into_boxed_str());
    let at = visual.debug_bounds(single).expect("single PR badge").center();
    let browser = if cfg!(target_os = "macos") {
        gpui::Modifiers { platform: true, ..Default::default() }
    } else {
        gpui::Modifiers { control: true, ..Default::default() }
    };
    visual.simulate_mouse_move(at, None, browser);
    visual.simulate_click(at, browser);
    draw(&mut visual);
    assert!(visual.debug_bounds("panel-pr-o8-run/o8-5163").is_none(), "Ctrl/Cmd-click does not open the panel");
    // A plain click on a single-PR badge opens it directly.
    visual.simulate_mouse_move(at, None, gpui::Modifiers::default());
    visual.simulate_click(at, gpui::Modifiers::default());
    wait_for(&shell, &mut visual, |_, _| true);
    draw(&mut visual);
    assert!(visual.debug_bounds("panel-pr-o8-run/o8-5163").is_some(), "a click opens the single PR");
}
