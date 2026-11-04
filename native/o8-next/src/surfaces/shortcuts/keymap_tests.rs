use super::*;

fn key(text: &str) -> Keystroke {
    Keystroke::parse(text).unwrap()
}
fn down(text: &str) -> KeyDownEvent {
    KeyDownEvent {
        keystroke: key(text),
        is_held: false,
    }
}
fn commands() -> Vec<Command> {
    let mut commands = builtin_commands();
    commands.push(Command {
        id: "surface:Open settings".into(),
        label: "Settings".into(),
        default: None,
    });
    commands
}
fn model() -> Model {
    Model::new(commands(), Overrides::default())
}
fn rebind(model: &mut Model, id: &str, scope: Scope, chord: &str) -> Option<Scope> {
    model.set_scope(scope);
    model.begin(id);
    model.capture(&key(chord))
}

#[test]
fn keymap_rebind_captures_a_chord_in_the_selected_scope() {
    let mut model = model();
    assert_eq!(
        rebind(&mut model, "shell.palette", Scope::Global, "alt-j"),
        Some(Scope::Global)
    );
    let row = model.keymap.row("shell.palette").unwrap();
    assert_eq!(
        (row.chord.as_deref(), row.source),
        (Some("alt-j"), Source::Global)
    );
    assert_eq!(model.capturing, None);
    assert_eq!(model.overrides.global["shell.palette"], "alt-j");
    assert!(model.overrides.machine.is_empty());
}

#[test]
fn keymap_capture_refuses_plain_typing_keys_and_escape_cancels() {
    let mut model = model();
    assert_eq!(
        rebind(&mut model, "shell.palette", Scope::Global, "j"),
        None
    );
    assert!(
        model.notice.is_some(),
        "a plain key explains why it was refused"
    );
    assert_eq!(model.capturing.as_deref(), Some("shell.palette"));
    assert_eq!(model.capture(&key("shift-j")), None);
    assert_eq!(
        model.capture(&key("f5")),
        Some(Scope::Global),
        "function keys bind"
    );
    model.begin("shell.palette");
    assert_eq!(model.capture(&key("escape")), None);
    assert_eq!(model.capturing, None);
    assert_eq!(
        model.keymap.row("shell.palette").unwrap().chord.as_deref(),
        Some("f5")
    );
}

#[test]
fn keymap_conflicts_are_shown_on_both_rows_and_the_stronger_source_runs() {
    let mut model = model();
    let palette = parse("secondary-k").unwrap();
    rebind(&mut model, "shell.sidebar", Scope::Global, "secondary-k");
    let notice = model.notice.clone().unwrap();
    assert!(notice.contains("Command palette"), "{notice}");
    assert_eq!(
        model.keymap.row("shell.sidebar").unwrap().conflicts,
        ["Command palette"]
    );
    assert_eq!(
        model.keymap.row("shell.palette").unwrap().conflicts,
        ["Show or hide the sidebar"]
    );
    assert_eq!(
        model.keymap.command_for(&palette).unwrap().id,
        "shell.sidebar"
    );
    rebind(&mut model, "shell.palette", Scope::Machine, "secondary-k");
    assert_eq!(
        model.keymap.command_for(&palette).unwrap().id,
        "shell.palette"
    );
}

#[test]
fn keymap_scope_precedence_is_machine_then_global_then_default() {
    let mut model = model();
    rebind(&mut model, "tab.close", Scope::Global, "alt-q");
    rebind(&mut model, "tab.close", Scope::Machine, "alt-x");
    let row = model.keymap.row("tab.close").unwrap();
    assert_eq!(
        (row.chord.as_deref(), row.source),
        (Some("alt-x"), Source::Machine)
    );
    model.set_scope(Scope::Machine);
    assert_eq!(model.reset("tab.close"), Some(Scope::Machine));
    let row = model.keymap.row("tab.close").unwrap();
    assert_eq!(
        (row.chord.as_deref(), row.source),
        (Some("alt-q"), Source::Global)
    );
    model.set_scope(Scope::Global);
    assert_eq!(model.reset("tab.close"), Some(Scope::Global));
    let row = model.keymap.row("tab.close").unwrap();
    assert_eq!(row.chord, parse("secondary-w"));
    assert_eq!(row.source, Source::Default);
    assert_eq!(model.reset("tab.close"), None, "nothing left to reset");
}

