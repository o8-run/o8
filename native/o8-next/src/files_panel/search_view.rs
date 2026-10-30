//! WorkspaceFileTree and QuickDocFilePicker input, toolbar and result states.
use super::*;
impl Render for Search {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let entries = self.visible_entries();
        let picker = self.picker;
        self.row_focus
            .retain(|path, _| entries.iter().any(|entry| &entry.path == path));
        for entry in &entries {
            self.row_focus
                .entry(entry.path.clone())
                .or_insert_with(|| cx.focus_handle());
        }
        let mut tab_order = vec![self.focus.clone()];
        tab_order.extend(
            entries
                .iter()
                .filter(|entry| !self.pinned.contains(&entry.path))
                .map(|entry| self.row_focus[&entry.path].clone()),
        );
        tab_order.extend(self.close_focus.clone());
        div()
            .flex()
            .flex_col()
            .min_h_0()
            .when(self.searching() || self.picker, |d| d.flex_1())
            .on_key_down(cx.listener(move |this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "tab" && this.picker {
                    let current = tab_order
                        .iter()
                        .position(|focus| focus.is_focused(window))
                        .unwrap_or(0);
                    let next = if event.keystroke.modifiers.shift {
                        (current + tab_order.len() - 1) % tab_order.len()
                    } else {
                        (current + 1) % tab_order.len()
                    };
                    tab_order[next].focus(window);
                    cx.stop_propagation();
                }
                if event.keystroke.key == "escape"
                    && !this.picker
                    && !this.input.read(cx).composing()
                {
                    this.input.update(cx, |input, cx| input.clear(cx));
                    this.changed(false, cx);
                    cx.stop_propagation();
                }
            }))
            .child({
                let input=div().id(if picker{"pin-search"}else{"files-search"}).debug_selector(move||if picker{"pin-search".into()}else{"files-search".into()})
                    .flex_1().min_w_0().h(px(if picker{30.}else{28.})).flex().flex_col().justify_center().px(px(if picker{9.}else{4.})).rounded(px(7.)).when(picker,|d|d.border_1().border_color(theme().border)).child(self.input.clone());
                if picker {div().flex().flex_shrink_0().mb(px(5.)).child(input)} else {
                    div().h(px(40.)).flex_shrink_0().flex().items_center().px(px(7.)).gap(px(4.))
                        .child(tool("files-refresh","Refresh file tree",self.refreshing,Tool::Refresh,cx).child(crate::icon::stroke("M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-2l2 2 M18 17a7 7 0 0 1-12 2l-2-2",theme().text_muted,14.,1.6)))
                        .child(input)
                        .when(!self.query.is_empty(),|d|d.child(div().id("files-search-clear").debug_selector(||"files-search-clear".into()).focusable().size(px(24.)).flex_shrink_0().flex().items_center().justify_center().rounded(px(5.)).cursor_pointer().hover(|d|d.bg(theme().hover)).active(|d|d.bg(theme().selection)).focus(|d|d.border_1().border_color(theme().accent)).child("×").on_click(cx.listener(|this,_,window,cx|this.clear(window,cx))).on_key_down(cx.listener(|this,event:&KeyDownEvent,window,cx|{if matches!(event.keystroke.key.as_str(),"enter"|"space"){this.clear(window,cx);cx.stop_propagation();}}))))
                        .child(tool("files-expand-all",if self.expanded{"Collapse all folders"}else{"Expand all folders"},false,Tool::ToggleExpansion,cx).child(crate::icon::stroke(if self.expanded{"m7 3 5 5 5-5 M12 3v18 m-5 0 5-5 5 5"}else{"m7 8 5-5 5 5 M12 3v18 m-5-5 5 5 5-5"},theme().text_muted,14.,1.6)))
                }
            })
            .when(self.searching() || self.picker, |view| {
                view.when(!entries.is_empty(), |view| view.child(
                    uniform_list(
                        "file-search-results",
                        entries.len(),
                        cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                            range
                                .map(|i| {
                                    let path = entries[i].path.clone();
                                    let pinned = this.pinned.contains(&path);
                                    let focus = this.row_focus[&path].clone();
                                    let key_path = path.clone();
                                    div()
                                        .id(i)
                                        .debug_selector({
                                            let path = path.clone();
                                            move || {
                                                format!(
                                                    "{}-{path}",
                                                    if picker { "pin" } else { "file-search" }
                                                )
                                            }
                                        })
                                        .track_focus(&focus)
                                        .h(px(34.))
                                        .px(px(8.))
                                        .flex()
                                        .items_center()
                                        .gap(px(7.))
                                        .rounded(px(6.))
                                        .text_size(px(12.))
                                        .text_color(if pinned {
                                            theme().text_faint
                                        } else {
                                            theme().text_secondary
                                        })
                                        .child(crate::icon::stroke(
                                            file_icon(&path),
                                            file_color(&path),
                                            14.,
                                            1.6,
                                        ))
                                        .child(
                                            div()
                                                .flex_1()
                                                .min_w_0()
                                                .overflow_hidden()
                                                .whitespace_nowrap()
                                                .text_ellipsis()
                                                .child(path.clone()),
                                        )
                                        .when(this.picker, |d| {
                                            d.child(if pinned { "Pinned" } else { "+" })
                                        })
                                        .when(!pinned, |d| {
                                            d.tab_stop(true)
                                                .on_key_down(cx.listener(
                                                    move |_, event: &KeyDownEvent, _, cx| {
                                                        if matches!(
                                                            event.keystroke.key.as_str(),
                                                            "enter" | "space"
                                                        ) {
                                                            cx.emit(Pick(key_path.clone()));
                                                            cx.stop_propagation();
                                                        }
                                                    },
                                                ))
                                                .cursor_pointer()
                                                .hover(|d| d.bg(theme().hover))
                                                .on_click(cx.listener(move |_, _, _, cx| {
                                                    cx.emit(Pick(path.clone()))
                                                }))
                                        })
                                })
                                .collect::<Vec<_>>()
                        }),
                    )
                    .track_scroll(self.scroll.clone())
                    .flex_1()
                    .min_h_0(),
                ))
                .when(self.entries.is_none(), |d| {
                    d.child(notice(
                        if self.picker {
                            "Loading files..."
                        } else {
                            "Searching files..."
                        }
                        .into(),
                    ))
                })
                .when(
                    matches!(&self.entries, Some(Ok(entries)) if entries.is_empty())
                        && self.visible_entries().is_empty(),
                    |d| d.child(notice("No matching files.".into())),
                )
                .when(matches!(self.entries,Some(Err(_))),|d|d.child(div().p(px(9.)).flex().items_center().gap(px(8.)).text_size(px(12.)).text_color(theme().text_muted).child(if picker{"Couldn't load files."}else{"Couldn't search files."})
                    .child(div().id("file-search-retry").debug_selector(||"file-search-retry".into()).focusable().px(px(7.)).py(px(4.)).rounded(px(6.)).border_1().border_color(theme().border).cursor_pointer().hover(|d|d.bg(theme().hover)).active(|d|d.bg(theme().selection)).focus(|d|d.border_color(theme().accent)).child("Retry").on_click(cx.listener(|this,_,_,cx|this.refresh(cx))).on_key_down(cx.listener(|this,event:&KeyDownEvent,_,cx|{if matches!(event.keystroke.key.as_str(),"enter"|"space"){this.refresh(cx);cx.stop_propagation();}})))))
                .when(self.truncated, |d| {
                    d.child(notice("Showing 500 matches. Refine your search to see more.".into()))
                })
            })
    }
}

fn tool(
    id: &'static str,
    label: &str,
    disabled: bool,
    action: Tool,
    cx: &mut Context<Search>,
) -> Stateful<Div> {
    let label = label.to_owned();
    div()
        .id(id)
        .debug_selector(move || id.into())
        .focusable()
        .size(px(26.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .when(disabled, |d| d.opacity(0.5))
        .when(!disabled, |d| {
            d.cursor_pointer()
                .hover(|d| d.bg(theme().hover))
                .active(|d| d.bg(theme().selection))
                .focus(|d| d.border_1().border_color(theme().accent))
                .on_click(cx.listener(move |_, _, _, cx| cx.emit(action)))
                .on_key_down(cx.listener(move |_, event: &KeyDownEvent, _, cx| {
                    if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                        cx.emit(action);
                        cx.stop_propagation();
                    }
                }))
        })
        .tooltip(move |_, cx| cx.new(|_| crate::icon::Tip(label.clone().into())).into())
}

fn notice(text: String) -> impl IntoElement {
    div()
        .debug_selector(|| "files-search-notice".into())
        .px(px(9.))
        .py(px(9.))
        .text_size(px(12.))
        .line_height(px(18.))
        .text_color(theme().text_muted)
        .child(text)
}
