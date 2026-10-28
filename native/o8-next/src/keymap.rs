//! Actions bound to predicates on the focused view context path.
use gpui::{App, Global, KeyBinding, Keystroke};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Edit {
    Submit,
    Steer,
    Newline,
    SelectAll,
    Copy,
    Cut,
    Paste,
    Undo,
    Redo,
    WordLeft,
    WordRight,
    WordBackspace,
    WordDelete,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    Backspace,
    Delete,
}
#[derive(Clone, Debug, PartialEq, gpui::Action)]
#[action(no_json)]
pub enum Shortcut {
    Palette,
    PaletteGlobal,
    TargetReopen,
    TargetRefresh,
    TargetMove(bool),
    TargetAccept,
    TargetCancel,
    NextSurface,
    PreviousSurface,
    SurfaceIndex(usize),
    CloseSurface,
    Settings,
    Reference,
    ReferenceCancel,
    PaletteCancel,
    PaletteMove(bool),
    PaletteAccept,
    Edit {
        operation: Edit,
        select: bool,
        boundary: bool,
    },
    ComposerFocus(bool),
    ComposerCancel,
    SessionFocus,
    SessionSelect(bool),
    SessionSteer,
    SessionRemove,
    Navigate(bool),
    ToggleBrain,
    BrainCancel,
    BrainFind,
    GridNeighbor {
        direction: &'static str,
        swap: bool,
    },
    GridSize(usize),
    GridClose,
    GridChoose,
    GridToggle,
    GridZoom,
    GridCycle(bool),
    InboxTab(bool),
    InboxLane(u8),
    InboxSelect(bool),
    InboxOpen,
    InboxRefresh,
    SettingsCancel,
    SettingsClose,
    FocusNext(bool),
    SettingsFind,
    SettingsScroll(bool),
    IssueCancel,
    IssueRemoveLabel,
    ActivityMove(bool),
    ActivityActivate,
    ActivityCancel,
    DiffFile(bool),
    DiffMode(bool),
    DiffRefresh,
    Activate,
    Terminal(Keystroke),
    TerminalText(String),
    TerminalScroll(&'static str),
    TerminalPaste,
    #[cfg(test)]
    Probe,
}
impl Shortcut {
    fn label(&self) -> String {
        use Shortcut::*;
        match self {
            Palette | PaletteGlobal => "Open commands".into(),
            TargetReopen => "Choose another target".into(),
            TargetRefresh => "Refresh targets".into(),
            TargetMove(next) => if *next {
                "Next target"
            } else {
                "Previous target"
            }
            .into(),
            TargetAccept => "Open selected target".into(),
            TargetCancel => "Clear target filter".into(),
            NextSurface => "Next surface".into(),
            PreviousSurface => "Previous surface".into(),
            SurfaceIndex(index) => format!("Select surface {}", index + 1),
            CloseSurface => "Close surface".into(),
            Settings => "Open settings".into(),
            Reference => "Toggle shortcuts reference".into(),
            ReferenceCancel => "Close shortcuts reference".into(),
            PaletteCancel => "Close commands".into(),
            PaletteMove(next) => if *next {
                "Next command"
            } else {
                "Previous command"
            }
            .into(),
            PaletteAccept => "Run selected command".into(),
            Edit { operation, .. } => format!("Edit text: {operation:?}"),
            ComposerFocus(previous) => if *previous {
                "Focus previous composer control"
            } else {
                "Focus next composer control"
            }
            .into(),
            ComposerCancel => "Close composer picker".into(),
            SessionFocus => "Move between session list and composer".into(),
            SessionSelect(next) => if *next {
                "Next session"
            } else {
                "Previous session"
            }
            .into(),
            SessionSteer => "Promote queued message".into(),
            SessionRemove => "Remove queued message".into(),
            Navigate(end) => if *end { "Go to end" } else { "Go to start" }.into(),
            ToggleBrain => "Toggle Brain".into(),
            BrainCancel => "Close Brain search or panel".into(),
            BrainFind => "Search Brain".into(),
            GridNeighbor { direction, swap } => {
                format!("{} pane {direction}", if *swap { "Move" } else { "Focus" })
            }
            GridSize(n) => format!("Show {n} panes"),
            GridClose => "Close pane".into(),
            GridChoose => "Choose pane session".into(),
            GridToggle => "Toggle pane terminal".into(),
            GridZoom => "Zoom pane".into(),
            GridCycle(previous) => if *previous {
                "Previous pane"
            } else {
                "Next pane"
            }
            .into(),
            InboxTab(previous) | FocusNext(previous) => if *previous {
                "Focus previous control"
            } else {
                "Focus next control"
            }
            .into(),
            InboxLane(_) => "Change Inbox view".into(),
            InboxSelect(next) => if *next {
                "Next Inbox card"
            } else {
                "Previous Inbox card"
            }
            .into(),
            InboxOpen => "Open selected Inbox card".into(),
            InboxRefresh => "Refresh Inbox".into(),
            SettingsCancel => "Cancel edit or close settings".into(),
            SettingsClose => "Close settings".into(),
            SettingsFind => "Search settings".into(),
            SettingsScroll(_) => "Scroll settings".into(),
            IssueCancel => "Return to issue list".into(),
            IssueRemoveLabel => "Remove empty issue label".into(),
            ActivityMove(_) => "Select activity control".into(),
            ActivityActivate => "Activate activity control".into(),
            ActivityCancel => "Close activity detail".into(),
            DiffFile(next) => if *next {
                "Next diff file"
            } else {
                "Previous diff file"
            }
            .into(),
            DiffMode(split) => if *split { "Split diff" } else { "Unified diff" }.into(),
            DiffRefresh => "Refresh diff".into(),
            Activate => "Activate focused control".into(),
            Terminal(_) => "Send key to terminal".into(),
            TerminalText(_) => "Send terminal text".into(),
            TerminalScroll(_) => "Scroll terminal".into(),
            TerminalPaste => "Paste into terminal".into(),
            #[cfg(test)]
            Probe => "Open registration probe".into(),
        }
    }
}
#[derive(Clone)]
pub struct Binding {
    pub key: String,
    pub context: &'static str,
    pub action: Shortcut,
}
impl Binding {
    pub fn gpui(&self) -> KeyBinding {
        KeyBinding::new(&self.key, self.action.clone(), Some(self.context))
    }
    pub fn reference(&self) -> String {
        format!("{} · {} · {}", self.key, self.action.label(), self.context)
    }
}
struct Installed;
impl Global for Installed {}
pub fn install(cx: &mut App) {
    if !cx.has_global::<Installed>() {
        cx.bind_keys(bindings().iter().map(Binding::gpui));
        cx.set_global(Installed);
    }
}
pub fn reference() -> Vec<String> {
    bindings().iter().map(Binding::reference).collect()
}
pub fn bindings() -> Vec<Binding> {
    use self::Edit as EditorOp;
    use Shortcut::*;
    let mut rows = Vec::new();
    let mut bind = |key: &str, context, action| {
        rows.push(Binding {
            key: key.into(),
            context,
            action,
        })
    };
    const GLOBAL: &str = "Global && !TextInput && !Terminal && !Modal";
    const TABS: &str = "Global && !TextInput && !Terminal && !Modal && !Overlay";
    const CYCLE_TABS: &str = "Global && !Terminal && !Modal && !Overlay";
    for prefix in ["ctrl-", "cmd-"] {
        bind(&format!("{prefix}/"), GLOBAL, Reference);
        bind(
            &format!("{prefix}/"),
            "Shortcuts && !TextInput && !Terminal",
            ReferenceCancel,
        );
        bind(&format!("{prefix}k"), GLOBAL, Palette);
        bind(
            &format!("{prefix}shift-p"),
            "Global && !Shortcuts && !Reference",
            PaletteGlobal,
        );
        bind(&format!("{prefix}k"), "Palette && !Terminal", PaletteCancel);
        bind(&format!("{prefix}w"), TABS, CloseSurface);
        bind(
            &format!("{prefix},"),
            "Global && !Terminal && !Reference",
            Settings,
        );
        bind(
            &format!("{prefix}e"),
            "Session && !Terminal && !Modal",
            ToggleBrain,
        );
        bind(&format!("{prefix}e"), "Brain && !Terminal", ToggleBrain);
        bind(&format!("{prefix}f"), "Brain && !Terminal", BrainFind);
        bind(&format!("{prefix}f"), "Settings && !Terminal", SettingsFind);
    }
    for key in ["ctrl-w", "ctrl-shift-w"] {
        bind(
            key,
            "(Settings || SettingsCloseHost) && !TextInput && !Terminal",
            SettingsClose,
        );
    }
    // Main cycles from the composer too, and ignores Shift for this chord.
    bind("ctrl-tab", CYCLE_TABS, NextSurface);
    bind("ctrl-shift-tab", CYCLE_TABS, NextSurface);
    bind("cmd-alt-right", TABS, NextSurface);
    bind("cmd-alt-left", TABS, PreviousSurface);
    for index in 0..9 {
        bind(&format!("cmd-{}", index + 1), TABS, SurfaceIndex(index));
    }
    bind(
        "escape",
        "Shortcuts && !TextInput && !Terminal",
        ReferenceCancel,
    );
    bind("?", "Shortcuts && !TextInput && !Terminal", ReferenceCancel);
    bind("?", GLOBAL, Reference);
    for prefix in ["ctrl-", "cmd-"] {
        bind(&format!("{prefix}alt-o"), "TargetHost", TargetReopen);
    }
    for (key, action) in [
        ("f5", TargetRefresh),
        ("up", TargetMove(false)),
        ("down", TargetMove(true)),
        ("enter", TargetAccept),
        ("escape", TargetCancel),
    ] {
        bind(key, "TargetPicker && !Terminal", action);
    }
    bind("escape", "Palette && !Terminal", PaletteCancel);
    bind("up", "Palette && !Terminal", PaletteMove(false));
    bind("down", "Palette && !Terminal", PaletteMove(true));
    bind("enter", "Palette && !Terminal", PaletteAccept);
    bind("escape", "Brain && !Terminal", BrainCancel);
    bind("escape", "Settings && !Terminal", SettingsCancel);
    bind("escape", "Issues && !Terminal", IssueCancel);
    bind("backspace", "IssueLabel", IssueRemoveLabel);
    for (key, operation) in [
        ("enter", EditorOp::Submit),
        ("shift-enter", EditorOp::Newline),
        ("ctrl-enter", EditorOp::Submit),
        ("cmd-enter", EditorOp::Submit),
        ("ctrl-shift-enter", EditorOp::Steer),
        ("cmd-shift-enter", EditorOp::Steer),
    ] {
        bind(
            key,
            "TextInput && !Palette && !TargetPicker",
            Shortcut::Edit {
                operation,
                select: false,
                boundary: false,
            },
        );
    }
    for prefix in ["ctrl-", "cmd-"] {
        for (key, operation) in [
            ("a", EditorOp::SelectAll),
            ("c", EditorOp::Copy),
            ("x", EditorOp::Cut),
            ("v", EditorOp::Paste),
            ("z", EditorOp::Undo),
            ("shift-z", EditorOp::Redo),
            ("y", EditorOp::Redo),
        ] {
            bind(
                &format!("{prefix}{key}"),
                "TextInput",
                Shortcut::Edit {
                    operation,
                    select: false,
                    boundary: false,
                },
            );
        }
    }
    for (key, operation) in [
        ("left", EditorOp::Left),
        ("right", EditorOp::Right),
        ("up", EditorOp::Up),
        ("down", EditorOp::Down),
        ("home", EditorOp::Home),
        ("end", EditorOp::End),
        ("backspace", EditorOp::Backspace),
        ("delete", EditorOp::Delete),
    ] {
        for prefix in [
            "",
            "shift-",
            "ctrl-",
            "ctrl-shift-",
            "cmd-",
            "cmd-shift-",
            "alt-",
            "alt-shift-",
        ] {
            let word = if cfg!(target_os = "macos") {
                prefix.contains("alt")
            } else {
                prefix.contains("ctrl")
            };
            let operation = if word {
                match operation {
                    EditorOp::Left => EditorOp::WordLeft,
                    EditorOp::Right => EditorOp::WordRight,
                    EditorOp::Backspace => EditorOp::WordBackspace,
                    EditorOp::Delete => EditorOp::WordDelete,
                    other => other,
                }
            } else {
                operation
            };
            bind(
                &format!("{prefix}{key}"),
                if matches!(operation, EditorOp::Backspace) {
                    "TextInput && !IssueLabel"
                } else if matches!(operation, EditorOp::Up | EditorOp::Down) {
                    "TextInput && !Palette && !TargetPicker"
                } else {
                    "TextInput"
                },
                Shortcut::Edit {
                    operation,
                    select: prefix.contains("shift"),
                    boundary: if matches!(operation, EditorOp::Home | EditorOp::End) {
                        prefix.contains("ctrl") || prefix.contains("cmd")
                    } else {
                        cfg!(target_os = "macos") && prefix.contains("cmd")
                    },
                },
            );
        }
    }
    bind("tab", "ComposerCard && !Terminal", ComposerFocus(false));
    bind(
        "shift-tab",
        "ComposerCard && !Terminal",
        ComposerFocus(true),
    );
    bind("escape", "ComposerPicker && !Terminal", ComposerCancel);
    bind(
        "tab",
        "Session && !Brain && !Terminal && !ComposerCard",
        SessionFocus,
    );
    bind(
        "shift-tab",
        "Session && !Brain && !Terminal && !ComposerCard",
        SessionFocus,
    );
    for (key, action) in [
        ("up", SessionSelect(false)),
        ("down", SessionSelect(true)),
        ("f6", SessionSteer),
        ("f7", SessionRemove),
        ("home", Navigate(false)),
        ("end", Navigate(true)),
    ] {
        bind(
            key,
            "Session && !TextInput && !Brain && !Button && !Terminal",
            action,
        );
    }
    for direction in ["left", "right", "up", "down"] {
        bind(
            &format!("ctrl-alt-{direction}"),
            "Grid && !TextInput",
            GridNeighbor {
                direction,
                swap: false,
            },
        );
        bind(
            &format!("ctrl-alt-shift-{direction}"),
            "Grid && !TextInput",
            GridNeighbor {
                direction,
                swap: true,
            },
        );
    }
    for n in [1, 2, 4, 6] {
        bind(&format!("ctrl-alt-{n}"), "Grid && !TextInput", GridSize(n));
    }
    for (key, action) in [
        ("ctrl-alt-w", GridClose),
        ("ctrl-alt-p", GridChoose),
        ("ctrl-alt-t", GridToggle),
        ("ctrl-alt-enter", GridZoom),
    ] {
        bind(key, "Grid && !TextInput", action);
    }
    bind("tab", "Grid && !Terminal && !TextInput", GridCycle(false));
    bind(
        "shift-tab",
        "Grid && !Terminal && !TextInput",
        GridCycle(true),
    );
    for (key, action) in [("home", Navigate(false)), ("end", Navigate(true))] {
        bind(key, "Grid && !Terminal && !TextInput", action);
    }
    for (key, action) in [
        ("tab", InboxTab(false)),
        ("shift-tab", InboxTab(true)),
        ("left", InboxLane(0)),
        ("right", InboxLane(1)),
        ("home", InboxLane(2)),
        ("end", InboxLane(3)),
        ("up", InboxSelect(false)),
        ("down", InboxSelect(true)),
        ("enter", InboxOpen),
        ("f5", InboxRefresh),
    ] {
        bind(key, "Inbox && !TextInput && !Terminal", action);
    }
    for (key, action) in [
        ("tab", FocusNext(false)),
        ("shift-tab", FocusNext(true)),
        ("pageup", SettingsScroll(false)),
        ("pagedown", SettingsScroll(true)),
    ] {
        bind(
            key,
            if matches!(action, FocusNext(_)) {
                "Settings && !Terminal"
            } else {
                "Settings && !TextInput && !Terminal"
            },
            action,
        );
    }
    for (key, action) in [
        ("tab", ActivityMove(false)),
        ("shift-tab", ActivityMove(true)),
        ("down", ActivityMove(false)),
        ("up", ActivityMove(true)),
        ("enter", ActivityActivate),
        ("space", ActivityActivate),
        ("escape", ActivityCancel),
    ] {
        bind(key, "Activity && !TextInput && !Terminal", action);
    }
    for (key, action) in [
        ("home", Navigate(false)),
        ("end", Navigate(true)),
        ("alt-up", DiffFile(false)),
        ("alt-down", DiffFile(true)),
        ("u", DiffMode(false)),
        ("s", DiffMode(true)),
        ("r", DiffRefresh),
    ] {
        bind(key, "Diff && !TextInput && !Terminal", action);
    }
    bind("enter", "Button", Activate);
    bind("space", "Button", Activate);
    // Terminal protocol keys are actions too. Printable/IME input uses GPUI's
    // EntityInputHandler, independent of the shortcut map.
    for key in ["pageup", "pagedown", "home", "end"] {
        bind(&format!("shift-{key}"), "Terminal", TerminalScroll(key));
    }
    bind("cmd-v", "Terminal", TerminalPaste);
    bind("ctrl-shift-v", "Terminal", TerminalPaste);
    for key in [
        "enter",
        "backspace",
        "escape",
        "tab",
        "up",
        "down",
        "right",
        "left",
        "home",
        "end",
        "insert",
        "delete",
        "pageup",
        "pagedown",
        "f1",
        "f2",
        "f3",
        "f4",
        "f5",
        "f6",
        "f7",
        "f8",
        "f9",
        "f10",
        "f11",
        "f12",
    ] {
        for prefix in [
            "",
            "shift-",
            "alt-",
            "alt-shift-",
            "ctrl-",
            "ctrl-shift-",
            "ctrl-alt-",
            "ctrl-alt-shift-",
        ] {
            // Reserved grid chords and scroll actions take priority over PTY encoding.
            if prefix == "shift-" && ["pageup", "pagedown", "home", "end"].contains(&key) {
                continue;
            }
            let chord = format!("{prefix}{key}");
            let context = if ["ctrl-alt-", "ctrl-alt-shift-"].contains(&prefix)
                && ["left", "right", "up", "down", "enter"].contains(&key)
            {
                "Terminal && !Grid"
            } else {
                "Terminal"
            };
            bind(&chord, context, Terminal(Keystroke::parse(&chord).unwrap()));
        }
    }
    for key in ('!'..='~')
        .filter(|key| !key.is_ascii_uppercase())
        .map(|c| c.to_string())
        .chain(["space".to_owned()])
    {
        for prefix in [
            "ctrl-",
            "ctrl-shift-",
            "alt-",
            "alt-shift-",
            "ctrl-alt-",
            "ctrl-alt-shift-",
        ] {
            if prefix == "ctrl-shift-" && key == "v" {
                continue;
            }
            let chord = format!("{prefix}{key}");
            let mut stroke = Keystroke::parse(&chord).unwrap();
            stroke.key_char = Some(if key == "space" {
                " ".into()
            } else if prefix.contains("shift") && key.len() == 1 {
                key.to_uppercase()
            } else {
                key.to_string()
            });
            let context = if prefix == "ctrl-shift-" && key == "p" {
                "Terminal && !Global"
            } else if prefix == "ctrl-alt-" && key == "o" {
                "Terminal && !TargetHost"
            } else if prefix == "ctrl-alt-"
                && ["w", "p", "t", "1", "2", "4", "6"].contains(&key.as_str())
            {
                "Terminal && !Grid"
            } else {
                "Terminal"
            };
            bind(&chord, context, Terminal(stroke));
        }
    }
    #[cfg(test)]
    bind("ctrl-alt-j", GLOBAL, Probe);
    rows
}

#[cfg(test)]
#[path = "keymap_tests.rs"]
mod tests;

// Alt-modified Unicode is platform text, with an unbounded character set. Keep
// its VT translation in this shared input bridge, after all named shortcuts.
// The terminal surface only receives the resulting action, like IME text input.
pub fn terminal_protocol_input(element: gpui::Div) -> gpui::Div {
    use gpui::prelude::*;
    element.on_key_down(|event, window, cx| {
        let key = &event.keystroke;
        if key.modifiers.alt
            && !key.modifiers.control
            && !key.modifiers.platform
            && let Some(text) = &key.key_char
            && !text.is_ascii()
        {
            window.dispatch_action(Box::new(Shortcut::TerminalText(format!("\x1b{text}"))), cx);
            cx.stop_propagation();
        }
    })
}

/// Compatibility for registered raw-key hooks. Named actions have already had
/// their focused dispatch opportunity before this unbound-event fallback runs.
pub fn legacy_registration_input<E: gpui::InteractiveElement>(
    element: E,
    listener: impl Fn(&gpui::KeyDownEvent, &mut gpui::Window, &mut App) + 'static,
) -> E {
    element.on_key_down(move |event, window, cx| {
        if window
            .context_stack()
            .iter()
            .any(|context| context.contains("TextInput") || context.contains("Terminal"))
        {
            return;
        }
        listener(event, window, cx);
    })
}

/// Keep the sidebar's existing rename/search capture scoped to its own subtree.
/// Its editor needs Escape/F2 before text dispatch; shell shortcuts still use
/// the focused action map and the unbound registration fallback.
pub fn sidebar_input<E: gpui::InteractiveElement>(
    element: E,
    listener: impl Fn(&gpui::KeyDownEvent, &mut gpui::Window, &mut App) + 'static,
) -> E {
    element.capture_key_down(listener)
}

/// The shell sidebar's existing search/focus controls remain reachable from an
/// editor after focused actions. Other registered hooks never receive text keys.
pub fn sidebar_navigation_input<E: gpui::InteractiveElement>(
    element: E,
    listener: impl Fn(&gpui::KeyDownEvent, &mut gpui::Window, &mut App) + 'static,
) -> E {
    element.on_key_down(move |event, window, cx| {
        let contexts = window.context_stack();
        if !contexts.iter().any(|context| context.contains("TextInput"))
            || contexts.iter().any(|context| context.contains("Terminal"))
        {
            return;
        }
        let key = &event.keystroke;
        if key.key == "f8" || key.key == "f" && (key.modifiers.control || key.modifiers.platform) {
            listener(event, window, cx);
        }
    })
}

/// Preserve registered feature contexts at capture before focused action dispatch.
/// Their handlers decide whether a key is handled or belongs to the focused child.
pub fn registered_context_input<E: gpui::InteractiveElement>(
    element: E,
    listener: impl Fn(&gpui::KeyDownEvent, &mut gpui::Window, &mut App) + 'static,
) -> E {
    element.capture_key_down(listener)
}
