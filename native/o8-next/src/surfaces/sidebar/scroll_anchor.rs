//! Where the list stood before a rebuild, so rows that arrive or leave above
//! the view (a run returning from the Working drawer, or starting) never move
//! what the person sees (#6021): a list at its top stays at its top; a
//! scrolled list keeps its top row where it was. The keyboard choice is
//! followed only when the view lost its anchor; a newly selected thread is
//! brought into view. A new search text starts at the top; clearing the
//! search returns to where the list stood before it began.
use super::*;
use gpui::{ListOffset, Pixels, point, px};

/// A compact row's height: render_row and folder_row are both h(28), and
/// the uniform list steps by its first row's measured height.
const ROW: f32 = 28.;

pub(super) struct ScrollAnchor {
    at_top: bool,
    /// The top visible row's identity and how far into it the view starts.
    row: Option<(String, Pixels)>,
}

impl ScrollAnchor {
    pub(super) fn top() -> Self {
        Self { at_top: true, row: None }
    }
}

/// A row's identity; a heading's includes its group (`status`), so two
/// groups' "Show 2 more" rows stay apart.
fn identity(row: &Row) -> String {
    row.id.as_ref().map(|id| format!("thread:{id}")).unwrap_or_else(|| {
        format!("{}:{}:{}:{}", row.kind, row.workspace, row.title, row.status)
    })
}

/// A detailed row's height in its list (66 or 28, with the 1px padding).
fn detailed_height(row: &Row) -> Pixels {
    px(if row.id.is_some() { detailed::ROW_HEIGHT } else { 28. } + 2.)
}

impl ThreadList {
    /// Brings row `ix` into view if it is not; a row in view stays put.
    pub(super) fn reveal_row(&self, ix: usize) {
        if !self.cards() {
            self.scroll.scroll_to_item(ix, ScrollStrategy::Top);
            return;
        }
        if self.view() == folders::View::Inbox {
            // Cards vary in height; keep the plain scroll there.
            self.scroll_row(ix, ScrollStrategy::Top, false);
            return;
        }
        let y = |n: usize| {
            self.rows[..n.min(self.rows.len())]
                .iter()
                .map(detailed_height)
                .fold(px(0.), |a, b| a + b)
        };
        let top = self.detailed_list.logical_scroll_top();
        let view_top = y(top.item_ix) + top.offset_in_item;
        let view_height = self.detailed_list.viewport_bounds().size.height;
        let (row_top, row_height) = (y(ix), self.rows.get(ix).map_or(px(0.), detailed_height));
        if row_top < view_top || row_top + row_height > view_top + view_height {
            self.detailed_list.scroll_to(ListOffset { item_ix: ix, offset_in_item: px(0.) });
        }
    }

    /// Reads the view before `rows` change.
    pub(super) fn scroll_anchor(&self) -> ScrollAnchor {
        let (ix, within) = if self.cards() {
            let top = self.detailed_list.logical_scroll_top();
            (top.item_ix, top.offset_in_item)
        } else {
            let step = px(ROW);
            let y = (-self.scroll.0.borrow().base_handle.offset().y).max(px(0.));
            let ix = (y / step).floor() as usize;
            (ix, y - step * ix as f32)
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
            let step = px(ROW);
            let state = self.scroll.0.borrow();
            let x = state.base_handle.offset().x;
            state.base_handle.set_offset(point(x, -(step * ix as f32 + within)));
        }
        true
    }
}
