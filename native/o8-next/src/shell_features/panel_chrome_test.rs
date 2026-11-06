use super::*;
use crate::shell::test_support::*;
use gpui::Modifiers;
struct PanelChromeTests;
register_shell_feature!(PanelChromeTests);
impl ShellFeature for PanelChromeTests {}
fn bounds(v: &mut VisualTestContext, id: &str) -> Bounds<gpui::Pixels> {
    draw(v);
    v.debug_bounds(Box::leak(id.to_owned().into_boxed_str()))
        .unwrap_or_else(|| panic!("missing {id}"))
}
fn click(v: &mut VisualTestContext, id: &str) {
    let b = bounds(v, id);
    v.simulate_click(b.center(), Modifiers::default());
    settle(v);
}
fn settle(v: &mut VisualTestContext) {
    let until = Instant::now() + Duration::from_millis(285);
    while Instant::now() < until {
        v.run_until_parked();
        draw(v);
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn setup(cx: &mut TestAppContext) -> (Fixture, Entity<Shell>, VisualTestContext) {
    let f = Fixture::new();
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("panel-chrome.json"),
        crate::shell_state::State::default(),
        cx,
    );
    ready(&s, &mut v);
    v.simulate_resize(size(px(1600.), px(1000.)));
    settle(&mut v);
    click(&mut v, "header-right-panel");
    (f, s, v)
}
fn saved(f: &Fixture) -> Value {
    serde_json::from_slice(&fs::read(f.root.join("panel-chrome.json")).unwrap()).unwrap()
}
#[gpui::test]
fn panel_chrome_launcher_disclosure_and_distinct_drawer(cx: &mut TestAppContext) {
    let (_f, _s, mut v) = setup(cx);
    assert!(
        v.debug_bounds("panel-tool-activity").is_none(),
        "only seven everyday tools initially"
    );
    click(&mut v, "panel-launcher-more");
    bounds(&mut v, "panel-tool-activity");
    click(&mut v, "panel-launcher-more");
    assert!(v.debug_bounds("panel-tool-activity").is_none());
    click(&mut v, "panel-tool-devices");
    click(&mut v, "panel-new-tab");
    bounds(&mut v, "panel-launcher-more");
    assert!(v.debug_bounds("panel-add-menu").is_none());
    click(&mut v, "panel-more-views");
    assert_eq!(bounds(&mut v, "panel-add-menu").size.width, px(340.));
    let a = bounds(&mut v, "panel-add-files");
    let b = bounds(&mut v, "panel-add-activity");
    assert!(b.left() > a.right());
    v.simulate_keystrokes("end enter");
    settle(&mut v);
    bounds(&mut v, "panel-tab-close-targeting");
}
#[gpui::test]
fn panel_chrome_tabs_geometry_keyboard_close_and_saved_restore(cx: &mut TestAppContext) {
    let (f, _s, mut v) = setup(cx);
    click(&mut v, "panel-launcher-more");
    click(&mut v, "panel-tool-activity");
    click(&mut v, "panel-more-views");
    click(&mut v, "panel-add-resources");
    // ContextualPanel's tab close is a 16px X.
    assert_eq!(
        bounds(&mut v, "panel-tab-close-resources").size,
        size(px(16.), px(16.))
    );
    click(&mut v, "panel-tab-select-activity");
    v.simulate_keystrokes("end delete");
    settle(&mut v);
    assert!(v.debug_bounds("panel-tab-close-resources").is_none());
    let data = saved(&f);
    assert_eq!(data["right_panel"]["primary"], "activity");
    let state: crate::shell_state::State = serde_json::from_value(data).unwrap();
    let (_second, mut relaunched) = open(
        f.client.clone(),
        f.root.join("relaunch.json"),
        state,
        &mut v.cx,
    );
    settle(&mut relaunched);
    bounds(&mut relaunched, "panel-tab-close-activity");
    bounds(&mut relaunched, "panel-content");
    assert_eq!(
        relaunched.debug_opacity("panel-content"),
        Some(1.),
        "restored content must paint fully opaque, not only retain bounds"
    );
}
#[gpui::test]
fn panel_chrome_split_picker_ratio_keyboard_and_relaunch(cx: &mut TestAppContext) {
    let (f, _s, mut v) = setup(cx);
    click(&mut v, "panel-tool-devices");
    click(&mut v, "panel-split");
    bounds(&mut v, "panel-split-body");
    click(&mut v, "panel-lower-picker");
    v.simulate_keystrokes("end enter");
    settle(&mut v);
    click(&mut v, "panel-split-resize");
    v.simulate_keystrokes("home down");
    settle(&mut v);
    assert_eq!(saved(&f)["right_panel"]["ratio"], 30.);
    assert_eq!(saved(&f)["right_panel"]["secondary"], "targeting");
    let state: crate::shell_state::State = serde_json::from_value(saved(&f)).unwrap();
    let (_, mut relaunched) = open(
        f.client.clone(),
        f.root.join("split-relaunch.json"),
        state,
        &mut v.cx,
    );
    settle(&mut relaunched);
    bounds(&mut relaunched, "panel-split-ratio-30");
    let data: Value =
        serde_json::from_slice(&fs::read(f.root.join("split-relaunch.json")).unwrap()).unwrap();
    assert_eq!(data["right_panel"]["primary"], "devices");
    assert_eq!(data["right_panel"]["secondary"], "targeting");
}
#[gpui::test]
fn panel_chrome_threads_stays_out_of_the_launcher_and_saved_layouts(cx: &mut TestAppContext) {
    let fresh = crate::shell_state::State::default().right_panel;
    assert!(fresh.primary != "threads" && fresh.secondary != "threads");
    let (f, _s, mut v) = setup(cx);
    click(&mut v, "panel-launcher-more");
    bounds(&mut v, "panel-tool-targeting");
    assert!(v.debug_bounds("panel-tool-threads").is_none());
    click(&mut v, "panel-tool-resources");
    click(&mut v, "panel-more-views");
    bounds(&mut v, "panel-add-targeting");
    assert!(v.debug_bounds("panel-add-threads").is_none());
    // A layout saved before Threads was hidden: Threads on top, a Threads
    // tab, and Threads in the bottom half.
    let mut data = saved(&f);
    let panel = &mut data["right_panel"];
    panel["primary"] = "threads".into();
    panel["split"] = true.into();
    panel["secondary"] = "threads".into();
    let scopes: Vec<String> = panel["utility_tabs"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    assert!(!scopes.is_empty());
    for scope in scopes {
        panel["utility_tabs"][&scope] = json!(["threads", "resources"]);
        panel["secondary_tabs"][&scope] = json!(["threads"]);
    }
    let state: crate::shell_state::State = serde_json::from_value(data).unwrap();
    let (_, mut relaunched) = open(
        f.client.clone(),
        f.root.join("hidden-relaunch.json"),
        state,
        &mut v.cx,
    );
    settle(&mut relaunched);
    bounds(&mut relaunched, "panel-tab-close-resources");
    assert!(relaunched.debug_bounds("panel-tab-close-threads").is_none());
    assert!(
        relaunched
            .debug_bounds("panel-tab-select-threads")
            .is_none()
    );
    assert!(relaunched.debug_bounds("panel-split-body").is_none());
    let data: Value =
        serde_json::from_slice(&fs::read(f.root.join("hidden-relaunch.json")).unwrap()).unwrap();
    let panel = &data["right_panel"];
    assert_eq!(panel["primary"], "resources");
    assert_eq!(panel["split"], false);
    for tabs in ["utility_tabs", "secondary_tabs"] {
        let text = panel[tabs].to_string();
        assert!(!text.contains("threads"), "{text}");
    }
}
#[gpui::test]
fn panel_chrome_maximize_escape_and_narrow_guard(cx: &mut TestAppContext) {
    let (_f, _s, mut v) = setup(cx);
    click(&mut v, "panel-tool-devices");
    let before = bounds(&mut v, "header-right-panel").left();
    click(&mut v, "panel-maximize");
    assert!(bounds(&mut v, "panel-new-tab").left() < before);
    let body = bounds(&mut v, "panel-content");
    assert!(
        body.right() <= px(1600.),
        "maximized body must fit inside the window: {body:?}"
    );
    v.simulate_keystrokes("escape");
    settle(&mut v);
    bounds(&mut v, "panel-tabs");
    v.simulate_resize(size(px(1100.), px(816.)));
    settle(&mut v);
    assert!(v.debug_bounds("panel-tabs").is_none());
    click(&mut v, "header-right-panel");
    assert!(v.debug_bounds("panel-tabs").is_none());
    v.simulate_resize(size(px(1600.), px(1000.)));
    settle(&mut v);
    bounds(&mut v, "panel-tabs");
}
#[gpui::test]
fn panel_chrome_browser_pages_are_separate_from_utility_tabs(cx: &mut TestAppContext) {
    let (f, _s, mut v) = setup(cx);
    click(&mut v, "panel-tool-devices");
    click(&mut v, "panel-more-views");
    click(&mut v, "panel-add-browser-page");
    bounds(&mut v, "panel-browser-pages");
    assert!(v.debug_bounds("panel-tab-close-browser").is_none());
    assert!(
        !saved(&f)["right_panel"]["utility_tabs"]
            .to_string()
            .contains("browser")
    );
}
#[gpui::test]
fn panel_chrome_drawer_escape_tab_and_outside_click(cx: &mut TestAppContext) {
    let (_f, _s, mut v) = setup(cx);
    click(&mut v, "panel-more-views");
    v.simulate_keystrokes("escape");
    settle(&mut v);
    assert!(v.debug_bounds("panel-add-menu").is_none());
    v.simulate_keystrokes("enter");
    settle(&mut v);
    bounds(&mut v, "panel-add-menu");
    v.simulate_keystrokes("tab");
    settle(&mut v);
    assert!(v.debug_bounds("panel-add-menu").is_none());
    click(&mut v, "panel-more-views");
    v.simulate_click(point(px(450.), px(500.)), Modifiers::default());
    settle(&mut v);
    assert!(v.debug_bounds("panel-add-menu").is_none());
}

#[gpui::test]
fn panel_chrome_widths_keep_ordinary_and_wide_tool_memory(cx: &mut TestAppContext) {
    let (f, _s, mut v) = setup(cx);
    click(&mut v, "panel-tool-devices");
    let wide = bounds(&mut v, "panel-resize").left();
    click(&mut v, "panel-resize");
    v.simulate_keystrokes("left");
    settle(&mut v);
    assert_eq!(saved(&f)["right_panel"]["tool_widths"]["device"], 616.);
    click(&mut v, "panel-more-views");
    click(&mut v, "panel-add-activity");
    assert!(bounds(&mut v, "panel-resize").left() > wide);
    click(&mut v, "panel-resize");
    v.simulate_keystrokes("right");
    settle(&mut v);
    assert_eq!(saved(&f)["right_panel_width"], 424.);
    click(&mut v, "panel-tab-select-devices");
    assert_eq!(bounds(&mut v, "panel-resize").left(), wide - px(16.));
}
fn surface(s: &Entity<Shell>, v: &mut VisualTestContext, data: Value) {
    let frame = json!({"kind":"symon-ui","payload":{"data":data}});
    s.update_in(v, |s, w, cx| s.ui_command(&frame, w, cx));
    settle(v);
}
#[gpui::test]
fn panel_chrome_missing_repository_opens_explanation_and_context_destinations(
    cx: &mut TestAppContext,
) {
    let (_f, s, mut v) = setup(cx);
    s.update_in(&mut v, |s, _, cx| {
        s.state.selected = None;
        cx.notify();
    });
    settle(&mut v);
    click(&mut v, "panel-tool-files");
    bounds(&mut v, "panel-no-repository");
    surface(&s, &mut v, json!({"surface":"compare"}));
    bounds(&mut v, "panel-comparison");
    surface(
        &s,
        &mut v,
        json!({"surface":"prs","repo":"example/project","number":12}),
    );
    bounds(&mut v, "panel-pr-example/project-12");
}

fn bang_run(
    cx: &mut TestAppContext,
) -> (
    Fixture,
    Entity<Shell>,
    Entity<crate::ui::Surface>,
    Entity<crate::terminal::Pane>,
    VisualTestContext,
) {
    bang_line(cx, "sleep 30")
}

fn bang_line(
    cx: &mut TestAppContext,
    line: &str,
) -> (
    Fixture,
    Entity<Shell>,
    Entity<crate::ui::Surface>,
    Entity<crate::terminal::Pane>,
    VisualTestContext,
) {
    let f = Fixture::start_mode(false, "--terminal");
    let (s, mut v) = open(
        f.client.clone(),
        f.root.join("shell-focus.json"),
        crate::shell_state::State::default(),
        cx,
    );
    v.simulate_resize(size(px(1600.), px(1000.)));
    ready(&s, &mut v);
    let composer = s.read_with(&v, |s, _| match &s.content[&s.key(&s.active().unwrap())] {
        Content::Session(view) => view.clone(),
        _ => panic!("selected chat"),
    });
    s.update(&mut v, |s, _| {
        s.state
            .workspaces
            .get_mut(s.state.selected.as_ref().unwrap())
            .unwrap()
            .surfaces
            .terminal
            .terminal_session = Some("cortex-next-terminal-fixture".into());
    });
    click(&mut v, "composer-input");
    v.simulate_input(&format!("!{line}"));
    // No completion menu can consume Return: the trailing argument has no match.
    settle(&mut v);
    v.simulate_keystrokes("enter");
    let until = Instant::now() + Duration::from_secs(30);
    let pane = loop {
        v.run_until_parked();
        s.update_in(&mut v, |s, w, cx| s.tick(true, w, cx));
        draw(&mut v);
        let pane = s.read_with(&v, |s, cx| {
            let key = format!("panel|{}|Terminal", s.state.selected.as_deref().unwrap());
            match s.content.get(&key) {
                Some(Content::Terminal(view)) => view.read(cx).child.clone(),
                _ => None,
            }
        });
        if let Some(pane) = pane
            && pane.read_with(&v, |p, _| p.command_output(line).is_some())
        {
            break pane;
        }
        assert!(Instant::now() < until, "terminal must receive the ! line");
        std::thread::sleep(Duration::from_millis(10));
    };
    (f, s, composer, pane, v)
}

fn composer_focused(view: &Entity<crate::ui::Surface>, v: &mut VisualTestContext) -> bool {
    view.update_in(v, |s, w, cx| s.shell_selection(w, cx).1)
}

#[gpui::test]
fn panel_chrome_bang_line_keeps_composer_focus_and_escape_stops_terminal(cx: &mut TestAppContext) {
    let (_f, s, composer, pane, mut v) = bang_run(cx);
    assert!(
        composer_focused(&composer, &mut v),
        "Return must keep the composer focused after the terminal attaches"
    );
    bounds(&mut v, "composer-shell-status-running");
    v.simulate_keystrokes("escape");
    settle(&mut v);
    assert_eq!(
        composer.read_with(&v, |s, cx| s.shell_issue_state(cx)["shellStopped"].clone()),
        true
    );
    follow(&s, &composer, &mut v, |run| !run.running());
    bounds(&mut v, "composer-shell-status-stopped");
    assert!(
        composer
            .read_with(&v, |s, _| s.shell_run().unwrap().status(Instant::now()))
            .ends_with("· exit 130"),
        "the card shows the status the shell reported for the interrupt"
    );
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        s.update_in(&mut v, |s, w, cx| s.tick(true, w, cx));
        v.run_until_parked();
        if pane.read_with(&v, |p, _| {
            p.command_output("sleep 30")
                .unwrap()
                .lines
                .iter()
                .any(|line| line == "CTRL-C")
        }) {
            break;
        }
        assert!(
            Instant::now() < until,
            "Esc must deliver \x03 through the terminal transport to the PTY"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(composer_focused(&composer, &mut v));
    // Reusing an attached terminal via Send must also return to the composer.
    v.simulate_input("!sleep 30");
    settle(&mut v);
    click(&mut v, "send");
    settle(&mut v);
    assert!(composer_focused(&composer, &mut v));
    // An explicit terminal click keeps keyboard ownership there on later paints.
    click(&mut v, "panel-content");
    let terminal = pane.read_with(&v, |p, _| p.focus_handle());
    v.update(|w, _| assert!(terminal.is_focused(w)));
    v.simulate_keystrokes("escape");
    settle(&mut v);
    v.update(|w, _| assert!(terminal.is_focused(w)));
    assert_eq!(
        composer.read_with(&v, |s, cx| s.shell_issue_state(cx)["shellStopped"].clone()),
        false
    );
}

fn shell_button(
    composer: &Entity<crate::ui::Surface>,
    v: &mut VisualTestContext,
    id: &'static str,
) {
    let center = bounds(v, id).center();
    v.simulate_mouse_down(center, gpui::MouseButton::Left, Modifiers::default());
    assert!(
        composer_focused(composer, v),
        "{id} mouse-down must keep the composer focused"
    );
    v.simulate_mouse_up(center, gpui::MouseButton::Left, Modifiers::default());
    settle(v);
}

#[gpui::test]
fn panel_chrome_shell_add_returns_focus_to_composer(cx: &mut TestAppContext) {
    let (_f, _s, composer, _pane, mut v) = bang_run(cx);
    shell_button(&composer, &mut v, "composer-shell-add");
    assert!(
        composer_focused(&composer, &mut v),
        "Add to chat must return keyboard input to the draft"
    );
    v.simulate_input("next");
    let draft = composer.read_with(&v, |s, cx| {
        s.shell_issue_state(cx)["draft"]
            .as_str()
            .unwrap()
            .to_owned()
    });
    assert!(draft.starts_with("```console\n$ sleep 30\nsleeping\n```"));
    assert!(draft.ends_with("next"));
    assert!(v.debug_bounds("composer-shell-run").is_none());
}

#[gpui::test]
fn panel_chrome_shell_dismiss_returns_focus_to_composer(cx: &mut TestAppContext) {
    let (_f, _s, composer, _pane, mut v) = bang_run(cx);
    shell_button(&composer, &mut v, "composer-shell-dismiss");
    assert!(
        composer_focused(&composer, &mut v),
        "Dismiss must return keyboard input to the draft"
    );
    v.simulate_input("next");
    assert_eq!(
        composer.read_with(&v, |s, cx| s.shell_issue_state(cx)["draft"].clone()),
        "next"
    );
    assert!(v.debug_bounds("composer-shell-run").is_none());
}

/// Ticks the shell, as its pump does, until the card's run satisfies `done`.
fn follow(
    s: &Entity<Shell>,
    composer: &Entity<crate::ui::Surface>,
    v: &mut VisualTestContext,
    done: impl Fn(&crate::composer::shell::ShellRun) -> bool,
) {
    let until = Instant::now() + Duration::from_secs(20);
    loop {
        s.update_in(v, |s, w, cx| s.tick(true, w, cx));
        v.run_until_parked();
        draw(v);
        if composer.read_with(v, |c, _| c.shell_run().is_some_and(&done)) {
            return;
        }
        assert!(
            Instant::now() < until,
            "shell card timed out: {:?}",
            composer.read_with(v, |c, _| c.shell_run().cloned())
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[gpui::test]
fn panel_chrome_shell_card_is_kept_with_its_thread_once_it_finishes(cx: &mut TestAppContext) {
    let root = crate::shell::test_support::scratch_path("o8-shell-card-kept");
    cx.update(|cx| cx.set_global(crate::composer::mode_store::TestRoot(root)));
    let (_f, s, composer, _pane, mut v) = bang_line(cx, "ticks");
    assert!(
        composer.read_with(&v, |c, cx| c.shell_saved(cx)).is_none(),
        "nothing is kept while it runs"
    );
    follow(&s, &composer, &mut v, |run| !run.running());
    let saved = composer
        .read_with(&v, |c, cx| c.shell_saved(cx))
        .expect("a finished card is kept for the next launch");
    assert_eq!(saved.line, "ticks");
    assert_eq!(saved.output, ["tick 1", "tick 2 on stderr", "tick 3"]);
    assert_eq!(saved.exit, Some(3));
    assert!(saved.took_ms >= 1_000, "{saved:?}");
}

#[gpui::test]
fn panel_chrome_shell_card_streams_output_clock_and_exit(cx: &mut TestAppContext) {
    let (_f, s, composer, _pane, mut v) = bang_line(cx, "ticks");
    follow(&s, &composer, &mut v, |run| {
        run.output.iter().any(|line| line == "tick 1")
    });
    let (running, output) = composer.read_with(&v, |c, _| {
        let run = c.shell_run().unwrap();
        (run.running(), run.output.clone())
    });
    assert!(running, "the first line shows while the command still runs");
    assert!(!output.contains(&"tick 3".to_owned()), "{output:?}");
    bounds(&mut v, "composer-shell-status-running");
    bounds(&mut v, "composer-shell-output");
    bounds(&mut v, "composer-shell-stop");
    follow(&s, &composer, &mut v, |run| {
        run.output.iter().any(|line| line == "tick 2 on stderr")
    });
    follow(&s, &composer, &mut v, |run| !run.running());
    let run = composer.read_with(&v, |c, _| c.shell_run().unwrap().clone());
    assert_eq!(run.output, ["tick 1", "tick 2 on stderr", "tick 3"]);
    assert_eq!(run.exit, Some(3));
    assert!(
        run.took.unwrap() >= Duration::from_millis(1_000),
        "the clock covers the run: {:?}",
        run.took
    );
    assert!(run.status(Instant::now()).starts_with("Finished · "));
    assert!(run.status(Instant::now()).ends_with(" · exit 3"));
    bounds(&mut v, "composer-shell-status-finished");
    assert!(
        v.debug_bounds("composer-shell-stop").is_none(),
        "a finished run has nothing to stop"
    );
    shell_button(&composer, &mut v, "composer-shell-copy");
    assert_eq!(
        v.cx.read_from_clipboard().and_then(|item| item.text()),
        Some("$ ticks\ntick 1\ntick 2 on stderr\ntick 3".to_owned())
    );
    assert_eq!(
        composer.read_with(&v, |s, cx| s.shell_issue_state(cx)["draft"].clone()),
        "",
        "the run never went to the chat by itself"
    );
    shell_button(&composer, &mut v, "composer-shell-add");
    let draft = composer.read_with(&v, |s, cx| {
        s.shell_issue_state(cx)["draft"]
            .as_str()
            .unwrap()
            .to_owned()
    });
    assert_eq!(
        draft,
        "```console\n$ ticks\ntick 1\ntick 2 on stderr\ntick 3\n```\n\n"
    );
}

#[gpui::test]
fn panel_chrome_shell_card_stop_interrupts_the_run(cx: &mut TestAppContext) {
    let (_f, s, composer, pane, mut v) = bang_run(cx);
    follow(&s, &composer, &mut v, |run| {
        run.output.iter().any(|line| line == "sleeping")
    });
    shell_button(&composer, &mut v, "composer-shell-stop");
    assert_eq!(
        composer.read_with(&v, |c, _| c.shell_run().unwrap().state()),
        "stopping"
    );
    follow(&s, &composer, &mut v, |run| !run.running());
    assert!(pane.read_with(&v, |p, _| {
        p.command_output("sleep 30")
            .unwrap()
            .lines
            .contains(&"CTRL-C".to_owned())
    }));
    let run = composer.read_with(&v, |c, _| c.shell_run().unwrap().clone());
    assert_eq!((run.state(), run.exit), ("stopped", Some(130)));
    bounds(&mut v, "composer-shell-status-stopped");
}
