#[path = "palette_target_own_tests.rs"]
mod own;

use super::*;
use crate::shell::palette::tests::{run, settled};

fn choice(id: &str) -> Choice {
    Choice {
        id: id.into(),
        label: id.into(),
    }
}

#[test]
fn own_target_opens_when_the_saved_choice_is_not_listed() {
    // A server that leaves the owned shell out of its inventory, with the
    // shell saved by an earlier view of the same surface.
    let mut choices = vec![];
    let mut requested = Some("owned".to_string());
    adopt(&mut choices, &mut requested, Some(Ok("owned".into())));
    assert_eq!(choices.len(), 1);
    assert_eq!(requested.as_deref(), Some("owned"));

    let mut choices = vec![choice("other")];
    let mut requested = Some("gone".to_string());
    adopt(&mut choices, &mut requested, Some(Ok("owned".into())));
    assert_eq!(requested.as_deref(), Some("owned"));
    assert_eq!(choices.len(), 2);
}

#[test]
fn a_listed_saved_choice_stays_and_failures_change_nothing() {
    let mut choices = vec![choice("saved")];
    let mut requested = Some("saved".to_string());
    adopt(&mut choices, &mut requested, Some(Ok("owned".into())));
    assert_eq!(requested.as_deref(), Some("saved"));
    assert!(choices.iter().any(|c| c.id == "owned"));

    let mut choices = vec![choice("saved")];
    let mut requested = None;
    adopt(&mut choices, &mut requested, Some(Err("down".into())));
    adopt(&mut choices, &mut requested, None);
    assert_eq!(requested, None);
    assert_eq!(choices.len(), 1);
}

/// Scripted replies belong to one workspace; the real Picker owns scheduling.
type Inventory = Result<Vec<(&'static str, &'static str)>, String>;
struct Script {
    workspace: &'static str,
    own: std::collections::VecDeque<Option<Result<String, String>>>,
    inventories: std::collections::VecDeque<Inventory>,
    own_calls: usize,
    list_calls: usize,
}
static SCRIPTS: std::sync::Mutex<Vec<Script>> = std::sync::Mutex::new(Vec::new());
fn configure(
    workspace: &'static str,
    replies: Vec<Option<Result<String, String>>>,
    inventories: Vec<Inventory>,
) {
    assert!(!inventories.is_empty());
    let script = Script {
        workspace,
        own: replies.into(),
        inventories: inventories.into(),
        own_calls: 0,
        list_calls: 0,
    };
    let mut scripts = SCRIPTS.lock().unwrap();
    // Reinitialization also supports GPUI's repeated scheduler seeds.
    scripts.retain(|script| script.workspace != workspace);
    scripts.push(script);
}
fn queue(workspace: &'static str, replies: Vec<Result<String, String>>) {
    configure(
        workspace,
        replies.into_iter().map(Some).collect(),
        vec![Ok(vec![])],
    );
}
fn calls(workspace: &str) -> (usize, usize) {
    let scripts = SCRIPTS.lock().unwrap();
    let script = scripts
        .iter()
        .find(|script| script.workspace == workspace)
        .unwrap();
    (script.own_calls, script.list_calls)
}
fn inventory(workspace: &str, result: Inventory) {
    let mut scripts = SCRIPTS.lock().unwrap();
    scripts
        .iter_mut()
        .find(|script| script.workspace == workspace)
        .unwrap()
        .inventories = [result].into();
}
struct Owned;
struct Opened(String);
impl Render for Opened {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().child(self.0.clone())
    }
}
impl Port for Owned {
    type View = Opened;
    const TITLE: &'static str = "Owned";
    const EMPTY: &'static str = "None";
    fn choices(_: &Client, workspace: &str) -> Result<Vec<Choice>, String> {
        let mut scripts = SCRIPTS.lock().unwrap();
        let script = scripts
            .iter_mut()
            .find(|script| script.workspace == workspace)
            .unwrap();
        script.list_calls += 1;
        let result = if script.inventories.len() > 1 {
            script.inventories.pop_front().unwrap()
        } else {
            script.inventories.front().unwrap().clone()
        };
        result.map(|choices| {
            choices
                .into_iter()
                .map(|(id, label)| Choice {
                    id: id.into(),
                    label: label.into(),
                })
                .collect()
        })
    }
    fn create(_: Client, id: String, _: &mut Window, _: &mut Context<Opened>) -> Opened {
        Opened(id)
    }
    fn own(_: &Client, workspace: &str) -> Option<Result<String, String>> {
        let mut scripts = SCRIPTS.lock().unwrap();
        let script = scripts
            .iter_mut()
            .find(|script| script.workspace == workspace)
            .unwrap();
        script.own_calls += 1;
        script.own.pop_front().flatten()
    }
    fn ready(_: &Entity<Opened>, _: &App) -> bool {
        true
    }
}
fn press(
    picker: &mut Picker<Owned>,
    key: &str,
    window: &mut Window,
    cx: &mut Context<Picker<Owned>>,
) {
    let event = KeyDownEvent {
        keystroke: gpui::Keystroke::parse(key).unwrap(),
        is_held: false,
    };
    picker.key(&event, window, cx);
}
fn paint(cx: &mut gpui::VisualTestContext) {
    cx.run_until_parked();
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
}

