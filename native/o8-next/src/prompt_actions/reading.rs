//! Read-only histories use the chat's prompt toolbar. Only continuation is unavailable.
use super::*;
use crate::{model::Entry, retained::RowState};
use std::rc::Weak;

type Rows = Vec<Rc<RefCell<RowState>>>;
#[derive(Default)]
pub(crate) struct Reading {
    rows: Weak<Rows>,
    entries: HashMap<usize, Rc<Entry>>,
    state: State,
}
impl Reading {
    /// Keep metadata and original copy text with the retained row snapshot.
    pub(crate) fn sync(&mut self, rows: &Rc<Rows>, entries: &[Entry]) {
        if self
            .rows
            .upgrade()
            .is_some_and(|old| Rc::ptr_eq(&old, rows))
        {
            return;
        }
        let entries: HashMap<_, _> = entries
            .iter()
            .filter(|e| e.role == "user")
            .map(|e| (e.id.as_str(), e))
            .collect();
        self.entries = rows
            .iter()
            .enumerate()
            .filter_map(|(index, row)| {
                let row = row.borrow();
                matches!(&row.row, Row::Message { role, .. } if role == "user")
                    .then(|| {
                        entries
                            .get(row.row.id())
                            .map(|e| (index, Rc::new((**e).clone())))
                    })
                    .flatten()
            })
            .collect();
        self.rows = Rc::downgrade(rows);
        self.state.focus.retain(|key, _| {
            key.split_once('-')
                .is_some_and(|(_, id)| entries.contains_key(id))
        });
    }
    pub(crate) fn decorate<V: 'static>(
        state: Rc<RefCell<Self>>,
        view: Entity<V>,
        source: &str,
        index: usize,
        row: AnyElement,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let mut this = state.borrow_mut();
        let Some(entry) = this.entries.get(&index).cloned() else {
            return row;
        };
        let focus = ["copy", "rewind", "fork", "confirm", "cancel"]
            .iter()
            .map(|action| {
                this.state
                    .focus
                    .entry(format!("{action}-{}", entry.id))
                    .or_insert_with(|| cx.focus_handle().tab_stop(true))
                    .clone()
            })
            .collect();
        let handle = window.window_handle();
        if this
            .state
            .keyboard
            .as_ref()
            .is_none_or(|(current, _)| *current != handle)
        {
            let weak = Rc::downgrade(&state);
            let view = view.downgrade();
            let subscription = cx.intercept_keystrokes(move |event, window, cx| {
                let key = &event.keystroke;
                if window.window_handle() != handle
                    || key.key != "tab"
                    || key.modifiers.control
                    || key.modifiers.platform
                    || key.modifiers.alt
                {
                    return;
                }
                let previous = window.focused(cx);
                let backwards = key.modifiers.shift;
                let (weak, view) = (weak.clone(), view.clone());
                window.defer(cx, move |window, cx| {
                    if let (Some(state), Some(view)) = (weak.upgrade(), view.upgrade()) {
                        if state
                            .borrow()
                            .state
                            .reveal_tab(previous.as_ref(), backwards, window)
                        {
                            view.update(cx, |_, cx| cx.notify());
                        }
                    }
                });
            });
            this.state.keyboard = Some((handle, subscription));
        }
        let prompt = Prompt {
            source: source.into(),
            id: entry.id.clone(),
            time: metadata::timestamp(&entry),
            delivery: metadata::delivery(&entry),
            copied: this.state.copied.as_ref().is_some_and(|(id, at)| {
                *id == entry.id && at.elapsed() < Duration::from_millis(1500)
            }),
            hovered: this.state.hovered.as_ref() == Some(&entry.id),
            confirm: false,
            busy: false,
            fork_reason: Some("This history is read-only. Copy is still available.".into()),
            rewind_reason: Some("This history is read-only. Copy is still available.".into()),
            error: None,
            focus,
            stage: "",
        };
        drop(this);
        let (hover_state, hover_view, id) = (state.clone(), view.downgrade(), entry.id.clone());
        let redraw = view.downgrade();
        let handlers = Handlers {
            event: Rc::new(move |action, _, cx| {
                if action != Action::Copy {
                    return;
                }
                cx.write_to_clipboard(ClipboardItem::new_string(entry.text.clone()));
                state.borrow_mut().state.copied = Some((entry.id.clone(), Instant::now()));
                view.update(cx, |_, cx| cx.notify());
                let view = view.downgrade();
                cx.spawn(async move |cx| {
                    cx.background_executor()
                        .timer(Duration::from_millis(1500))
                        .await;
                    let _ = view.update(cx, |_, cx| cx.notify());
                })
                .detach();
            }),
            redraw: Rc::new(move |cx| {
                let _ = redraw.update(cx, |_, cx| cx.notify());
            }),
        };
        div()
            .id(SharedString::from(format!(
                "prompt-row-{}-{}",
                prompt.source, prompt.id
            )))
            .group("prompt-row")
            .on_hover(move |hovered, _, cx| {
                let mut state = hover_state.borrow_mut();
                let next = if *hovered { Some(id.clone()) } else { None };
                if state.state.hovered != next
                    && (*hovered || state.state.hovered.as_ref() == Some(&id))
                {
                    state.state.hovered = next;
                    let _ = hover_view.update(cx, |_, cx| cx.notify());
                }
            })
            .w_full()
            .flex()
            .flex_col()
            .child(row)
            .child(row_with(&handlers, &prompt, window))
            .into_any_element()
    }
}
