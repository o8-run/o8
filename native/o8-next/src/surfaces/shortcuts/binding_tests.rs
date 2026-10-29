use super::*;

// Parse the strings rendered by the dialog, not a second inventory of keys.
// Unknown notation fails instead of silently dropping an advertised binding.
fn displayed_chords(display: &str) -> Vec<String> {
    display
        .split('·')
        .map(str::trim)
        .flat_map(|part| part.split(" / "))
        .flat_map(|part| {
            let part = part.trim();
            if part.contains("1–9") {
                (1..=9)
                    .map(|digit| part.replace("1–9", &digit.to_string()))
                    .collect::<Vec<_>>()
            } else {
                vec![part.to_owned()]
            }
        })
        .map(|chord| {
            let key = chord
                .replace("⌘ ", "cmd-")
                .replace("⌥ ", "alt-")
                .replace('←', "left")
                .replace('→', "right")
                .replace("Esc", "escape")
                .to_lowercase();
            gpui::Keystroke::parse(&key).expect("every displayed chord must be parseable");
            key
        })
        .collect()
}

#[gpui::test]
fn shortcuts_every_displayed_chord_has_a_live_binding(cx: &mut TestAppContext) {
    let fixture = Fixture::new();
    let mut checked = 0;
    for (_, label, display) in super::super::dialog::ROWS {
        for (index, chord) in displayed_chords(display).iter().enumerate() {
            let file = fixture.root.join(format!("displayed-{checked}.json"));
            let (shell, mut visual) =
                open(fixture.client.clone(), file.clone(), State::default(), cx);
            ready(&shell, &mut visual);
            // Seven real fixture sessions plus Grid and Brain make all nine
            // displayed tab numbers reachable, including a non-noop Cmd+1.
            let start = usize::from(*label == "Jump to tab 1–9" && index == 0);
            let tabs = shell.update_in(&mut visual, |s, window, cx| {
                let mut tabs = s
                    .sessions
                    .iter()
                    .map(|s| Tab::Session(s.id.clone()))
                    .collect::<Vec<_>>();
                tabs.extend([Tab::Grid, Tab::Brain]);
                assert_eq!(tabs.len(), 9, "nine disposable fixture tabs");
                let saved = s
                    .state
                    .workspaces
                    .get_mut(s.state.selected.as_ref().unwrap())
                    .unwrap();
                saved.tabs = tabs.clone();
                saved.active = start;
                saved.composer = false;
                s.ensure(window, cx);
                s.focus.focus(window);
                s.persist();
                cx.notify();
                tabs
            });
            shortcuts_draw(&mut visual);
            if *label == "Dismiss / close" {
                shortcuts_open(&mut visual);
            }
            visual.simulate_keystrokes(chord);
            shortcuts_draw(&mut visual);
            let live = shell.read_with(&visual, |s, _| match *label {
                "Command palette" => s.palette,
                "Cycle tabs" => s.current().unwrap().active == if index == 0 { 8 } else { 1 },
                "Jump to tab 1–9" => s.current().unwrap().active == index,
                "Close active tab" => s.current().unwrap().tabs == tabs[1..],
                "Show this help" => s.surfaces.shortcuts.view.is_some(),
                "Dismiss / close" => s.surfaces.shortcuts.view.is_none(),
                _ => panic!("add an outcome assertion for the displayed action {label}"),
            });
            assert!(
                live,
                "displayed {display:?} ({chord}) has no live {label} binding in its focus context"
            );
            if matches!(
                *label,
                "Cycle tabs" | "Jump to tab 1–9" | "Close active tab"
            ) {
                let persisted = State::load(&file).unwrap();
                shell.read_with(&visual, |s, _| {
                    let saved = &persisted.workspaces[s.state.selected.as_ref().unwrap()];
                    assert_eq!(
                        saved.tabs,
                        s.current().unwrap().tabs,
                        "{chord} persists the tabs"
                    );
                    assert_eq!(
                        saved.active,
                        s.current().unwrap().active,
                        "{chord} persists selection"
                    );
                });
            }
            if *label == "Dismiss / close" {
                // The same advertised Escape also dismisses the palette.
                visual.simulate_keystrokes("cmd-k");
                shortcuts_draw(&mut visual);
                assert!(shell.read_with(&visual, |s, _| s.palette));
                visual.simulate_keystrokes(chord);
                shortcuts_draw(&mut visual);
                assert!(!shell.read_with(&visual, |s, _| s.palette));
            }
            checked += 1;
            visual.update(|window, _| window.remove_window());
        }
    }
    assert_eq!(checked, 16, "exercise every expanded displayed chord");
    println!(
        "All {checked} displayed chords dispatch live actions in their advertised focus contexts."
    );
}
