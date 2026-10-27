//! Focused-keymap adapter. Include when composing with that action registry.
//! Keep editing in Composer::edit_key so either dispatch hook preserves it.
use super::Composer;
use crate::keymap::{Edit, Shortcut};
use gpui::{Context, Keystroke, Window};

impl Composer {
    pub(crate) fn action(
        &mut self,
        action: &Shortcut,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.composing() && matches!(action, Shortcut::Edit { .. } | Shortcut::IssueRemoveLabel)
        {
            cx.stop_propagation();
            return;
        }
        let Shortcut::Edit {
            operation,
            select,
            boundary,
        } = action
        else {
            cx.propagate();
            return;
        };
        let word = if cfg!(target_os = "macos") {
            "alt-"
        } else {
            "ctrl-"
        };
        let edge = if *boundary { "cmd-" } else { "" };
        let (key, prefix, shift) = match operation {
            Edit::Submit => ("enter", "", false),
            Edit::Steer => ("enter", "ctrl-", true),
            Edit::Newline => ("enter", "", true),
            Edit::SelectAll => ("a", "ctrl-", false),
            Edit::Copy => ("c", "ctrl-", false),
            Edit::Cut => ("x", "ctrl-", false),
            Edit::Paste => ("v", "ctrl-", false),
            Edit::Undo => ("z", "ctrl-", false),
            Edit::Redo => ("z", "ctrl-", true),
            Edit::WordLeft => ("left", word, false),
            Edit::WordRight => ("right", word, false),
            Edit::WordBackspace => ("backspace", word, false),
            Edit::WordDelete => ("delete", word, false),
            Edit::Left => ("left", edge, false),
            Edit::Right => ("right", edge, false),
            Edit::Up => ("up", edge, false),
            Edit::Down => ("down", edge, false),
            Edit::Home => ("home", if *boundary { "ctrl-" } else { "" }, false),
            Edit::End => ("end", if *boundary { "ctrl-" } else { "" }, false),
            Edit::Backspace => ("backspace", edge, false),
            Edit::Delete => ("delete", edge, false),
        };
        let key = Keystroke::parse(&format!(
            "{prefix}{}{key}",
            if *select || shift { "shift-" } else { "" }
        ))
        .expect("declared editing key");
        self.edit_key(&key, window, cx);
    }
}
