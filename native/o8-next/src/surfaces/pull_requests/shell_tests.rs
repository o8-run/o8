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
    prs.update_in(&mut visual, |s, window, cx| {
        s.editor.read(cx).focus.focus(window)
    });
    draw(&mut visual);
    visual.simulate_input("Unsent shell review notes");
    visual.simulate_keystrokes("ctrl-w");
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
        reopened.read_with(&visual, |s, cx| s.editor.read(cx).text.clone()),
        "Unsent shell review notes"
    );
}
