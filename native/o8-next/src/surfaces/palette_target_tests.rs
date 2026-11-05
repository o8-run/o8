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
    adopt(&mut choices, &mut requested, Some(Ok("owned".into())), true);
    assert_eq!(choices.len(), 1);
    assert_eq!(requested.as_deref(), Some("owned"));

    let mut choices = vec![choice("other")];
    let mut requested = Some("gone".to_string());
    adopt(&mut choices, &mut requested, Some(Ok("owned".into())), true);
    assert_eq!(requested.as_deref(), Some("owned"));
    assert_eq!(choices.len(), 2);
}

#[test]
fn a_listed_saved_choice_stays_and_failures_change_nothing() {
    let mut choices = vec![choice("saved")];
    let mut requested = Some("saved".to_string());
    adopt(&mut choices, &mut requested, Some(Ok("owned".into())), true);
    assert_eq!(requested.as_deref(), Some("saved"));
    assert!(choices.iter().any(|c| c.id == "owned"));

    let mut choices = vec![choice("saved")];
    let mut requested = None;
    adopt(&mut choices, &mut requested, Some(Err("down".into())), true);
    adopt(&mut choices, &mut requested, None, true);
    assert_eq!(requested, None);
    assert_eq!(choices.len(), 1);
}

#[test]
fn an_explicit_request_is_kept_when_the_own_target_must_not_replace_it() {
    // Review: a packet asked for by name is not swapped for working changes.
    let mut choices = vec![choice("listed")];
    let mut requested = Some("archived-packet".to_string());
    adopt(
        &mut choices,
        &mut requested,
        Some(Ok("owned".into())),
        false,
    );
    assert_eq!(requested.as_deref(), Some("archived-packet"));
    assert!(choices.iter().any(|c| c.id == "owned"), "still listed");
    // Nothing asked for: the own target opens.
    let mut requested = None;
    adopt(
        &mut choices,
        &mut requested,
        Some(Ok("owned".into())),
        false,
    );
    assert_eq!(requested.as_deref(), Some("owned"));
}

