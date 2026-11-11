//! Tool results stay folded inside the shared trace, beside the work that made them.
use crate::{activity::Step, retained::RowState, theme::current as theme};
use gpui::{AnyElement, ListState, div, prelude::*, px};
use std::{cell::RefCell, rc::Rc};

pub(super) fn elements(
    state: Rc<RefCell<RowState>>,
    list: &ListState,
    index: usize,
    position: usize,
    ids: &[String],
    steps: &[Step],
) -> (Option<AnyElement>, Option<AnyElement>) {
    let Some(key) = ids.first().cloned() else {
        return (None, None);
    };
    let open = state.borrow().result_open.contains(&key);
    let list = list.clone();
    let toggle = move |window: &mut gpui::Window| {
        let mut row = state.borrow_mut();
        if !row.result_open.remove(&key) {
            row.result_open.insert(key.clone());
        }
        drop(row);
        list.splice(index..index + 1, 1);
        window.refresh();
    };
    let click = toggle.clone();
    let button = div()
        .id(("trace-result-toggle", position))
        .debug_selector(move || format!("trace-result-toggle-{index}-{position}"))
        .focusable()
        .tab_stop(true)
        .cursor_pointer()
        .flex_shrink_0()
        .px(px(5.))
        .rounded(px(4.))
        .text_size(px(11.))
        .text_color(theme().text_muted)
        .hover(|s| s.bg(theme().hover))
        .focus(|s| s.bg(theme().hover))
        .child(if open { "Hide result" } else { "Show result" })
        .on_click(move |_, window, cx| {
            click(window);
            cx.stop_propagation();
        })
        .on_key_down(move |event, window, cx| {
            if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                toggle(window);
                cx.stop_propagation();
            }
        })
        .into_any_element();
    let body = open.then(|| {
        div()
            .debug_selector(move || format!("trace-result-{index}-{position}"))
            .pl(px(super::TEXT_X))
            .pb(px(8.))
            .flex()
            .flex_col()
            .gap(px(8.))
            .children(
                ids.iter()
                    .filter_map(|id| steps.iter().find(|s| &s.id == id))
                    .filter_map(|step| {
                        step.output.as_ref().map(|output| {
                            div()
                                .w_full()
                                .whitespace_normal()
                                .font_family(theme().font_mono)
                                .text_size(px(12.))
                                .line_height(px(19.5))
                                .text_color(theme().text_muted)
                                .child(crate::text::sanitize(output))
                                .into_any_element()
                        })
                    }),
            )
            .into_any_element()
    });
    (Some(button), body)
}
