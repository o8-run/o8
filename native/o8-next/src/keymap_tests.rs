//! Exercise the published GPUI dispatch entry point, including an empty focus path.
use super::*;
use gpui::{Context, FocusHandle, Render, TestAppContext, Window, div, prelude::*};

struct Dispatch {
    root: &'static str,
    leaf: &'static str,
    focus: FocusHandle,
    received: Vec<Shortcut>,
}
impl Render for Dispatch {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .key_context(self.root)
            .on_action(
                cx.listener(|this, action: &Shortcut, _, _| this.received.push(action.clone())),
            )
            .child(div().track_focus(&self.focus).key_context(self.leaf))
    }
}
fn origin(row: &Binding) -> &'static str {
    use Shortcut::*;
    match row.action {
        ReferenceCancel => "Global Shortcuts Modal",
        Terminal(_) if row.context.contains("!Global") => "Standalone",
        TargetReopen => "Global TargetHost",
        TargetRefresh | TargetMove(_) | TargetAccept | TargetCancel => {
            "Global TargetHost TargetPicker"
        }
        PaletteCancel | PaletteMove(_) | PaletteAccept => "Global Palette",
        ToggleBrain | BrainCancel | BrainFind => "Global Session Brain",
        ComposerFocus(_) => "Global Session ComposerCard",
        ComposerCancel => "Global Session ComposerCard ComposerPicker",
        SessionFocus | SessionSelect(_) | SessionSteer | SessionRemove => "Global Session",
        GridNeighbor { .. }
        | GridSize(_)
        | GridClose
        | GridChoose
        | GridToggle
        | GridZoom
        | GridCycle(_) => "Global Grid",
        InboxTab(_) | InboxLane(_) | InboxSelect(_) | InboxOpen | InboxRefresh => "Global Inbox",
        SettingsCancel | SettingsClose | FocusNext(_) | SettingsFind | SettingsScroll(_) => {
            "Global Settings Modal"
        }
        IssueCancel | IssueRemoveLabel => "Global Issues",
        ActivityMove(_) | ActivityActivate | ActivityCancel => "Global Activity",
        DiffFile(_) | DiffMode(_) | DiffRefresh => "Global Diff",
        Navigate(_) if row.context.starts_with("Grid") => "Global Grid",
        Navigate(_) if row.context.starts_with("Diff") => "Global Diff",
        Navigate(_) => "Global Session",
        _ => "Global",
    }
}
fn allowed(row: &Binding, focus: &str) -> bool {
    use Shortcut::*;
    if focus == "none" {
        return false;
    }
    match &row.action {
        NextSurface if row.key == "ctrl-tab" || row.key == "ctrl-shift-tab" => focus != "terminal",
        PaletteGlobal | TargetReopen => true,
        Settings => focus != "terminal",
        TargetRefresh | TargetMove(_) | TargetAccept | TargetCancel => focus != "terminal",
        Edit { .. } | IssueRemoveLabel => focus == "text",
        Terminal(_) | TerminalText(_) | TerminalScroll(_) | TerminalPaste => focus == "terminal",
        GridNeighbor { .. } | GridSize(_) | GridClose | GridChoose | GridToggle | GridZoom => {
            focus != "text"
        }
        ComposerFocus(_) | ComposerCancel | PaletteCancel | PaletteMove(_) | PaletteAccept
        | ToggleBrain | BrainCancel | BrainFind | SessionFocus | SettingsCancel | SettingsFind
        | FocusNext(_) | IssueCancel => focus != "terminal",
        _ => focus == "list",
    }
}
#[gpui::test]
fn keymap_every_binding_dispatches_only_on_its_focus_path(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|_, cx| Dispatch {
        root: "Global",
        leaf: "List",
        focus: cx.focus_handle(),
        received: vec![],
    });
    let mut cases = 0;
    for isolated in [true, false] {
        for row in bindings() {
            // Check each predicate, then check precedence in the complete keymap.
            cx.update(|_, cx| {
                cx.clear_key_bindings();
                if isolated {
                    cx.bind_keys([row.gpui()]);
                } else {
                    cx.bind_keys(bindings().iter().map(Binding::gpui));
                }
            });
            for focus in ["text", "terminal", "list", "none"] {
                view.update_in(cx, |view, window, cx| {
                    view.root = origin(&row);
                    view.leaf = match focus {
                        "text" if row.context.starts_with("Palette") => "TextInput Palette",
                        "text" if row.context.starts_with("TargetPicker") => {
                            "TextInput TargetPicker"
                        }
                        "text" if row.context.starts_with("IssueLabel") => "TextInput IssueLabel",
                        "text" => "TextInput",
                        "terminal" => "Terminal",
                        _ if matches!(row.action, Shortcut::Activate) => "List Button",
                        _ => "List",
                    };
                    view.received.clear();
                    if focus == "none" {
                        window.blur();
                    } else {
                        view.focus.focus(window);
                    }
                    cx.notify();
                });
                cx.update(|window, cx| {
                    window.refresh();
                    window.draw(cx).clear();
                });
                cx.simulate_keystrokes(&row.key);
                let actual = view.read_with(cx, |view, _| view.received.clone());
                let expected = if allowed(&row, focus) {
                    vec![row.action.clone()]
                } else {
                    vec![]
                };
                if isolated || allowed(&row, focus) {
                    assert_eq!(
                        actual,
                        expected,
                        "{} with {focus} focus (isolated={isolated})",
                        row.reference()
                    );
                } else {
                    assert!(
                        !actual.contains(&row.action),
                        "{} leaked into {focus}",
                        row.reference()
                    );
                }
                cases += 1;
            }
        }
    }
    println!("keymap focus matrix: {cases} dispatch cases");
}
#[test]
fn keymap_reference_has_exactly_the_registered_rows() {
    let rows = bindings();
    let reference = reference();
    assert_eq!(reference.len(), rows.len());
    let mut unique = std::collections::HashSet::new();
    for (row, printed) in rows.iter().zip(reference) {
        assert!(
            unique.insert((
                gpui::Keystroke::parse(&row.key).unwrap().unparse(),
                row.context
            )),
            "duplicate binding: {printed}"
        );
        assert_eq!(printed, row.reference());
        let binding = row.gpui();
        assert_eq!(
            binding.action().as_any().downcast_ref::<Shortcut>(),
            Some(&row.action)
        );
        assert_eq!(binding.keystrokes().len(), 1);
        assert!(printed.contains(&row.key));
    }
}

#[gpui::test]
fn keymap_nested_terminal_and_text_take_precedence(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        install(cx);
        let focus = cx.focus_handle();
        focus.focus(window);
        Dispatch {
            root: "Global Grid",
            leaf: "Terminal",
            focus,
            received: vec![],
        }
    });
    cx.simulate_keystrokes("ctrl-k ctrl-w cmd-k ? ctrl-alt-right");
    view.read_with(cx, |view, _| {
        assert_eq!(view.received.len(), 3);
        assert!(matches!(&view.received[0], Shortcut::Terminal(key) if key.key == "k"));
        assert!(matches!(&view.received[1], Shortcut::Terminal(key) if key.key == "w"));
        assert_eq!(
            view.received[2],
            Shortcut::GridNeighbor {
                direction: "right",
                swap: false
            }
        );
    });
    view.update(cx, |view, cx| {
        view.root = "Global Session";
        view.leaf = "TextInput";
        view.received.clear();
        cx.notify();
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear();
    });
    cx.simulate_keystrokes("ctrl-k ctrl-w cmd-k cmd-w ?");
    assert!(view.read_with(cx, |view, _| view.received.is_empty()));
}