#[test]
fn keymap_reset_all_clears_only_the_selected_scope() {
    let mut model = model();
    rebind(&mut model, "shell.palette", Scope::Global, "alt-j");
    rebind(&mut model, "shell.sidebar", Scope::Global, "alt-s");
    rebind(&mut model, "tab.next", Scope::Machine, "alt-n");
    model.set_scope(Scope::Global);
    assert_eq!(model.reset_all(), Some(Scope::Global));
    assert!(model.overrides.global.is_empty());
    assert_eq!(
        model.keymap.row("tab.next").unwrap().source,
        Source::Machine
    );
    assert!(
        model
            .keymap
            .rows
            .iter()
            .filter(|r| r.id != "tab.next")
            .all(|r| r.source == Source::Default)
    );
    assert_eq!(model.reset_all(), None);
}

#[test]
fn keymap_global_entries_round_trip_and_drop_unreadable_ones() {
    let mut model = model();
    rebind(&mut model, "shell.palette", Scope::Global, "ctrl-alt-j");
    rebind(&mut model, "surface:Open settings", Scope::Global, "alt-,");
    let entries = to_entries(&model.overrides.global);
    let mut restored = Model::new(commands(), Overrides::default());
    restored.set_global(from_entries(
        entries
            .iter()
            .map(String::as_str)
            .chain(["broken", "tab.next=ctrl-a-b"]),
    ));
    assert_eq!(restored.overrides.global, model.overrides.global);
    assert_eq!(restored.keymap.rows, model.keymap.rows);
}

#[test]
fn keymap_route_passes_every_default_unchanged_without_overrides() {
    let keymap = model().keymap;
    for builtin in builtins() {
        let default = key(builtin.default);
        assert_eq!(
            keymap.route(&down(builtin.default)),
            Route::Pass,
            "{}",
            builtin.id
        );
        let mut other = default.clone();
        (other.modifiers.control, other.modifiers.platform) =
            (other.modifiers.platform, other.modifiers.control);
        assert_eq!(
            keymap.route(&KeyDownEvent {
                keystroke: other,
                is_held: false
            }),
            Route::Pass,
            "{}",
            builtin.id
        );
    }
}

#[test]
fn keymap_route_translates_releases_and_runs_overrides() {
    let mut model = model();
    rebind(&mut model, "shell.palette", Scope::Machine, "alt-j");
    rebind(&mut model, "surface:Open settings", Scope::Global, "alt-o");
    let keymap = &model.keymap;
    match keymap.route(&down("alt-j")) {
        Route::Translate(keystroke) => assert_eq!(Some(chord(&keystroke)), parse("secondary-k")),
        other => panic!("expected translation, got {other:?}"),
    }
    assert_eq!(keymap.route(&down("secondary-k")), Route::Release);
    assert_eq!(keymap.route(&down("ctrl-k")), Route::Release);
    assert_eq!(keymap.route(&down("cmd-k")), Route::Release);
    assert_eq!(
        keymap.route(&down("alt-o")),
        Route::Run("surface:Open settings".into())
    );
    assert_eq!(keymap.route(&down("secondary-b")), Route::Pass);
}

#[test]
fn keymap_display_names_keys() {
    let text = display("alt-shift-left");
    assert!(
        text.ends_with('←') && text.split(' ').count() == 3,
        "{text}"
    );
    assert!(display("ctrl-k").ends_with('K'));
}