#[gpui::test]
fn reviewer_f5_during_pending_creation_then_retry(cx: &mut TestAppContext) {
    queue(
        "reviewer-pending-f5",
        vec![
            Err("terminal service refused".into()),
            Ok("own-shell".into()),
        ],
    );
    let client = Client::new("http://127.0.0.1:9").unwrap();
    let (picker, cx) = cx.add_window_view(|window, cx| {
        let mut picker = Picker::<Owned>::new(client, "reviewer-pending-f5".into(), None, cx);
        press(&mut picker, "f5", window, cx);
        picker
    });
    paint(cx);
    picker.update_in(cx, |picker, window, cx| press(picker, "f5", window, cx));
    paint(cx);
    picker.read_with(cx, |picker, _| {
        assert_eq!(
            picker.selected.as_deref(),
            Some("own-shell"),
            "F5 retries after pending creation fails"
        );
        assert!(picker.child.is_some());
    });
}

#[gpui::test]
fn reviewer_reopen_after_creation_error_stays_on_list(cx: &mut TestAppContext) {
    queue(
        "reviewer-reopen-error",
        vec![
            Err("terminal service refused".into()),
            Ok("own-shell".into()),
        ],
    );
    let client = Client::new("http://127.0.0.1:9").unwrap();
    let (picker, cx) = cx.add_window_view(|_, cx| {
        Picker::<Owned>::new(client, "reviewer-reopen-error".into(), None, cx)
    });
    paint(cx);
    assert!(
        cx.debug_bounds("target-own-error").is_some(),
        "initial error displayed"
    );
    picker.update_in(cx, |picker, window, cx| {
        press(picker, "ctrl-alt-o", window, cx)
    });
    paint(cx);
    picker.read_with(cx, |picker, _| {
        assert!(
            picker.child.is_none() && picker.selected.is_none(),
            "reopening should stay on list"
        );
    });
}

#[gpui::test]
fn reopening_while_the_own_target_is_created_lists_instead_of_reopening(cx: &mut TestAppContext) {
    queue("reopen-pending", vec![Ok("own-shell".into())]);
    let client = Client::new("http://127.0.0.1:9").unwrap();
    // Ctrl+Alt+O lands before the creation reply, as a person reopening the list does.
    let (picker, cx) = cx.add_window_view(|window, cx| {
        let mut picker = Picker::<Owned>::new(client, "reopen-pending".into(), None, cx);
        press(&mut picker, "ctrl-alt-o", window, cx);
        picker
    });
    paint(cx);
    picker.read_with(cx, |picker, _| {
        assert!(
            picker.child.is_none() && picker.selected.is_none(),
            "the list stays open"
        );
        assert!(!picker.loading);
    });
}

#[gpui::test]
fn an_own_target_creation_error_shows_and_f5_retries(cx: &mut TestAppContext) {
    queue(
        "create-fails",
        vec![
            Err("terminal service refused".into()),
            Ok("own-shell".into()),
        ],
    );
    let client = Client::new("http://127.0.0.1:9").unwrap();
    let (picker, cx) =
        cx.add_window_view(|_, cx| Picker::<Owned>::new(client, "create-fails".into(), None, cx));
    paint(cx);
    assert!(
        cx.debug_bounds("target-own-error").is_some(),
        "the error is shown"
    );
    picker.read_with(cx, |picker, _| assert!(picker.child.is_none()));
    picker.update_in(cx, |picker, window, cx| press(picker, "f5", window, cx));
    paint(cx);
    picker.read_with(cx, |picker, _| {
        assert_eq!(
            picker.selected.as_deref(),
            Some("own-shell"),
            "F5 created and opened it"
        );
        assert!(picker.child.is_some());
    });
}

use crate::shell::test_support::*;

