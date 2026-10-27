//! Input ownership is observed here; editors and the shell need no extra hooks.
use super::*;
use gpui::{EntityInputHandler, WeakEntity, WeakFocusHandle};
use std::{cell::RefCell, rc::Rc};

#[derive(Default)]
pub(super) struct Inputs {
    fields: Rc<RefCell<Vec<WeakFocusHandle>>>,
    terminals: Rc<RefCell<Vec<WeakEntity<crate::terminal::Pane>>>>,
    observers: RefCell<Option<[gpui::Subscription; 3]>>,
}
impl Inputs {
    pub fn watch(&self, cx: &mut Context<Shell>) {
        if self.observers.borrow().is_some() {
            return;
        }
        let fields = self.fields.clone();
        let text = cx.observe_new::<crate::composer::Composer>(move |input, _, _| {
            fields.borrow_mut().push(input.focus.downgrade());
        });
        let fields = self.fields.clone();
        let secret = cx.observe_new::<crate::settings_secret::Secret>(move |input, _, _| {
            fields.borrow_mut().push(input.focus.downgrade());
        });
        let terminals = self.terminals.clone();
        let terminal = cx.observe_new::<crate::terminal::Pane>(move |_, _, cx| {
            terminals.borrow_mut().push(cx.entity().downgrade());
        });
        *self.observers.borrow_mut() = Some([text, secret, terminal]);
    }
    pub fn field_focused(&self, window: &Window) -> bool {
        let mut focused = false;
        self.fields.borrow_mut().retain(|field| {
            if let Some(field) = field.upgrade() {
                focused |= field.is_focused(window);
                true
            } else {
                false
            }
        });
        focused
    }
    pub fn terminal(&self, window: &Window, cx: &App) -> Option<Entity<crate::terminal::Pane>> {
        let mut terminals = self.terminals.borrow_mut();
        terminals.retain(|terminal| terminal.upgrade().is_some());
        terminals
            .iter()
            .filter_map(|terminal| terminal.upgrade())
            .find(|terminal| terminal.read(cx).focus_handle().is_focused(window))
    }
}

pub(super) fn core_chord(event: &KeyDownEvent) -> bool {
    let m = event.keystroke.modifiers;
    (m.control || m.platform) && ["k", ","].contains(&event.keystroke.key.as_str())
        || m.control && !m.alt && ["w", "tab"].contains(&event.keystroke.key.as_str())
}
pub(super) fn deliver_core_chord(
    terminal: &Entity<crate::terminal::Pane>,
    event: &KeyDownEvent,
    window: &mut Window,
    cx: &mut Context<Shell>,
) {
    // The unchanged shell captures these before the terminal's key handler.
    // Deliver their terminal protocol bytes through its existing input API.
    let m = event.keystroke.modifiers;
    if m.platform {
        return;
    }
    let text = match event.keystroke.key.as_str() {
        "k" if m.control => "\x0b",
        "w" if m.control => "\x17",
        "tab" if m.shift => "\x1b[Z",
        "tab" => "\t",
        _ => return,
    };
    terminal.update(cx, |terminal, cx| {
        if terminal.marked_text_range(window, cx).is_none() {
            terminal.replace_text_in_range(None, text, window, cx);
        }
    });
}
