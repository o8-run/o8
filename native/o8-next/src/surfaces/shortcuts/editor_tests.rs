//! The Shortcuts editor through the real shell, its state file and the
//! fixture's production settings route.
use super::*;

fn open_editor(cx: &mut VisualTestContext) {
    shortcuts_open(cx);
    shortcuts_click(cx, "shortcuts-customize");
    assert!(
        cx.debug_bounds("shortcuts-editor").is_some(),
        "Customize opens the editor"
    );
    assert!(
        cx.debug_bounds("keyboard-shortcuts").is_none(),
        "the reference closes"
    );
}
fn rebind(cx: &mut VisualTestContext, scope: &'static str, id: &str, chord: &str) {
    shortcuts_click(cx, scope);
    let selector: &'static str = format!("shortcut-capture-{id}").leak();
    shortcuts_click(cx, selector);
    cx.simulate_keystrokes(chord);
    shortcuts_draw(cx);
}
fn close_editor(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    cx.simulate_keystrokes("escape");
    shortcuts_draw(cx);
    assert!(cx.debug_bounds("shortcuts-editor").is_none());
    shell.update_in(cx, |s, window, cx| {
        s.focus.focus(window);
        cx.notify();
    });
    shortcuts_draw(cx);
}
fn palette_after(shell: &Entity<Shell>, cx: &mut VisualTestContext, chord: &str) -> bool {
    cx.simulate_keystrokes(chord);
    shortcuts_draw(cx);
    let open = shell.read_with(cx, |s, _| s.palette);
    if open {
        cx.simulate_keystrokes("escape");
        shortcuts_draw(cx);
    }
    open
}
fn wait(cx: &mut VisualTestContext, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let since = Instant::now();
    while !done(cx) {
        assert!(
            since.elapsed() < std::time::Duration::from_secs(15),
            "timed out"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
        shortcuts_draw(cx);
    }
}
fn row(shell: &Entity<Shell>, cx: &VisualTestContext, id: &str) -> super::super::keymap::Row {
    shell.read_with(cx, |s, _| {
        s.surfaces
            .shortcuts
            .bindings
            .keymap
            .row(id)
            .unwrap()
            .clone()
    })
}

#[gpui::test]
fn shortcuts_editor_rebinds_this_machine_live_and_after_restart(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let file = fixture.root.join("keymap-machine.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    ready(&shell, &mut visual);
    assert!(
        palette_after(&shell, &mut visual, "ctrl-k"),
        "the default chord works first"
    );
    open_editor(&mut visual);
    rebind(
        &mut visual,
        "shortcuts-scope-machine",
        "shell.palette",
        "alt-j",
    );
    let saved: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(
        saved["keybindings"]["shell.palette"], "alt-j",
        "this machine's state file"
    );
    let palette = row(&shell, &visual, "shell.palette");
    assert_eq!(palette.source.label(), "This machine");
    close_editor(&shell, &mut visual);
    // Applied live, without a restart.
    assert!(
        palette_after(&shell, &mut visual, "alt-j"),
        "the new chord opens the palette"
    );
    assert!(
        !palette_after(&shell, &mut visual, "ctrl-k"),
        "the old chord is released"
    );
    visual.update(|window, _| window.remove_window());

    let (shell, mut visual) = open(
        fixture.client.clone(),
        file.clone(),
        State::load(&file).unwrap(),
        cx,
    );
    ready(&shell, &mut visual);
    assert_eq!(
        row(&shell, &visual, "shell.palette").chord.as_deref(),
        Some("alt-j")
    );
    assert!(
        palette_after(&shell, &mut visual, "alt-j"),
        "the installed keymap survives restart"
    );
    open_editor(&mut visual);
    shortcuts_click(&mut visual, "shortcuts-scope-machine");
    shortcuts_click(&mut visual, "shortcut-reset-shell.palette");
    let saved: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert!(
        saved.get("keybindings").is_none(),
        "reset removes the override"
    );
    close_editor(&shell, &mut visual);
    assert!(
        palette_after(&shell, &mut visual, "ctrl-k"),
        "reset restores the default"
    );
    assert!(!palette_after(&shell, &mut visual, "alt-j"));
}

#[gpui::test]
fn shortcuts_editor_global_persists_in_settings_and_machine_wins(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let global = |fixture: &Fixture| -> Vec<String> {
        let data: Value = fixture
            .client
            .get("/api/panel/operator-defaults", &[("include", "native")])
            .unwrap();
        serde_json::from_value(data["values"]["nativeKeybindings"].clone()).unwrap_or_default()
    };
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("keymap-global-a.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    open_editor(&mut visual);
    rebind(
        &mut visual,
        "shortcuts-scope-global",
        "shell.palette",
        "alt-g",
    );
    rebind(
        &mut visual,
        "shortcuts-scope-global",
        "shell.sidebar",
        "ctrl-k",
    );
    assert!(
        visual
            .debug_bounds("shortcut-conflict-shell.palette")
            .is_none(),
        "the palette moved off Ctrl+K, so only the sidebar holds it"
    );
    rebind(&mut visual, "shortcuts-scope-global", "tab.close", "alt-g");
    assert!(
        visual
            .debug_bounds("shortcut-conflict-shell.palette")
            .is_some()
    );
    assert!(visual.debug_bounds("shortcut-conflict-tab.close").is_some());
    shortcuts_click(&mut visual, "shortcut-reset-tab.close");
    wait(&mut visual, |_| {
        let mut saved = global(&fixture);
        saved.sort();
        saved == ["shell.palette=alt-g", "shell.sidebar=ctrl-k"]
    });
    visual.update(|window, _| window.remove_window());

    // Another window on the same server installs the global override.
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("keymap-global-b.json"),
        State::default(),
        cx,
    );
    ready(&shell, &mut visual);
    wait(&mut visual, |cx| {
        row(&shell, cx, "shell.palette").source.label() == "Global"
    });
    assert!(palette_after(&shell, &mut visual, "alt-g"));
    open_editor(&mut visual);
    rebind(
        &mut visual,
        "shortcuts-scope-machine",
        "shell.palette",
        "alt-m",
    );
    assert_eq!(
        row(&shell, &visual, "shell.palette").source.label(),
        "This machine"
    );
    close_editor(&shell, &mut visual);
    assert!(
        palette_after(&shell, &mut visual, "alt-m"),
        "this machine beats global"
    );
    assert!(!palette_after(&shell, &mut visual, "alt-g"));

    open_editor(&mut visual);
    shortcuts_click(&mut visual, "shortcuts-scope-global");
    shortcuts_click(&mut visual, "shortcuts-reset-all");
    wait(&mut visual, |_| global(&fixture).is_empty());
    assert_eq!(
        row(&shell, &visual, "shell.sidebar").source.label(),
        "Default"
    );
    assert_eq!(
        row(&shell, &visual, "shell.palette").source.label(),
        "This machine"
    );
}

#[gpui::test]
fn shortcuts_rebound_palette_command_runs_only_outside_typing_and_overlays(
    cx: &mut TestAppContext,
) {
    let fixture = Fixture::new();
    let mut state = State::default();
    state
        .keybindings
        .insert("surface:Open settings".into(), "alt-o".into());
    let (shell, mut visual) = open(
        fixture.client.clone(),
        fixture.root.join("keymap-run.json"),
        state,
        cx,
    );
    ready(&shell, &mut visual);
    let settings =
        |cx: &VisualTestContext| shell.read_with(cx, |s, _| s.surfaces.settings.view.is_some());
    // With the palette open the key stays with the palette.
    visual.simulate_keystrokes("ctrl-k");
    shortcuts_draw(&mut visual);
    visual.simulate_keystrokes("alt-o");
    shortcuts_draw(&mut visual);
    assert!(!settings(&visual), "an open palette keeps the key");
    visual.simulate_keystrokes("escape");
    shortcuts_draw(&mut visual);
    // From the shell the override runs the palette command.
    shell.update_in(&mut visual, |s, window, cx| {
        s.focus.focus(window);
        cx.notify();
    });
    visual.simulate_keystrokes("alt-o");
    shortcuts_draw(&mut visual);
    assert!(settings(&visual), "the rebound palette command runs");
}
