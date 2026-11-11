//! The retained transcript list for chat, workers, reviewers and saved delegates.
//! Callers may decorate rows with their available actions; work and prose always
//! go through the same RetainedRow, trace disclosure and end-of-turn boundary.
use crate::retained::{RetainedRow, RowState};
use gpui::{AnyElement, App, ListState, SharedString, Window, div, list, prelude::*};
use std::{cell::RefCell, collections::BTreeSet, rc::Rc};

type Rows = Rc<Vec<Rc<RefCell<RowState>>>>;
pub(crate) fn list_view(
    state: ListState,
    rows: Rows,
    painted: Rc<RefCell<BTreeSet<usize>>>,
    file_root: Option<SharedString>,
    ends: BTreeSet<usize>,
    mut decorate: impl FnMut(usize, AnyElement, &mut Window, &mut App) -> AnyElement + 'static,
) -> AnyElement {
    list(state.clone(), move |index, window, cx| {
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
    .flex_1()
    .min_h_0()
    .into_any_element()
}
