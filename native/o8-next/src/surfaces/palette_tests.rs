use super::*;
use crate::shell::test_support::*;

pub(super) fn run(cx: &mut VisualTestContext, keys: &str) {
    cx.simulate_keystrokes("ctrl-shift-p");
    cx.simulate_keystrokes(keys);
    cx.simulate_keystrokes("enter");
}
pub(super) fn settled(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        cx.run_until_parked();
        shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
        draw(cx);
        if shell.read_with(cx, |s, cx| {
            s.active()
                .and_then(|t| s.content.get(&s.key(&t)))
                .is_some_and(|c| c.ready(cx))
        }) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "surface must reach its real content frame"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[gpui::test]
fn palette_keyboard_opens_all_surfaces_and_switches_workspaces(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--review --terminal");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("palette.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    run(cx, "g r i d");
    settled(&shell, cx);
    assert_eq!(
        shell.read_with(cx, |s, _| s.active().unwrap().label()),
        "Grid"
    );
    run(cx, "s e s s i o n");
    settled(&shell, cx);
    assert!(matches!(
        shell.read_with(cx, |s, _| s.active()),
        Some(Tab::Session(_))
    ));
    run(cx, "n e w");
    assert!(shell.read_with(cx, |s, _| s.current().unwrap().composer));
    run(cx, "d i f f");
    settled(&shell, cx);
    assert_eq!(
        shell.read_with(cx, |s, _| s.active().unwrap().label()),
        "Diff"
    );
    cx.simulate_keystrokes("r e j e c t enter");
    settled(&shell, cx);
    shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
    let state = shell.read_with(cx, |s, _| serde_json::to_value(&s.state).unwrap());
    let workspace = state["selected"].as_str().unwrap();
    assert_eq!(
        state["workspaces"][workspace]["diff_packet"],
        "next-review-reject"
    );
    run(cx, "t e r m i n a l");
    settled(&shell, cx);
    assert_eq!(
        shell.read_with(cx, |s, _| s.active().unwrap().label()),
        "Terminal"
    );
    cx.simulate_keystrokes("enter");
    settled(&shell, cx);
    shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
    let state = shell.read_with(cx, |s, _| serde_json::to_value(&s.state).unwrap());
    assert_eq!(
        state["workspaces"][workspace]["terminal_session"],
        "cortex-next-terminal-fixture"
    );
    cx.simulate_input("palette-input");
    cx.simulate_keystrokes("enter");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        shell.update_in(cx, |s, window, cx| s.tick(false, window, cx));
        draw(cx);
        let echoed = shell.read_with(cx, |s, cx| match &s.content[&s.key(&Tab::Terminal)] {
            Content::Terminal(view) => view
                .read(cx)
                .child
                .as_ref()
                .unwrap()
                .read(cx)
                .grid
                .lock()
                .unwrap()
                .text()
                .contains("KEY"),
            _ => false,
        });
        if echoed {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "palette terminal must receive keyboard input through its real PTY"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    run(cx, "s e c o n d - r e p o");
    settled(&shell, cx);
    assert!(shell.read_with(cx, |s, _| {
        s.state
            .selected
            .as_deref()
            .unwrap()
            .ends_with("second-repo")
    }));
}

#[gpui::test]
fn palette_keyboard_workspace_command_is_filtered_and_cancel_keeps_focus(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("switch.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    run(cx, "n e w");
    cx.simulate_keystrokes("ctrl-shift-p");
    draw(cx);
    assert!(cx.debug_bounds("command-palette").is_some());
    cx.simulate_keystrokes("s e c o n d - r e p o");
    assert_eq!(shell.read_with(cx, |s, _| entries(s).len()), 1);
    cx.simulate_keystrokes("escape");
    assert!(shell.read_with(cx, |s, _| s.current().unwrap().composer));
    run(cx, "s e c o n d - r e p o");
    ready(&shell, cx);
    assert!(shell.read_with(cx, |s, _| {
        s.state
            .selected
            .as_deref()
            .unwrap()
            .ends_with("second-repo")
    }));
}

#[gpui::test]
fn palette_and_keyboard_workspace_frame_measurements(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("timing.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    let mut palette = vec![];
    for i in 0..30 {
        let start = Instant::now();
        cx.simulate_keystrokes(if i % 2 == 0 {
            "ctrl-shift-p"
        } else {
            "cmd-shift-p"
        });
        draw(cx);
        palette.push(start.elapsed().as_secs_f64() * 1000.);
        assert!(cx.debug_bounds("command-palette").is_some());
        assert!(shell.read_with(cx, |s, _| s.painted.get() == s.revision));
        cx.simulate_keystrokes("escape");
    }
    let workspaces = shell.read_with(cx, |s, _| s.workspaces.clone());
    let mut switching = vec![];
    for i in 0..20 {
        let target = workspaces[(i + 1) % 2].clone();
        let name = std::path::Path::new(&target)
            .file_name()
            .unwrap()
            .to_string_lossy();
        let keys = name
            .chars()
            .map(|c| c.to_string())
            .collect::<Vec<_>>()
            .join(" ");
        cx.simulate_keystrokes("ctrl-shift-p");
        cx.simulate_keystrokes(&keys);
        draw(cx);
        let start = Instant::now();
        cx.simulate_keystrokes("enter");
        settled(&shell, cx);
        switching.push(start.elapsed().as_secs_f64() * 1000.);
        assert_eq!(
            shell.read_with(cx, |s, _| s.state.selected.clone()),
            Some(target)
        );
    }
    println!(
        "O8_NEXT_PALETTE_EVIDENCE {}",
        json!({
            "endpoint":"GPUI TestAppContext CPU scene; debug build; test text; no GPU/compositor", "platform":std::env::consts::OS,
            "paletteOpenToFrameMs":palette,"keyboardWorkspaceSwitchMs":switching,
        })
    );
}

#[gpui::test]
fn round1_focused_text_field_keeps_ctrl_and_cmd_k(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("editor-keys.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    run(cx, "n e w");
    cx.simulate_input("editor draft");
    let observed = Rc::new(Cell::new(0));
    let count = observed.clone();
    let _subscription = cx.update(|_, cx| {
        cx.observe_keystrokes(move |event, _, _| {
            if event.keystroke.key == "k" {
                count.set(count.get() + 1);
            }
        })
    });
    for chord in ["ctrl-k", "cmd-k"] {
        cx.simulate_keystrokes(chord);
        assert!(
            !shell.read_with(cx, |s, _| s.palette),
            "a focused text field owns its shortcut"
        );
    }
    assert_eq!(
        observed.get(),
        2,
        "both keys must traverse the focused text field"
    );
    cx.simulate_input(" retained");
    assert_eq!(
        shell.read_with(cx, |s, cx| match &s.content[&s.key(&s.active().unwrap())] {
            Content::Session(v) => v.read(cx).shell_issue_state(cx)["draft"].clone(),
            _ => panic!("session"),
        }),
        json!("editor draft retained")
    );
}

#[gpui::test]
fn round1_focused_pty_receives_ctrl_k(cx: &mut TestAppContext) {
    let fixture = Fixture::start_mode(false, "--terminal");
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("terminal-keys.json"),
        State::default(),
        cx,
    );
    let cx = &mut visual;
    ready(&shell, cx);
    run(cx, "t e r m i n a l");
    settled(&shell, cx);
    cx.simulate_keystrokes("enter");
    settled(&shell, cx);
    cx.simulate_keystrokes("ctrl-k");
    assert!(
        !shell.read_with(cx, |s, _| s.palette),
        "a focused PTY owns Ctrl+K"
    );
    cx.simulate_keystrokes("enter");
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        shell.update_in(cx, |s, w, cx| s.tick(false, w, cx));
        draw(cx);
        if shell.read_with(cx, |s, cx| match &s.content[&s.key(&Tab::Terminal)] {
            Content::Terminal(v) => v
                .read(cx)
                .child
                .as_ref()
                .unwrap()
                .read(cx)
                .grid
                .lock()
                .unwrap()
                .text()
                .contains("CTRL-K"),
            _ => false,
        }) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the real PTY must acknowledge byte 0x0b"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[gpui::test]
fn round1_palette_owns_workspace_commands_and_renderer(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("palette-module.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    run(&mut visual, "s e c o n d - r e p o");
    ready(&shell, &mut visual);
    assert!(shell.read_with(&visual, |s, _| {
        s.state
            .selected
            .as_deref()
            .unwrap()
            .ends_with("second-repo")
    }));
    assert!(
        !include_str!("../surface_registry.rs").contains("Workspace(String)"),
        "workspace commands belong to their registered module"
    );
    assert!(!include_str!("../shell.rs").contains("Command::Workspace"));
    assert_eq!(
        include_str!("../shell.rs")
            .lines()
            .filter(|line| line.contains("surfaces/palette.rs"))
            .count(),
        1
    );
}

#[gpui::test]
fn round1_reading_surface_can_open_palette_with_ctrl_k(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("reading-keys.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    assert!(
        shell.read_with(&visual, |s, _| s.palette),
        "reading focus keeps the existing palette shortcut"
    );
    visual.simulate_keystrokes("escape");
    run(&mut visual, "g r i d");
    settled(&shell, &mut visual);
    visual.simulate_keystrokes("ctrl-k");
    assert!(
        shell.read_with(&visual, |s, _| s.palette),
        "a read-only grid keeps Ctrl+K"
    );
}
