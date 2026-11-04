//! Shortcut resolution. A command's chord comes from this machine's override,
//! else the global override, else its default. The shell keeps one resolved
//! [`Keymap`] and consults it before its existing key handlers.
use gpui::{KeyDownEvent, Keystroke};
use std::collections::BTreeMap;

/// A command whose default chord is handled by an existing shell key handler.
pub(crate) struct Builtin {
    pub id: &'static str,
    pub label: &'static str,
    /// GPUI keystroke syntax; `secondary` is Cmd on macOS and Ctrl elsewhere.
    pub default: &'static str,
}
macro_rules! tabs {
    ($($n:literal),*) => {
        [$(Builtin {
            id: concat!("tab.", $n),
            label: concat!("Jump to tab ", $n),
            default: concat!("secondary-", $n),
        }),*]
    };
}
const TAB_JUMPS: [Builtin; 9] = tabs!("1", "2", "3", "4", "5", "6", "7", "8", "9");
const CORE: [Builtin; 9] = [
    Builtin {
        id: "chat.new",
        label: "New chat",
        default: "cmd-n",
    },
    Builtin {
        id: "shell.palette",
        label: "Command palette",
        default: "secondary-k",
    },
    Builtin {
        id: "shell.sidebar",
        label: "Show or hide the sidebar",
        default: "secondary-b",
    },
    Builtin {
        id: "sidebar.search",
        label: "Search chats",
        default: "secondary-f",
    },
    Builtin {
        id: "settings.open",
        label: "Open settings",
        default: "secondary-,",
    },
    Builtin {
        id: "shortcuts.help",
        label: "Show keyboard shortcuts",
        default: "secondary-/",
    },
    Builtin {
        id: "tab.close",
        label: "Close active tab",
        default: "secondary-w",
    },
    Builtin {
        id: "tab.previous",
        label: "Previous tab",
        default: "cmd-alt-left",
    },
    Builtin {
        id: "tab.next",
        label: "Next tab",
        default: "cmd-alt-right",
    },
];
pub(crate) fn builtins() -> impl Iterator<Item = &'static Builtin> {
    CORE.iter().chain(TAB_JUMPS.iter())
}

/// One rebindable command. Palette commands have no default chord.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Command {
    pub id: String,
    pub label: String,
    pub default: Option<String>,
}
pub(crate) fn builtin_commands() -> Vec<Command> {
    builtins()
        .map(|b| Command {
            id: b.id.into(),
            label: b.label.into(),
            default: parse(b.default),
        })
        .collect()
}

