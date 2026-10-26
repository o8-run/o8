use super::*;

fn tabs(shell: &Entity<Shell>, cx: &VisualTestContext) -> (Vec<Tab>, usize) {
    shell.read_with(cx, |s, _| {
        let saved = s.current().unwrap();
        (saved.tabs.clone(), saved.active)
    })
}

fn saved_tabs(file: &std::path::Path, workspace: &str) -> (Vec<Tab>, usize) {
    let state = State::load(file).unwrap();
    let saved = &state.workspaces[workspace];
    (saved.tabs.clone(), saved.active)
}

#[gpui::test]
fn shortcuts_settings_control_w_preserves_live_and_persisted_tabs(cx: &mut TestAppContext) {
    let fixture = Fixture::start(true);
    let file = fixture.root.join("settings-close.json");
    let (shell, mut visual) = open(fixture.client.clone(), file.clone(), State::default(), cx);
    ready(&shell, &mut visual);
    let workspace = shell.read_with(&visual, |s, _| s.state.selected.clone().unwrap());
    let before = tabs(&shell, &visual);
    assert_eq!(before.0.len(), 1);
    assert_eq!(saved_tabs(&file, &workspace), before);
    visual.simulate_keystrokes("cmd-,");
    shortcuts_draw(&mut visual);
    assert!(shell.read_with(&visual, |s, _| s.surfaces.settings.view.is_some()));
    visual.simulate_keystrokes("ctrl-w");
    shortcuts_draw(&mut visual);
    assert_eq!(
        tabs(&shell, &visual),
        before,
        "Settings owns Ctrl+W; its underlying tab must survive"
    );
    assert_eq!(
        saved_tabs(&file, &workspace),
        before,
        "tab survives restart"
    );
}

#[gpui::test]
fn shortcuts_modal_surfaces_keep_all_tab_chords_off_underlying_tabs(cx: &mut TestAppContext) {
    let mut bindings = vec![
        "ctrl-w".to_owned(),
        "cmd-w".into(),
        "ctrl-shift-w".into(),
        "cmd-alt-left".into(),
        "cmd-alt-right".into(),
        "ctrl-tab".into(),
        "ctrl-shift-tab".into(),
    ];
    for modifier in ["cmd", "ctrl"] {
        for digit in 1..=9 {
            bindings.push(format!("{modifier}-{digit}"));
        }
    }
    let mut failures = vec![];
    for surface in [
        "settings",
        "projects",
        "setup",
        "help",
        "palette",
        "shell-help",
    ] {
        // Keep each owned server comfortably inside its fixture lifetime.
        for (batch, bindings) in bindings.chunks(4).enumerate() {
            let fixture = Fixture::start(true);
            for (index, binding) in bindings.iter().enumerate() {
                let file = fixture.root.join(format!("modal-{batch}-{index}.json"));
                let (shell, mut visual) =
                    open(fixture.client.clone(), file.clone(), State::default(), cx);
                ready(&shell, &mut visual);
                // Two real session tabs make cycling and numbered selection observable.
                let workspace = shell.update_in(&mut visual, |s, window, cx| {
                    let workspace = s.state.selected.clone().unwrap();
                    let other = s
                        .sessions
                        .iter()
                        .find(|session| {
                            !s.current()
                                .unwrap()
                                .tabs
                                .contains(&Tab::Session(session.id.clone()))
                        })
                        .unwrap();
                    s.state
                        .workspaces
                        .get_mut(&workspace)
                        .unwrap()
                        .tabs
                        .push(Tab::Session(other.id.clone()));
                    s.focus.focus(window);
                    s.persist();
                    cx.notify();
                    workspace
                });
                let before = tabs(&shell, &visual);
                match surface {
                    "settings" => visual.simulate_keystrokes("cmd-,"),
                    "projects" => shortcuts_click(&mut visual, "shell-projects"),
                    "setup" => shortcuts_click(&mut visual, "setup-open"),
                    "help" => shortcuts_click(&mut visual, "shortcuts-open"),
                    "palette" => visual.simulate_keystrokes("cmd-shift-p"),
                    "shell-help" => shell.update_in(&mut visual, |s, window, cx| {
                        s.execute(Command::Shortcuts, window, cx)
                    }),
                    _ => unreachable!(),
                }
                shortcuts_draw(&mut visual);
                assert!(
                    shell.read_with(&visual, |s, _| s.palette
                        || s.shortcuts
                        || registrations().iter().any(|r| (r.overlay_open)(s))),
                    "{surface} must be open"
                );
                visual.simulate_keystrokes(binding);
                shortcuts_draw(&mut visual);
                let mut expected = before.clone();
                let projects_navigation = surface == "projects" && !binding.ends_with('w');
                if projects_navigation {
                    expected.1 = usize::from(
                        binding.ends_with("tab")
                            || binding.ends_with("left")
                            || binding.ends_with("right")
                            || binding.ends_with("-2"),
                    );
                }
                let dismissed = !projects_navigation
                    || shell.read_with(&visual, |s, _| !s.surfaces.projects.open);
                if tabs(&shell, &visual) != expected
                    || saved_tabs(&file, &workspace) != expected
                    || !dismissed
                {
                    failures.push(format!("{surface}: {binding}"));
                }
                visual.update(|window, _| window.remove_window());
            }
        }
    }
    assert!(
        failures.is_empty(),
        "modal tab shortcut ordering: {failures:?}"
    );
}
