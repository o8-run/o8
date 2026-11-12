//! Where the list stood before a rebuild, so rows that arrive or leave above
//! the view (a run returning from the Working drawer, or starting) never move
//! what the person sees (#6021): a list at its top stays at its top; a
//! scrolled list keeps its top row where it was. The keyboard choice is
//! followed only when the view lost its anchor.
use super::*;
use gpui::{ListOffset, Pixels, point, px};

/// A compact row's height (render_row), the uniform list's step.
const ROW: f32 = 28.;

pub(super) struct ScrollAnchor {
    at_top: bool,
    /// The top visible row's identity and how far into it the view starts.
    row: Option<(String, Pixels)>,
}

fn identity(row: &Row) -> String {
    row.id
        .as_ref()
        .map(|id| format!("thread:{id}"))
        .unwrap_or_else(|| format!("{}:{}:{}", row.kind, row.workspace, row.title))
}

impl ThreadList {
    /// Reads the view before `rows` change.
    pub(super) fn scroll_anchor(&self) -> ScrollAnchor {
        let (ix, within) = if self.cards() {
            let top = self.detailed_list.logical_scroll_top();
            (top.item_ix, top.offset_in_item)
        } else {
            let y = (-self.scroll.0.borrow().base_handle.offset().y).max(px(0.));
            let ix = (y / px(ROW)).floor() as usize;
            (ix, y - px(ROW) * ix as f32)
        };
        ScrollAnchor {
            at_top: ix == 0 && within <= px(0.),
            row: self.rows.get(ix).map(|row| (identity(row), within)),
        }
    }

    /// Puts the view back after `rows` changed. Returns false when the
    /// anchor row is gone, so the caller may follow the keyboard choice.
    pub(super) fn restore_scroll(&self, anchor: ScrollAnchor) -> bool {
        let (ix, within) = if anchor.at_top {
            (0, px(0.))
        } else {
            let Some((key, within)) = anchor.row else {
                return false;
            };
            let end = self.top_len();
            let Some(ix) = self.rows[..end].iter().position(|r| identity(r) == key) else {
                return false;
            };
            (ix, within)
        };
        if self.cards() {
            self.detailed_list.scroll_to(ListOffset { item_ix: ix, offset_in_item: within });
        } else {
            let state = self.scroll.0.borrow();
            let x = state.base_handle.offset().x;
            state.base_handle.set_offset(point(x, -(px(ROW) * ix as f32 + within)));
        }
        true
    }
}