#[gpui::test]
fn target_click_keeps_identity_when_inventory_reorders(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--review");
    for redraw in [false, true] {
        let (shell, mut visual) = open(
            fixture.client.clone(),
            fixture.root.join(format!("row-race-{redraw}.json")),
            State::default(),
            cx,
        );
        let cx = &mut visual;
        ready(&shell, cx);
        run(cx, "d i f f");
        settled(&shell, cx);
        let view = shell.read_with(cx, |s, _| match &s.content[&s.key(&Tab::Diff)] {
            Content::Diff(v) => v.clone(),
            _ => panic!("diff"),
        });
        let expected = view.read_with(cx, |v, _| v.choices[0].id.clone());
        let bounds = cx.debug_bounds("target-0").unwrap();
        cx.simulate_mouse_down(
            bounds.center(),
            gpui::MouseButton::Left,
            gpui::Modifiers::default(),
        );
        view.update(cx, |v, _| v.choices.reverse());
        if redraw {
            draw(cx);
        }
        cx.simulate_mouse_up(
            bounds.center(),
            gpui::MouseButton::Left,
            gpui::Modifiers::default(),
        );
        settled(&shell, cx);
        let selected = view.read_with(cx, |v, _| v.selected.clone());
        assert!(
            selected == Some(expected) || (redraw && selected.is_none()),
            "a repainted row must cancel the click or retain its original target"
        );
    }
}

#[gpui::test]
fn target_reopen_cancels_pending_restore(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--review");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("restore-race.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    shell.update_in(cx, |s, window, cx| {
        s.state
            .workspaces
            .get_mut(s.state.selected.as_deref().unwrap())
            .unwrap()
            .surfaces
            .diff
            .diff_packet = Some("next-review-approve".into());
        s.execute(Command::Diff, window, cx);
        let view = match &s.content[&s.key(&Tab::Diff)] {
            Content::Diff(v) => v.clone(),
            _ => panic!("diff"),
        };
        // Dispatch the production key listener before the background response
        // can update the view; the shell and HTTP entry point are unchanged.
        view.update(cx, |view, cx| {
            view.key(
                &KeyDownEvent {
                    keystroke: gpui::Keystroke::parse("ctrl-alt-o").unwrap(),
                    is_held: false,
                },
                window,
                cx,
            )
        });
    });
    settled(&shell, cx);
    assert!(
        shell.read_with(cx, |s, cx| match &s.content[&s.key(&Tab::Diff)] {
            Content::Diff(v) => v.read(cx).selected.is_none() && v.read(cx).child.is_none(),
            _ => false,
        })
    );
}

#[gpui::test]
fn target_choices_compare_canonical_workspace_paths(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--review --terminal");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("alias.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    let alias = shell.read_with(cx, |s, _| {
        format!("{}/.", s.state.selected.as_deref().unwrap())
    });
    shell.update_in(cx, |s, window, cx| {
        s.workspaces.push(alias.clone());
        s.switch(alias, window, cx);
    });
    run(cx, "d i f f");
    settled(&shell, cx);
    assert_eq!(
        shell.read_with(cx, |s, cx| match &s.content[&s.key(&Tab::Diff)] {
            Content::Diff(v) => v.read(cx).choices.len(),
            _ => 0,
        }),
        2
    );
    run(cx, "t e r m i n a l");
    settled(&shell, cx);
    assert_eq!(
        shell.read_with(cx, |s, cx| match &s.content[&s.key(&Tab::Terminal)] {
            Content::Terminal(v) => v.read(cx).choices.len(),
            _ => 0,
        }),
        1
    );
}

#[gpui::test]
fn target_load_finishing_after_workspace_switch_keeps_composer_focus(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--review");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("load-race.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    let other = shell.read_with(cx, |s, _| {
        s.workspaces
            .iter()
            .find(|w| Some(*w) != s.state.selected.as_ref())
            .unwrap()
            .clone()
    });
    shell.update_in(cx, |s, window, cx| {
        s.execute(Command::Diff, window, cx);
        s.switch(other.clone(), window, cx);
        let session = s.workspace_sessions()[0].id.clone();
        s.execute(Command::Message(session), window, cx);
    });
    settled(&shell, cx);
    assert_eq!(
        shell.read_with(cx, |s, _| s.state.selected.clone()),
        Some(other)
    );
    let view = shell.read_with(cx, |s, _| match &s.content[&s.key(&s.active().unwrap())] {
        Content::Session(view) => view.clone(),
        _ => panic!("session"),
    });
    cx.update(|window, cx| assert!(view.read(cx).shell_selection(window, cx).1));
}
