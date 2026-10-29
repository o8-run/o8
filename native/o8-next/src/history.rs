use super::*;

// Match the classic transcript's useThreadHistoryBackfill threshold.
const TOP_LOAD_THRESHOLD_PX: f32 = 240.;

impl Surface {
    pub(super) fn on_transcript_scroll(&mut self, cx: &mut Context<Self>) {
        // The image loader owns the list's scroll handler. Share that deferred
        // callback so pagination never replaces image-cache maintenance.
        self.load_images(cx);
        if self.history_error.is_none()
            && -self.list.scroll_px_offset_for_scrollbar().y <= px(TOP_LOAD_THRESHOLD_PX)
        {
            self.following = None;
            self.load_older(cx);
        }
    }

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
        self.history_error = None;
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
                        // Read at completion: the reader may have moved while
                        // the request was in flight. Row identity also survives
                        // deduplication and visualization placement on prepend.
                        let mut anchor = this.list.logical_scroll_top();
                        let anchor_id = this.rows.iter().enumerate().skip(anchor.item_ix).find_map(
                            |(index, row)| {
                                let row = row.borrow();
                                if row.row.id().starts_with("\0o8:leading-visualization:") {
                                    // Leading cards can move into newly loaded turns.
                                    // Anchor the next history row at its current pixel
                                    // position, including measured cards above it.
                                    anchor.offset_in_item -= this
                                        .list
                                        .bounds_for_item(index)
                                        .map_or(px(0.), |bounds| bounds.size.height);
                                    None
                                } else {
                                    Some(row.row.id().to_owned())
                                }
                            },
                        );
                        if let Some(transcript) = &mut this.transcript {
                            transcript.prepend(history);
                            let rows = transcript.rows.clone();
                            this.install_rows(rows, cx);
                            // New virtual rows otherwise have zero height until
                            // visited, which would undercount distance to the top
                            // on the next scroll. Existing row layouts are reused.
                            this.list = this.list.clone().measure_all();
                            if let Some(item_ix) = anchor_id.and_then(|id| {
                                this.rows.iter().position(|row| row.borrow().row.id() == id)
                            }) {
                                this.list.scroll_to(ListOffset {
                                    item_ix,
                                    offset_in_item: anchor.offset_in_item,
                                });
                            }
                        }
                    }
                    Err(error) => this.history_error = Some(error),
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
            // Overlay the fallback so its appearance cannot move the transcript.
            .absolute()
            .top(px(0.))
            .left(px(24.))
            .when(
                more && (self.history_loading || self.history_error.is_some()),
                |element| {
                    element.child(
                        div()
                            .id("load-older")
                            .debug_selector(|| "load-older".into())
                            .px(px(24.))
                            .py(px(6.))
                            .bg(theme().surface_raised)
                            .text_size(px(11.))
                            .cursor_pointer()
                            .child(if self.history_error.is_some() {
                                "Retry older history"
                            } else {
                                "Reading earlier history…"
                            })
                            .when_some(self.history_error.clone(), |button, error| {
                                button.tooltip(move |_, cx| {
                                    cx.new(|_| crate::icon::Tip(error.clone().into())).into()
                                })
                            })
                            .on_click(cx.listener(|this, _, _, cx| this.load_older(cx))),
                    )
                },
            )
            .into_any_element()
    }
}
