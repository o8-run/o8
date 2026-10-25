//! Row actions retain the row's identity, independent of the keyboard choice.
use super::*;
use crate::theme::current as theme;
use gpui::{AnyElement, div, px};
impl ThreadList {
    pub(super) fn toggle_archived(&mut self, cx: &mut Context<Self>) {
        self.archived_open = !self.archived_open;
        self.rebuild();
        if self.archived_open
            && let Some(index) = self.rows.iter().position(|r| r.status == "archived")
        {
            self.scroll.scroll_to_item(index, ScrollStrategy::Top);
        }
        cx.notify();
    }
    pub(super) fn archived_control(&self, cx: &mut Context<Self>) -> AnyElement {
        div()
            .id("sidebar-archived")
            .debug_selector(|| "sidebar-archived".into())
            .h(px(28.))
            .px(px(12.))
            .flex()
            .items_center()
            .text_size(px(12.))
            .text_color(theme().text_faint)
            .cursor_pointer()
            .child("Archived")
            .on_click(cx.listener(|this, _, _, cx| this.toggle_archived(cx)))
            .into_any_element()
    }
    pub(super) fn row_archive_control(
        &self,
        row: &Row,
        keyboard: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let id = row.id.clone().unwrap();
        let selector = id.clone();
        div()
            .id(gpui::ElementId::Name(format!("archive:{id}").into()))
            .debug_selector(move || format!("thread-archive-{selector}"))
            .w(px(38.))
            .h(px(20.))
            .flex()
            .items_center()
            .text_size(px(9.5))
            .flex_shrink_0()
            .text_color(theme().text_muted)
            .when(!keyboard || self.choice.as_ref() != Some(&id), |v| {
                v.invisible().group_hover("thread-row", |s| s.visible())
            })
            .opacity(if self.saving { 0.5 } else { 1. })
            .cursor_pointer()
            .child(if row.status == "archived" {
                "Restore"
            } else {
                "Archive"
            })
            .on_click(cx.listener(move |this, _, _, cx| {
                cx.stop_propagation();
                this.archive_id(id.clone(), cx);
            }))
            .into_any_element()
    }
}