#[test]
fn working_changes_stay_listed_when_packets_cannot_be_read() {
    let dead = crate::shell::settings::machine_links::dead_client();
    let choices = <crate::shell::diff::PacketDiff as Port>::choices(&dead, "/work/repo").unwrap();
    assert_eq!(
        choices.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(),
        ["Working changes"]
    );
    assert!(
        <crate::shell::diff::PacketDiff as Port>::choices(&dead, "").is_err(),
        "no workspace, nothing to list"
    );
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
        // Review opens on the working changes; its switch returns to the list.
        let switch = cx.debug_bounds("target-switch").unwrap();
        cx.simulate_click(switch.center(), gpui::Modifiers::default());
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
        3,
        "two packets and the alias workspace's working changes"
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

#[gpui::test]
fn review_opens_on_the_working_changes_and_switches_to_packets(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--review");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("working-changes.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    let workspace = shell.read_with(cx, |s, _| s.state.selected.clone().unwrap());
    let path = crate::shell::session::workspace_path(&workspace).to_owned();
    fs::write(
        std::path::Path::new(&path).join("review-working-note.txt"),
        "uncommitted\n",
    )
    .unwrap();
    run(cx, "d i f f");
    let view = shell.read_with(cx, |s, _| match &s.content[&s.key(&Tab::Diff)] {
        Content::Diff(v) => v.clone(),
        _ => panic!("diff"),
    });
    let started = Instant::now();
    loop {
        settled(&shell, cx);
        let ready = view.read_with(cx, |v, cx| {
            v.child.as_ref().is_some_and(|child| child.read(cx).ready)
        });
        if ready {
            break;
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the working changes never loaded"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let (target, files, notice) = view.read_with(cx, |v, cx| {
        let child = v.child.as_ref().unwrap().read(cx);
        (
            child.target.clone(),
            child
                .document
                .files
                .iter()
                .map(|f| f.path.clone())
                .collect::<Vec<_>>(),
            child.notice.clone(),
        )
    });
    assert!(
        matches!(&target, crate::diff::Target::Worktree { path: p, base: None, file: None } if *p == path),
        "Review opens the workspace's working changes against HEAD"
    );
    assert!(
        files.iter().any(|f| f == "review-working-note.txt"),
        "an untracked file is a working change: {files:?}"
    );
    assert!(notice.starts_with("Working changes · "), "{notice}");
    assert!(cx.debug_bounds("diff-file-0").is_some());
    assert!(
        cx.debug_bounds("diff-approve").is_none(),
        "working changes are not a packet decision"
    );
    let switch = cx.debug_bounds("target-switch").unwrap();
    cx.simulate_click(switch.center(), gpui::Modifiers::default());
    settled(&shell, cx);
    assert!(cx.debug_bounds("target-picker").is_some());
    let labels = view.read_with(cx, |v, _| {
        v.choices
            .iter()
            .map(|c| c.label.clone())
            .collect::<Vec<_>>()
    });
    assert_eq!(labels.first().map(String::as_str), Some("Working changes"));
    assert!(labels.len() > 1, "packets stay listed: {labels:?}");
    // Picking a packet from the list opens its diff.
    let packet = view.read_with(cx, |v, _| v.choices[1].id.clone());
    let row = cx.debug_bounds("target-1").unwrap();
    cx.simulate_click(row.center(), gpui::Modifiers::default());
    settled(&shell, cx);
    let (_, target) = review_target(&shell, cx);
    assert!(
        matches!(&target, Some(crate::diff::Target::Packet(id)) if *id == packet),
        "{target:?}"
    );
}

/// The Review view and its attached diff's target, once settled.
fn review_target(
    shell: &Entity<Shell>,
    cx: &mut VisualTestContext,
) -> (
    Entity<Picker<crate::shell::diff::PacketDiff>>,
    Option<crate::diff::Target>,
) {
    let view = shell.read_with(cx, |s, _| match &s.content[&s.key(&Tab::Diff)] {
        Content::Diff(v) => v.clone(),
        _ => panic!("diff"),
    });
    let target = view.read_with(cx, |v, cx| {
        v.child.as_ref().map(|child| child.read(cx).target.clone())
    });
    (view, target)
}

#[gpui::test]
fn review_opens_a_requested_packet_and_never_swaps_an_unlisted_one(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--review");
    for (packet, listed) in [("next-review-approve", true), ("archived-elsewhere", false)] {
        let (shell, mut visual) = open(
            fixture.client.clone(),
            fixture.root.join(format!("requested-{packet}.json")),
            State::default(),
            cx,
        );
        let cx = &mut visual;
        ready(&shell, cx);
        // A restored packet, or one Activity opens, arrives as the saved slice.
        shell.update_in(cx, |s, window, cx| {
            s.state
                .workspaces
                .get_mut(s.state.selected.as_deref().unwrap())
                .unwrap()
                .surfaces
                .diff
                .diff_packet = Some(packet.into());
            s.execute(Command::Diff, window, cx);
        });
        settled(&shell, cx);
        let (view, target) = review_target(&shell, cx);
        if listed {
            assert!(
                matches!(&target, Some(crate::diff::Target::Packet(id)) if id == packet),
                "a listed packet opens"
            );
        } else {
            assert!(
                target.is_none(),
                "an unlisted packet is not swapped for working changes"
            );
            assert!(
                cx.debug_bounds("target-picker").is_some(),
                "the list shows instead"
            );
            assert!(view.read_with(cx, |v, _| {
                v.choices.iter().any(|c| c.label == "Working changes")
            }));
        }
    }
}

#[gpui::test]
fn review_stacks_every_changed_file_with_a_files_drawer(cx: &mut TestAppContext) {
    use crate::diff_ui::DiffSurface;
    let fixture = Fixture::start_mode(false, "--review");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("stacked-changes.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    let workspace = shell.read_with(cx, |s, _| s.state.selected.clone().unwrap());
    let path = std::path::PathBuf::from(crate::shell::session::workspace_path(&workspace));
    for name in ["stack-a.txt", "stack-b.txt"] {
        fs::write(path.join(name), format!("{name}\nsecond line\n")).unwrap();
    }
    let long: String = (0..2_100).map(|n| format!("line {n}\n")).collect();
    fs::write(path.join("stack-large.txt"), long).unwrap();
    // A pure rename has no hunks to draw.
    let moved = std::process::Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["mv", "changed.rs", "moved.rs"])
        .status()
        .unwrap();
    assert!(moved.success());
    run(cx, "d i f f");
    let started = Instant::now();
    loop {
        settled(&shell, cx);
        let (_, target) = review_target(&shell, cx);
        if matches!(target, Some(crate::diff::Target::Worktree { .. }))
            && cx.debug_bounds("diff-stack").is_some()
        {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(10), "no stack");
        std::thread::sleep(Duration::from_millis(20));
    }
    let (view, _) = review_target(&shell, cx);
    let child: Entity<DiffSurface> = view.read_with(cx, |v, _| v.child.clone().unwrap());
    let index = |cx: &mut VisualTestContext, name: &str| {
        child.read_with(cx, |d, _| {
            d.document.files.iter().position(|f| f.path == name)
        })
    };
    let refresh = |cx: &mut VisualTestContext, done: &dyn Fn(&DiffSurface) -> bool| {
        let button = cx.debug_bounds("diff-refresh").unwrap();
        cx.simulate_click(button.center(), gpui::Modifiers::default());
        let started = Instant::now();
        loop {
            settled(&shell, cx);
            if child.read_with(cx, |d, _| d.ready && done(d)) {
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(10), "no refresh");
            std::thread::sleep(Duration::from_millis(20));
        }
        settled(&shell, cx);
    };
    let click = |cx: &mut VisualTestContext, id: &str| {
        let id: &'static str = Box::leak(id.to_owned().into_boxed_str());
        let bounds = cx.debug_bounds(id).unwrap_or_else(|| panic!("{id}"));
        cx.simulate_click(bounds.center(), gpui::Modifiers::default());
        settled(&shell, cx);
        settled(&shell, cx);
    };
    let shows = |cx: &mut VisualTestContext, id: String| {
        cx.debug_bounds(Box::leak(id.into_boxed_str())).is_some()
    };
    let body = |i: usize| format!("review-file-{i}-diff-unified");
    let card = |i: usize| format!("diff-stack-file-{i}");
    let (a, b) = (
        index(cx, "stack-a.txt").unwrap(),
        index(cx, "stack-b.txt").unwrap(),
    );
    let (large, renamed) = (
        index(cx, "stack-large.txt").unwrap(),
        index(cx, "moved.rs").unwrap(),
    );
    // Every file is a card with its diff rows open, one after another.
    assert!(shows(cx, card(a)) && shows(cx, card(b)));
    assert!(shows(cx, body(a)), "file a's rows show");
    assert!(
        cx.debug_bounds("diff-viewport").is_none(),
        "no one-file viewer"
    );
    // A file over the row limit starts closed and says what opening costs.
    assert!(shows(cx, card(large)) && !shows(cx, body(large)));
    assert!(shows(cx, format!("diff-stack-hint-{large}")));
    // A rename without hunks says what moved instead of drawing rows.
    assert!(shows(cx, format!("diff-stack-meta-{renamed}")));
    assert!(child.read_with(cx, |d, _| d.document.files[renamed].status == "renamed"));
    // The large file is one Expand all opens, so the toolbar offers it.
    assert!(!child.read_with(cx, |d, _| d.all_open()));
    click(cx, "diff-collapse");
    assert!(child.read_with(cx, |d, _| d.all_open()), "expanded");
    assert!(shows(cx, body(large)), "opened, drawing its first rows");
    assert!(shows(cx, format!("diff-stack-more-{large}")));
    click(cx, "diff-collapse");
    for i in [a, b, large] {
        assert!(!shows(cx, body(i)), "collapse all closes file {i}");
    }
    assert!(!child.read_with(cx, |d, _| d.all_open()));
    // Walking the list (Home, End, Alt+arrows) moves to a file without
    // opening it.
    child.update(cx, |d, cx| d.select_file(b, cx));
    settled(&shell, cx);
    assert!(!shows(cx, body(b)), "walking keeps b closed");
    assert_eq!(
        child.read_with(cx, |d, _| (
            d.selected,
            d.chosen.get("stack-b.txt").copied()
        )),
        (b, Some(false))
    );
    // A drawer jump to a file taller than the stack lands on its header.
    click(cx, &format!("diff-file-{large}"));
    assert!(shows(cx, body(large)), "a jump opens the file");
    let stack = cx.debug_bounds("diff-stack").unwrap();
    let header = cx
        .debug_bounds(Box::leak(card(large).into_boxed_str()))
        .unwrap();
    assert!(
        (header.top() - stack.top()).abs() < gpui::px(2.),
        "header at {:?}, stack at {:?}",
        header.top(),
        stack.top()
    );
    // Rows past the limit open in the one-file view, and the stack comes back.
    assert!(shows(cx, format!("diff-stack-full-{large}")));
    child.update(cx, |d, cx| d.open_full(large, cx));
    let started = Instant::now();
    while !(child.read_with(cx, |d, _| d.ready) && cx.debug_bounds("diff-viewport").is_some()) {
        assert!(started.elapsed() < Duration::from_secs(10), "no full file");
        settled(&shell, cx);
        std::thread::sleep(Duration::from_millis(20));
    }
    let (file, rows) = child.read_with(cx, |d, _| match &d.target {
        crate::diff::Target::Worktree { file, .. } => (file.clone(), d.row_count()),
        _ => (None, 0),
    });
    assert_eq!(file.as_deref(), Some("stack-large.txt"));
    assert!(rows > 2_000, "every row is reachable: {rows}");
    click(cx, "diff-back");
    let started = Instant::now();
    while !(child.read_with(cx, |d, _| d.ready) && cx.debug_bounds("diff-stack").is_some()) {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "no stack again"
        );
        settled(&shell, cx);
        std::thread::sleep(Duration::from_millis(20));
    }
    // Back at the top, a header opens its file and only its file.
    click(cx, "diff-file-0");
    click(cx, &card(a));
    assert!(shows(cx, body(a)) && !shows(cx, body(b)));
    // A new file above them moves every index; open and closed follow the path.
    fs::write(path.join("stack-0.txt"), "first\n").unwrap();
    refresh(cx, &|d| {
        d.document.files.iter().any(|f| f.path == "stack-0.txt")
    });
    let (a2, b2) = (
        index(cx, "stack-a.txt").unwrap(),
        index(cx, "stack-b.txt").unwrap(),
    );
    assert_eq!(a2, a + 1, "the new file sorts first");
    assert!(shows(cx, body(a2)), "a stays open at its new index");
    assert!(!shows(cx, body(b2)), "b stays closed at its new index");
    let first = index(cx, "stack-0.txt").unwrap();
    assert!(shows(cx, body(first)), "a new small file opens");
    // A refresh that drops the selected last file keeps the selection in range.
    let last = index(cx, "stack-large.txt").unwrap();
    click(cx, &format!("diff-file-{last}"));
    assert_eq!(child.read_with(cx, |d, _| d.selected), last);
    fs::remove_file(path.join("stack-large.txt")).unwrap();
    fs::remove_file(path.join("stack-0.txt")).unwrap();
    refresh(cx, &|d| {
        !d.document.files.iter().any(|f| f.path == "stack-large.txt")
    });
    let (selected, total) = child.read_with(cx, |d, _| (d.selected, d.document.files.len()));
    assert!(selected < total, "{selected} of {total}");
    // The drawer hides and shows from the toolbar.
    let row = format!("diff-file-{}", index(cx, "stack-a.txt").unwrap());
    assert!(shows(cx, row.clone()), "the files drawer");
    click(cx, "diff-drawer");
    assert!(!shows(cx, row), "drawer hidden");
    assert!(shows(cx, card(0)), "the stack stays");
}

