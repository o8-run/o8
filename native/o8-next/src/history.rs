use super::*;

impl Surface {
    pub(super) fn load_older(&mut self, cx: &mut Context<Self>) {
        if self.history_loading {
            return;
        }
        let Some(id) = self.selected.clone() else {
            return;
        };
        let Some(cursor) = self
            .transcript
            .as_ref()
            .and_then(|t| t.page.as_ref())
            .filter(|page| page.has_more)
            .and_then(|page| page.before_cursor.clone())
        else {
            return;
        };
        self.history_loading = true;
        let generation = self.generation;
        let client = self.client.clone();
        let expected_cursor = cursor.clone();
        let task = cx
            .background_executor()
            .spawn(async move { client.history_page(&id, Some(&cursor)) });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |this, cx| {
                if generation != this.generation {
                    return;
                }
                this.history_loading = false;
                if this
                    .transcript
                    .as_ref()
                    .and_then(|t| t.page.as_ref())
                    .and_then(|page| page.before_cursor.as_deref())
                    != Some(expected_cursor.as_str())
                {
                    cx.notify();
                    return;
                }
                match result {
                    Ok(history) => {
                        let anchor = this.list.logical_scroll_top();
                        let old = this.rows.len();
                        if let Some(transcript) = &mut this.transcript {
                            transcript.prepend(history);
                            let rows = transcript.rows.clone();
                            this.install_rows(rows, cx);
                            this.list.scroll_to(ListOffset {
                                item_ix: anchor.item_ix + this.rows.len().saturating_sub(old),
                                offset_in_item: anchor.offset_in_item,
                            });
                        }
                    }
                    Err(error) => {
                        this.notice = format!("{error}. Refresh history to restart pagination.")
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }
    pub(super) fn history_control(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let more = self
            .transcript
            .as_ref()
            .and_then(|t| t.page.as_ref())
            .is_some_and(|page| page.has_more);
        div()
            .when(more, |element| {
                element.child(
                    div()
                        .id("load-older")
                        .debug_selector(|| "load-older".into())
                        .px(px(24.))
                        .py(px(6.))
                        .text_size(px(11.))
                        .cursor_pointer()
                        .child(if self.history_loading {
                            "Reading earlier history…"
                        } else {
                            "Load older"
                        })
                        .on_click(cx.listener(|this, _, _, cx| this.load_older(cx))),
                )
            })
            .into_any_element()
    }
}