/// The canonical text of a chord: `ctrl-alt-shift-cmd-key`, where `cmd` is
/// the platform key on every platform. Shift keeps the key GPUI reports.
pub(crate) fn chord(keystroke: &Keystroke) -> String {
    let m = keystroke.modifiers;
    let mut text = String::new();
    for (on, name) in [
        (m.control, "ctrl-"),
        (m.alt, "alt-"),
        (m.shift, "shift-"),
        (m.platform, "cmd-"),
    ] {
        if on {
            text.push_str(name);
        }
    }
    text.push_str(&keystroke.key.to_lowercase());
    text
}
/// Canonical chord text, or None when GPUI cannot read it.
pub(crate) fn parse(text: &str) -> Option<String> {
    Keystroke::parse(text.trim()).ok().map(|k| chord(&k))
}
/// Whether a chord may be bound. Plain typing keys stay with text fields, so a
/// binding needs Ctrl, Cmd or Alt, or is a function key.
pub(crate) fn assignable(keystroke: &Keystroke) -> bool {
    let m = keystroke.modifiers;
    let key = keystroke.key.as_str();
    let modifier_key = matches!(
        key,
        "control" | "alt" | "shift" | "platform" | "function" | "cmd" | "super" | "ctrl"
    );
    let function_key = key.len() > 1
        && key.starts_with('f')
        && key[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n));
    !key.is_empty() && !modifier_key && (m.control || m.alt || m.platform || function_key)
}
/// A chord as the dialog shows it, such as `⌘ ⌥ →` or `Ctrl Shift K`.
pub(crate) fn display(chord: &str) -> String {
    let Ok(k) = Keystroke::parse(chord) else {
        return chord.into();
    };
    let mac = cfg!(target_os = "macos");
    let mut parts = Vec::new();
    for (on, mac_name, name) in [
        (k.modifiers.control, "⌃", "Ctrl"),
        (k.modifiers.alt, "⌥", "Alt"),
        (k.modifiers.shift, "⇧", "Shift"),
        (k.modifiers.platform, "⌘", "Super"),
    ] {
        if on {
            parts.push(if mac { mac_name } else { name }.to_string());
        }
    }
    parts.push(match k.key.as_str() {
        "left" => "←".into(),
        "right" => "→".into(),
        "up" => "↑".into(),
        "down" => "↓".into(),
        "escape" => "Esc".into(),
        key if key.chars().count() == 1 => key.to_uppercase(),
        key => {
            let mut c = key.chars();
            c.next()
                .map(|f| f.to_uppercase().chain(c).collect())
                .unwrap_or_default()
        }
    });
    parts.join(" ")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Source {
    Default,
    Global,
    Machine,
}
impl Source {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Default => "Default",
            Self::Global => "Global",
            Self::Machine => "This machine",
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Scope {
    #[default]
    Global,
    Machine,
}

/// Overrides by command id. Global ones live in shared settings, this
/// machine's in the local shell state.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Overrides {
    pub global: BTreeMap<String, String>,
    pub machine: BTreeMap<String, String>,
}
impl Overrides {
    pub(crate) fn scope(&self, scope: Scope) -> &BTreeMap<String, String> {
        match scope {
            Scope::Global => &self.global,
            Scope::Machine => &self.machine,
        }
    }
    pub(crate) fn scope_mut(&mut self, scope: Scope) -> &mut BTreeMap<String, String> {
        match scope {
            Scope::Global => &mut self.global,
            Scope::Machine => &mut self.machine,
        }
    }
}
/// Shared settings store global overrides as `command=chord` entries.
pub(crate) fn from_entries<'a>(entries: impl IntoIterator<Item = &'a str>) -> BTreeMap<String, String> {
    entries
        .into_iter()
        .filter_map(|entry| {
            let (id, text) = entry.split_once('=')?;
            Some((id.to_owned(), parse(text)?))
        })
        .collect()
}
pub(crate) fn to_entries(map: &BTreeMap<String, String>) -> Vec<String> {
    map.iter().map(|(id, chord)| format!("{id}={chord}")).collect()
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Row {
    pub id: String,
    pub label: String,
    pub chord: Option<String>,
    pub source: Source,
    /// Labels of other commands resolved to the same chord.
    pub conflicts: Vec<String>,
}

/// What the shell does with a key before its own handlers see it.
#[derive(Debug, PartialEq)]
pub(crate) enum Route {
    /// No binding changes this key; existing handlers see it unchanged.
    Pass,
    /// A rebound built-in: existing handlers see its default chord instead.
    Translate(Keystroke),
    /// A rebound palette command, run by id.
    Run(String),
    /// A default chord whose command moved; the shell leaves it to the focused view.
    Release,
}

/// The resolved bindings the shell installs.
#[derive(Clone, Debug, Default)]
pub(crate) struct Keymap {
    pub rows: Vec<Row>,
    defaults: BTreeMap<String, String>,
}
impl Keymap {
    pub(crate) fn resolve(commands: &[Command], overrides: &Overrides) -> Self {
        let mut rows = commands
            .iter()
            .map(|command| {
                let (chord, source) = if let Some(chord) = overrides.machine.get(&command.id) {
                    (Some(chord.clone()), Source::Machine)
                } else if let Some(chord) = overrides.global.get(&command.id) {
                    (Some(chord.clone()), Source::Global)
                } else {
                    (command.default.clone(), Source::Default)
                };
                Row {
                    id: command.id.clone(),
                    label: command.label.clone(),
                    chord,
                    source,
                    conflicts: Vec::new(),
                }
            })
            .collect::<Vec<_>>();
        let found = rows.clone();
        for row in &mut rows {
            row.conflicts = found
                .iter()
                .filter(|other| other.id != row.id && other.chord.is_some() && other.chord == row.chord)
                .map(|other| other.label.clone())
                .collect();
        }
        Self {
            rows,
            defaults: commands
                .iter()
                .filter_map(|c| Some((c.id.clone(), c.default.clone()?)))
                .collect(),
        }
    }
    pub(crate) fn row(&self, id: &str) -> Option<&Row> {
        self.rows.iter().find(|row| row.id == id)
    }
    /// The command a chord runs. On a conflict the stronger source wins
    /// (this machine, then global, then default), then the earlier command.
    pub(crate) fn command_for(&self, chord: &str) -> Option<&Row> {
        self.rows
            .iter()
            .filter(|row| row.chord.as_deref() == Some(chord))
            .fold(None, |best: Option<&Row>, row| match best {
                Some(best) if best.source >= row.source => Some(best),
                _ => Some(row),
            })
    }
    pub(crate) fn route(&self, event: &KeyDownEvent) -> Route {
        let pressed = chord(&event.keystroke);
        if let Some(row) = self.command_for(&pressed) {
            return match self.defaults.get(&row.id) {
                Some(default) if *default == pressed => Route::Pass,
                Some(default) => Keystroke::parse(default)
                    .map(|mut keystroke| {
                        keystroke.key_char = None;
                        Route::Translate(keystroke)
                    })
                    .unwrap_or(Route::Pass),
                None if row.source == Source::Default => Route::Pass,
                None => Route::Run(row.id.clone()),
            };
        }
        // Existing handlers accept Ctrl or Cmd for most chords, so a moved
        // command releases both.
        let folded = fold(&pressed);
        let moved = self.defaults.iter().any(|(id, default)| {
            fold(default) == folded
                && self.row(id).is_some_and(|row| row.chord.as_ref() != Some(default))
        });
        if moved { Route::Release } else { Route::Pass }
    }
}
fn fold(chord: &str) -> String {
    let Ok(mut keystroke) = Keystroke::parse(chord) else {
        return chord.into();
    };
    keystroke.modifiers.platform |= keystroke.modifiers.control;
    keystroke.modifiers.control = false;
    self::chord(&keystroke)
}

/// The Shortcuts editor's state. The shell owns one, so the keymap it installs
/// and the rows the editor shows always come from the same resolution.
#[derive(Default)]
pub(crate) struct Model {
    pub commands: Vec<Command>,
    pub overrides: Overrides,
    pub scope: Scope,
    /// The command whose capture field is waiting for a chord.
    pub capturing: Option<String>,
    pub notice: Option<String>,
    pub keymap: Keymap,
}
impl Model {
    pub(crate) fn new(commands: Vec<Command>, overrides: Overrides) -> Self {
        let mut model = Self {
            commands,
            overrides,
            ..Self::default()
        };
        model.rebuild();
        model
    }
    fn rebuild(&mut self) {
        self.keymap = Keymap::resolve(&self.commands, &self.overrides);
    }
    pub(crate) fn set_commands(&mut self, commands: Vec<Command>) {
        if self.commands != commands {
            self.commands = commands;
            self.rebuild();
        }
    }
    pub(crate) fn set_global(&mut self, global: BTreeMap<String, String>) {
        self.overrides.global = global;
        self.rebuild();
    }
    pub(crate) fn set_scope(&mut self, scope: Scope) {
        self.scope = scope;
        self.capturing = None;
        self.notice = None;
    }
    pub(crate) fn begin(&mut self, id: &str) {
        if self.commands.iter().any(|c| c.id == id) {
            self.capturing = Some(id.into());
            self.notice = None;
        }
    }
    pub(crate) fn cancel(&mut self) {
        self.capturing = None;
    }
    /// Binds the captured chord in the selected scope. Returns the scope that
    /// changed, for the caller to persist.
    pub(crate) fn capture(&mut self, keystroke: &Keystroke) -> Option<Scope> {
        let id = self.capturing.clone()?;
        if keystroke.key == "escape" && !keystroke.modifiers.modified() {
            self.capturing = None;
            return None;
        }
        if !assignable(keystroke) {
            self.notice = Some("Use Ctrl, Cmd or Alt with a key, or a function key.".into());
            return None;
        }
        self.capturing = None;
        let chord = chord(keystroke);
        self.overrides.scope_mut(self.scope).insert(id.clone(), chord.clone());
        self.rebuild();
        self.notice = self.keymap.row(&id).and_then(|row| {
            (!row.conflicts.is_empty())
                .then(|| format!("{} is also bound to {}.", display(&chord), row.conflicts.join(", ")))
        });
        Some(self.scope)
    }
    /// Removes this command's override in the selected scope.
    pub(crate) fn reset(&mut self, id: &str) -> Option<Scope> {
        self.capturing = None;
        self.notice = None;
        self.overrides.scope_mut(self.scope).remove(id)?;
        self.rebuild();
        Some(self.scope)
    }
    /// Removes every override in the selected scope.
    pub(crate) fn reset_all(&mut self) -> Option<Scope> {
        self.capturing = None;
        self.notice = None;
        let overrides = self.overrides.scope_mut(self.scope);
        if overrides.is_empty() {
            return None;
        }
        overrides.clear();
        self.rebuild();
        Some(self.scope)
    }
}

#[cfg(test)]
#[path = "keymap_tests.rs"]
mod tests;