#[gpui::test]
fn review_stack_fits_a_narrow_pane(cx: &mut TestAppContext) {
    use crate::diff_ui::DiffSurface;
    let fixture = Fixture::start_mode(false, "--review");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("narrow-changes.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    let workspace = shell.read_with(cx, |s, _| s.state.selected.clone().unwrap());
    let path = std::path::PathBuf::from(crate::shell::session::workspace_path(&workspace));
    // One line far wider than the pane.
    let wide = "# A long line that would wrap one character per line ".repeat(6);
    fs::write(path.join("narrow.md"), format!("{wide}\nsecond\n")).unwrap();
    cx.simulate_resize(gpui::size(gpui::px(680.), gpui::px(800.)));
    run(cx, "d i f f");
    let started = Instant::now();
    loop {
        settled(&shell, cx);
        let (_, target) = review_target(&shell, cx);
        if matches!(target, Some(crate::diff::Target::Worktree { .. }))
            && cx.debug_bounds("diff-stack").is_some()
        {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(10), "no stack");
        std::thread::sleep(Duration::from_millis(20));
    }
    settled(&shell, cx);
    let (view, _) = review_target(&shell, cx);
    let child: Entity<DiffSurface> = view.read_with(cx, |v, _| v.child.clone().unwrap());
    let (width, i) = child.read_with(cx, |d, _| {
        let i = d.document.files.iter().position(|f| f.path == "narrow.md");
        (d.width, i.unwrap())
    });
    assert!(
        width > gpui::px(0.) && width < gpui::px(640.),
        "the pane is narrow: {width:?}"
    );
    // Narrow, the drawer starts hidden and the stack has the pane.
    assert!(cx.debug_bounds("diff-drawer-column").is_none());
    // As in classic Review with Word wrap on, a long row wraps in the pane.
    let row = |n: usize| -> &'static str {
        Box::leak(format!("review-file-{i}-diff-row-{n}").into_boxed_str())
    };
    let (hunk, content) = (
        cx.debug_bounds(row(0)).expect("hunk row"),
        cx.debug_bounds(row(1)).expect("content row"),
    );
    // The Files toggle opens the drawer over the stack, at its fixed width.
    let toggle = cx.debug_bounds("diff-drawer").unwrap();
    let pane = cx.debug_bounds("diff-stack").unwrap();
    assert!(
        toggle.right() <= pane.right() + gpui::px(1.),
        "the Files button stays in the pane: {toggle:?} in {pane:?}"
    );
    cx.simulate_click(toggle.center(), gpui::Modifiers::default());
    settled(&shell, cx);
    let stack = cx.debug_bounds("diff-stack").unwrap();
    let drawer = cx.debug_bounds("diff-drawer-column").expect("drawer shown");
    eprintln!(
        "narrow pane: surface {width:?}, stack {:?}, drawer {:?}, hunk row {:?} x {:?}, content row {:?} x {:?}",
        stack.size.width,
        drawer.size.width,
        hunk.size.width,
        hunk.size.height,
        content.size.width,
        content.size.height
    );
    assert!(hunk.size.height <= gpui::px(19.5), "the hunk header is one line");
    assert!(
        content.size.height > gpui::px(40.),
        "the long line wraps: {content:?}"
    );
    assert!(
        content.size.width <= stack.size.width + gpui::px(1.),
        "the row fits the stack, nothing scrolls sideways"
    );
    assert!(
        stack.size.width > drawer.size.width,
        "the stack is wider than the drawer"
    );
    assert!(
        stack.size.width <= width + gpui::px(1.),
        "the stack fits the pane"
    );
    assert_eq!(drawer.size.width, gpui::px(210.));
    // Picking a file in the overlay opens it and puts the drawer away.
    let entry: &'static str = Box::leak(format!("diff-file-{i}").into_boxed_str());
    let entry = cx.debug_bounds(entry).unwrap();
    cx.simulate_click(entry.center(), gpui::Modifiers::default());
    settled(&shell, cx);
    assert!(cx.debug_bounds("diff-drawer-column").is_none());
    assert!(cx.debug_bounds(row(1)).is_some());
    // Split wraps each side in its half too.
    let split = cx.debug_bounds("diff-split").unwrap();
    cx.simulate_click(split.center(), gpui::Modifiers::default());
    settled(&shell, cx);
    let stack = cx.debug_bounds("diff-stack").unwrap();
    let side: &'static str = Box::leak(format!("review-file-{i}-diff-side").into_boxed_str());
    let side = cx.debug_bounds(side).expect("split rows");
    let content = cx.debug_bounds(row(1)).expect("split content row");
    assert!(
        side.size.width <= stack.size.width + gpui::px(1.),
        "split fits the stack: {side:?} in {stack:?}"
    );
    assert!(
        content.size.height > gpui::px(40.),
        "the long line wraps in its half: {content:?}"
    );
    // Each side keeps exactly half the row, the empty one too, and fills the
    // row's height, so the wrapped side never paints past its row.
    for half in ["old", "new"] {
        let id: &'static str =
            Box::leak(format!("review-file-{i}-diff-row-1-{half}").into_boxed_str());
        let half = cx.debug_bounds(id).expect("split half");
        assert!(
            (half.size.width - content.size.width / 2.).abs() <= gpui::px(1.),
            "{id} is half the row: {half:?} of {content:?}"
        );
        assert!(
            (half.size.height - content.size.height).abs() <= gpui::px(0.5),
            "{id} fills the row: {half:?} of {content:?}"
        );
    }
    let next = cx.debug_bounds(row(2)).expect("the row after it");
    assert!(
        next.top() >= content.bottom() - gpui::px(0.5),
        "rows stack without overlapping: {content:?} then {next:?}"
    );
}

