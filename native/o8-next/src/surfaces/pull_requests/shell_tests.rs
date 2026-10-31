use super::*;
use crate::shell::test_support::*;

#[gpui::test]
fn shell_pull_requests_opens_from_palette(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--pull-requests");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("prs.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("p u l l");
    assert_eq!(
        shell.read_with(&visual, |s, _| s.commands().len()),
        1,
        "the shell command palette must expose the repository pull request surface"
    );
    visual.simulate_keystrokes("enter");
    draw(&mut visual);
    assert_eq!(
        shell.read_with(&visual, |s, _| s.active().unwrap().label()),
        "Pull requests"
    );
    ready(&shell, &mut visual);
    let prs = shell.read_with(&visual, |s, _| {
        match s.content.get(&s.key(&Tab::PullRequests)) {
            Some(Content::PullRequests(prs)) => prs.clone(),
            _ => panic!("registered PR view"),
        }
    });
    let row = visual.debug_bounds("pr-row-7").expect("fixture PR row");
    visual.simulate_click(row.center(), gpui::Modifiers::default());
    visual.run_until_parked();
    draw(&mut visual);
    // As in classic, the picked pull request opens in the right panel's PR tabs.
    let repo = prs.read_with(&visual, |s, _| s.page["repo"].as_str().unwrap().to_owned());
    let context = shell
        .read_with(&visual, |s, _| {
            s.surfaces.pull_requests.contexts.get(&format!("{repo}#7")).cloned()
        })
        .expect("the panel opens the picked pull request");
    assert_eq!(prs.read_with(&visual, |s, _| s.selected), Some(7));
    for _ in 0..50 {
        if context.read_with(&visual, |s, _| !s.detail_loading) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        visual.run_until_parked();
    }
    draw(&mut visual);
    context.update_in(&mut visual, |s, window, cx| {
        s.editor.read(cx).focus.focus(window)
    });
    draw(&mut visual);
    visual.simulate_input("Unsent shell review notes");
    visual.simulate_keystrokes("ctrl-w");
    assert_eq!(
        shell.read_with(&visual, |s, _| s.active()),
        Some(Tab::PullRequests),
        "focused review notes retain the close chord"
    );
    shell.update_in(&mut visual, |s, window, _| s.focus.focus(window));
    draw(&mut visual);
    visual.simulate_keystrokes("ctrl-w");
    assert_ne!(
        shell.read_with(&visual, |s, _| s.active()),
        Some(Tab::PullRequests),
        "the non-editing close chord must actually close the tab"
    );
    visual.simulate_keystrokes("ctrl-k");
    visual.simulate_keystrokes("p u l l enter");
    ready(&shell, &mut visual);
    let reopened = shell.read_with(&visual, |s, _| {
        match s.content.get(&s.key(&Tab::PullRequests)) {
            Some(Content::PullRequests(prs)) => prs.clone(),
            _ => panic!("reopened PR view"),
        }
    });
    assert_eq!(
        reopened.entity_id(),
        prs.entity_id(),
        "closing and reopening must retain the PR view"
    );
    assert_eq!(
        context.read_with(&visual, |s, cx| s.editor.read(cx).text.clone()),
        "Unsent shell review notes",
        "the panel's pull request keeps its unsent notes"
    );
}
