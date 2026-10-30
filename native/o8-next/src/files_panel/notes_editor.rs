//! Editable wrapped Markdown with a measured, shared-scroll annotation rail.
use super::*;
impl Editor {
    pub(super) fn notes_view(&mut self, _: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        self.load_images(cx);
        let input = cx.entity();
        let height = self.height;
        let review = super::super::spec_rfm::parse(&self.text);
        let rail = self.note_rail(review.notes.clone(), cx);
        let images = self.inline_images();
        self.base(cx)
            .flex_col()
            .relative()
            .font_family(theme().font_ui)
            .font_weight(FontWeight::LIGHT)
            .text_size(px(13.5))
            .line_height(px(20.925))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(|this, event: &MouseDownEvent, _, cx| {
                    this.rail.context = Some(event.position);
                    cx.notify();
                    cx.stop_propagation();
                }),
            )
            .children(self.text_menu(cx))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape"
                    && (this.rail.reply.is_some() || this.rail.context.is_some())
                {
                    this.rail.reply = None;
                    this.rail.context = None;
                    this.focus.focus(window);
                    cx.notify();
                    cx.stop_propagation();
                }
            }))
            .on_drop::<ExternalPaths>(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                this.move_to(this.index_at(window.mouse_position()), false, cx);
                for path in paths.paths() {
                    this.upload_image(assets::Input::Path(path.clone()), window, cx);
                }
                cx.stop_propagation();
            }))
            .when(self.assets.pending > 0, |d| {
                d.child(
                    div()
                        .text_size(px(9.5))
                        .text_color(theme().text_muted)
                        .child("Uploading image…"),
                )
            })
            .when_some(self.assets.error.as_ref(), |d, error| {
                d.child(
                    div()
                        .debug_selector(|| "spec-image-error".into())
                        .text_size(px(9.5))
                        .text_color(theme().danger)
                        .child(error.clone()),
                )
            })
            .child(
                div()
                    .id("spec-scroll")
                    .flex_1()
                    .min_h_0()
                    .min_w_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .child(
                        div()
                            .relative()
                            .pt(px(22.))
                            .pb(px(26.))
                            .pl(px(4.))
                            .pr(px(8.))
                            .child(
                                div()
                                    .flex()
                                    .items_start()
                                    .child(
                                        canvas(
                                            |_, _, _| (),
                                            move |bounds, _, window, cx| {
                                                let (
                                                    text,
                                                    selection,
                                                    marked,
                                                    cursor,
                                                    focus,
                                                    color,
                                                    heights,
                                                    previews,
                                                ) = {
                                                    let i = input.read(cx);
                                                    (
                                                        i.text.clone(),
                                                        i.selection.clone(),
                                                        i.marked.clone(),
                                                        i.cursor(),
                                                        i.focus.clone(),
                                                        i.note_color,
                                                        i.rail.heights.clone(),
                                                        i.assets.previews.clone(),
                                                    )
                                                };
                                                window.handle_input(
                                                    &focus,
                                                    ElementInputHandler::new(bounds, input.clone()),
                                                    cx,
                                                );
                                                let rows = super::super::spec_document::lines(
                                                    &text,
                                                    &selection,
                                                    marked.as_ref(),
                                                    color,
                                                );
                                                let review = super::super::spec_rfm::parse(&text);
                                                let refs = assets::references(&text);
                                                let mut y = bounds.top();
                                                let mut note_bottom = y;
                                                let mut positions =
                                                    std::collections::HashMap::new();
                                                let mut image_positions = vec![];
                                                let mut layout = vec![];
                                                #[cfg(test)]
                                                let mut painted = vec![];
                                                for row in rows {
                                                    let attached = review
                                                        .notes
                                                        .iter()
                                                        .filter(|n| {
                                                            n.offset >= row.start
                                                                && n.offset <= row.start + row.len
                                                        })
                                                        .collect::<Vec<_>>();
                                                    if !attached.is_empty() {
                                                        y = y.max(note_bottom);
                                                        let mut next = y;
                                                        for note in attached {
                                                            positions.insert(
                                                                note.id.clone(),
                                                                next - bounds.top(),
                                                            );
                                                            next += heights
                                                                .get(&note.id)
                                                                .copied()
                                                                .unwrap_or(px(80.))
                                                                + px(8.);
                                                        }
                                                        note_bottom = next;
                                                    }
                                                    let mut shaped = rich_layout::RichLine::shape(
                                                        &row,
                                                        bounds.size.width.max(px(10.)),
                                                        window,
                                                    );
                                                    let image = refs
                                                        .iter()
                                                        .find(|(at, _)| *at == row.start);
                                                    if let Some((_, path)) = image {
                                                        let ratio = assets::ratio(
                                                            &text[row.start..row.start + row.len],
                                                        )
                                                        .or_else(|| {
                                                            previews
                                                                .get(path)
                                                                .and_then(Option::as_ref)
                                                                .and_then(|p| p.as_ref().ok())
                                                                .map(|p| {
                                                                    let s = p.size(0);
                                                                    s.width.0 as f32
                                                                        / s.height.0.max(1) as f32
                                                                })
                                                        })
                                                        .unwrap_or(1.5);
                                                        let image_height = (bounds.size.width
                                                            / ratio)
                                                            .clamp(px(80.), px(420.));
                                                        image_positions.push((
                                                            path.clone(),
                                                            y - bounds.top(),
                                                            image_height,
                                                        ));
                                                        shaped.height = image_height + px(12.);
                                                    } else {
                                                        shaped.paint(
                                                            point(bounds.left(), y),
                                                            window,
                                                            cx,
                                                        );
                                                    }
                                                    #[cfg(test)]
                                                    {
                                                        painted.push((
                                                            row.display.to_string(),
                                                            row.size,
                                                            row.runs
                                                                .first()
                                                                .map(|r| r.font.weight.0)
                                                                .unwrap_or(300.),
                                                        ));
                                                        painted.extend(
                                                            shaped.fragments.iter().map(|f| {
                                                                (
                                                                    f.line.text.to_string(),
                                                                    f.size,
                                                                    row.runs
                                                                        .first()
                                                                        .map(|r| r.font.weight.0)
                                                                        .unwrap_or(300.),
                                                                )
                                                            }),
                                                        );
                                                    }
                                                    let h = shaped.height;
                                                    let mapped = EditorLine {
                                                        start: row.start,
                                                        len: row.len,
                                                        tabs: vec![],
                                                        map: Some(row.map),
                                                        line_height: px(row.height),
                                                        line: WrappedLine::default(),
                                                        rich: Some(shaped),
                                                        origin: point(bounds.left(), y),
                                                    };
                                                    if image.is_none()
                                                        && focus.is_focused(window)
                                                        && cursor >= row.start
                                                        && cursor <= row.start + row.len
                                                    {
                                                        if let Some(p) =
                                                            mapped.position(cursor - row.start)
                                                        {
                                                            window.paint_quad(fill(
                                                                Bounds::new(
                                                                    mapped.origin + p,
                                                                    size(px(1.5), px(row.height)),
                                                                ),
                                                                color,
                                                            ));
                                                        }
                                                    }
                                                    y += h;
                                                    layout.push(mapped);
                                                }
                                                #[cfg(test)]
                                                cx.set_global(
                                                    super::super::tests::spec_tests::Painted(
                                                        painted,
                                                    ),
                                                );
                                                input.update(cx, |i, cx| {
                                                    let h = (y.max(note_bottom) - bounds.top())
                                                        .max(px(20.925));
                                                    if i.height != h
                                                        || i.rail.positions != positions
                                                        || i.assets.positions != image_positions
                                                    {
                                                        i.height = h;
                                                        i.rail.positions = positions;
                                                        i.assets.positions = image_positions;
                                                        cx.notify();
                                                    }
                                                    if i.reveal_cursor {
                                                        if let Some(p) =
                                                            layout.iter().find_map(|r| {
                                                                (cursor >= r.start
                                                                    && cursor <= r.start + r.len)
                                                                    .then(|| {
                                                                        r.position(cursor - r.start)
                                                                            .map(|p| r.origin + p)
                                                                    })
                                                                    .flatten()
                                                            })
                                                        {
                                                            let offset = i.scroll.offset();
                                                            let top = -offset.y;
                                                            let visible =
                                                                (i.scroll.bounds().size.height
                                                                    - px(48.))
                                                                .max(px(20.925));
                                                            let at = p.y - bounds.top();
                                                            i.scroll.set_offset(point(
                                                                px(0.),
                                                                if at < top {
                                                                    -at
                                                                } else if at + px(20.925)
                                                                    > top + visible
                                                                {
                                                                    visible - at - px(20.925)
                                                                } else {
                                                                    offset.y
                                                                },
                                                            ));
                                                        }
                                                        i.reveal_cursor = false;
                                                    }
                                                    i.layout = layout;
                                                });
                                            },
                                        )
                                        .flex_1()
                                        .min_w_0()
                                        .h(height)
                                        .flex_shrink_0(),
                                    )
                                    .child(rail),
                            )
                            .child(images),
                    ),
            )
            .into_any_element()
    }
}
