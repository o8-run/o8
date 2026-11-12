//! The retained transcript list for chat, workers, reviewers and saved delegates.
//! Callers may decorate rows with their available actions; work and prose always
//! go through the same RetainedRow, trace disclosure and end-of-turn boundary.
use crate::theme::current as theme;
use crate::{
    prompt_navigator::{self, Jump, Navigator},
    retained::{RetainedRow, RowState},
};
use gpui::{AnyElement, App, ListState, SharedString, Window, canvas, div, list, prelude::*, px};
use std::{cell::RefCell, collections::BTreeSet, rc::Rc};

type Rows = Rc<Vec<Rc<RefCell<RowState>>>>;
pub(crate) fn list_view(
    state: ListState,
    rows: Rows,
    painted: Rc<RefCell<BTreeSet<usize>>>,
    file_root: Option<SharedString>,
    ends: BTreeSet<usize>,
    navigator: Rc<RefCell<Navigator>>,
    on_jump: Jump,
    mut decorate: impl FnMut(usize, AnyElement, &mut Window, &mut App) -> AnyElement + 'static,
) -> AnyElement {
    let navigation =
        prompt_navigator::overlay(navigator.clone(), rows.clone(), state.clone(), on_jump);
    let body = canvas(
        move |bounds, window, cx| {
            let clip = bounds.intersect(&window.content_mask().bounds);
            if clip.size.width <= px(0.) || clip.size.height <= px(0.) {
                return None;
            }
            // Only an explicit prompt jump adds end room. GPUI otherwise
            // clamps a short final turn upward before it can reach the top.
            let bottom = navigator.borrow().bottom_space(bounds.size.height);
            let mut content = list(state.clone(), move |index, window, cx| {
                let row = rows
                    .get(index)
                    .map(|row| {
                        if row.borrow().file_root != file_root {
                            row.borrow_mut().file_root = file_root.clone();
                        }
                        RetainedRow {
                            state: row.clone(),
                            index,
                            painted: painted.clone(),
                        }
                        .interactive(&state)
                    })
                    .unwrap_or_else(|| div().into_any_element());
                let row = decorate(index, row, window, cx);
                let row = if ends.contains(&index) {
                    div()
                        .debug_selector(move || format!("transcript-verdict-{index}"))
                        .w_full()
                        .child(row)
                        .into_any_element()
                } else {
                    row
                };
                div()
                    .debug_selector(move || format!("transcript-row-{index}"))
                    .w_full()
                    .child(row)
                    .into_any_element()
            })
            .size_full()
            .pb(bottom)
            .into_any_element();
            content.layout_as_root(bounds.size.map(gpui::AvailableSpace::Definite), window, cx);
            content.prepaint_at(bounds.origin, window, cx);
            navigator.borrow_mut().ready();
            Some(content)
        },
        |_, content, window, cx| {
            if let Some(mut content) = content {
                content.paint(window, cx);
            }
        },
    )
    .flex_1()
    .min_h_0()
    .w_full();
    div()
        .font_family(theme().font_ui)
        .font_weight(crate::theme::TYPE.weight)
        .text_size(px(crate::theme::TYPE.body))
        .line_height(gpui::relative(crate::theme::TYPE.chrome_line))
        .text_color(theme().text)
        .relative()
        .flex()
        .flex_col()
        .flex_1()
        .min_h_0()
        .w_full()
        .child(body)
        .child(navigation)
        .into_any_element()
}

/// Transient notices keep the chat's spacing and type at every pane width.
pub(crate) fn notice(text: String) -> AnyElement {
    div()
        .px(px(24.))
        .py(px(8.))
        .text_size(px(11.))
        .text_color(theme().text_muted)
        .child(text)
        .into_any_element()
}

pub(crate) fn empty() -> AnyElement {
    state("No messages have been recorded yet.", false)
}

/// Empty/loading/read errors use retained system messages; long reasons wrap.
pub(crate) fn state(text: &str, attention: bool) -> AnyElement {
    let mut states = Vec::new();
    if attention {
        states.push(crate::model::Row::Activity {
            id: "transcript-state".into(),
            steps: vec![],
            trace: crate::model::Trace {
                terminal_note: Some("Transcript unavailable".into()),
                attention: true,
                ..Default::default()
            },
        });
    }
    states.push(crate::model::Row::Message {
        id: "transcript-state-message".into(),
        role: "system".into(),
        author: None,
        nodes: vec![crate::text::Node::notice(text)],
    });
    let rows = Rc::new(
        states
            .into_iter()
            .map(|row| Rc::new(RefCell::new(RowState::new(row))))
            .collect::<Vec<_>>(),
    );
    list_view(
        gpui::ListState::new(rows.len(), gpui::ListAlignment::Top, px(400.)),
        rows,
        Default::default(),
        None,
        Default::default(),
        Default::default(),
        Rc::new(|_, _| {}),
        |_, row, _, _| row,
    )
}