#[gpui::test]
fn review_scopes_the_stack_to_staged_unstaged_or_the_last_turn(cx: &mut TestAppContext) {
    use crate::diff_ui::{DiffSurface, Scope};
    let fixture = Fixture::start_mode(false, "--review");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("scoped-changes.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    let workspace = shell.read_with(cx, |s, _| s.state.selected.clone().unwrap());
    let path = std::path::PathBuf::from(crate::shell::session::workspace_path(&workspace));
    fs::write(path.join("scope-staged.txt"), "staged\n").unwrap();
    fs::write(path.join("scope-unstaged.txt"), "unstaged\n").unwrap();
    let git = |args: &[&str]| {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(&path)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    };
    git(&["add", "scope-staged.txt"]);
    // A staged rename, then an unstaged edit to its new path.
    git(&["mv", "changed.rs", "scope-moved.rs"]);
    let moved = fs::read_to_string(path.join("scope-moved.rs")).unwrap();
    fs::write(path.join("scope-moved.rs"), format!("{moved}// moved\n")).unwrap();
    run(cx, "d i f f");
    let wait =
        |cx: &mut VisualTestContext, what: &str, done: &dyn Fn(&mut VisualTestContext) -> bool| {
            let started = Instant::now();
            loop {
                settled(&shell, cx);
                if done(cx) {
                    break;
                }
                assert!(started.elapsed() < Duration::from_secs(10), "{what}");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
    let shows = |cx: &mut VisualTestContext, id: String| {
        cx.debug_bounds(Box::leak(id.into_boxed_str())).is_some()
    };
    let click = |cx: &mut VisualTestContext, id: &'static str| {
        let bounds = cx.debug_bounds(id).unwrap_or_else(|| panic!("{id}"));
        cx.simulate_click(bounds.center(), gpui::Modifiers::default());
        settled(&shell, cx);
    };
    wait(cx, "no stack", &|cx| {
        cx.debug_bounds("diff-stack").is_some()
    });
    let (view, _) = review_target(&shell, cx);
    let child: Entity<DiffSurface> = view.read_with(cx, |v, _| v.child.clone().unwrap());
    let index = |cx: &mut VisualTestContext, name: &str| {
        child.read_with(cx, |d, _| {
            d.document
                .files
                .iter()
                .position(|f| f.path == name)
                .unwrap()
        })
    };
    let (staged, unstaged, moved) = (
        index(cx, "scope-staged.txt"),
        index(cx, "scope-unstaged.txt"),
        index(cx, "scope-moved.rs"),
    );
    assert_eq!(
        child.read_with(cx, |d, _| d.document.files[moved].status.clone()),
        "renamed"
    );
    let card = |i: usize| format!("diff-stack-file-{i}");
    let row = |i: usize| format!("diff-file-{i}");
    // All changes shows both files.
    assert!(shows(cx, card(staged)) && shows(cx, card(unstaged)));
    // Staged keeps only the staged file, in the stack and in the drawer.
    click(cx, "diff-scope-staged");
    wait(cx, "staged scope", &|cx| {
        shows(cx, card(staged)) && !shows(cx, card(unstaged))
    });
    assert!(shows(cx, row(staged)) && !shows(cx, row(unstaged)));
    assert_eq!(child.read_with(cx, |d, _| d.scope), Scope::Staged);
    assert!(shows(cx, card(moved)), "the staged rename, by its new path");
    // Alt+Down from a hidden file after every shown one stays on it.
    let last_shown = child.read_with(cx, |d, _| *d.shown().last().unwrap());
    assert!(unstaged > last_shown, "{unstaged} after {last_shown}");
    child.update(cx, |d, _| d.selected = unstaged);
    cx.simulate_keystrokes("alt-down");
    settled(&shell, cx);
    assert_eq!(child.read_with(cx, |d, _| d.selected), unstaged);
    // Unstaged keeps only the file Git has not staged; untracked counts.
    click(cx, "diff-scope-unstaged");
    wait(cx, "unstaged scope", &|cx| {
        shows(cx, card(unstaged)) && !shows(cx, card(staged))
    });
    assert!(shows(cx, row(unstaged)) && !shows(cx, row(staged)));
    assert!(
        shows(cx, card(moved)),
        "the edit after the rename is unstaged"
    );
    // This workspace records no turn, so Last turn says so instead of cards.
    click(cx, "diff-scope-last-turn");
    wait(cx, "last turn scope", &|cx| {
        shows(cx, "diff-scope-empty".into()) && child.read_with(cx, |d, _| d.shown().is_empty())
    });
    assert!(!shows(cx, card(staged)) && !shows(cx, card(unstaged)));
    assert!(
        !shows(cx, "diff-collapse".into()),
        "nothing to open or close"
    );
    // All changes brings every file back.
    click(cx, "diff-scope-all");
    wait(cx, "all scope", &|cx| {
        shows(cx, card(staged)) && shows(cx, card(unstaged))
    });
    assert!(!shows(cx, "diff-scope-empty".into()));
}
