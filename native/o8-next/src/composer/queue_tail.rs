use super::*;

/// The transcript's last item while messages wait (Q 2026-10-31): classic
/// shows each queued message inside the transcript as the user bubble it will
/// become, with a quiet caption (its state, why it waits, Steer now / Remove),
/// not in a band above the composer.
pub(crate) fn queue_tail(
    items: &[Value],
    enabled: bool,
    steerable_ids: &Value,
    view: gpui::Entity<Surface>,
) -> gpui::AnyElement {
    let link = |id: String, selector: &'static str, label: &'static str| {
        div()
            .id(gpui::ElementId::Name(id.into()))
            .debug_selector(move || selector.into())
            .cursor_pointer()
            .text_color(theme().text_muted)
            .hover(|d| d.text_color(theme().text))
            .child(label)
    };
    div()
        .w_full()
        .flex()
        .justify_center()
        .child(
            div()
                .id("composer-queue")
                .debug_selector(|| "composer-queue".into())
                .w_full()
                .max_w(px(crate::retained::COLUMN))
                .pl(px(18.))
                .pr(px(23.))
                .pb(px(12.))
                .flex()
                .flex_col()
                .gap(px(10.))
                .children(items.iter().cloned().map(|item| {
                    let (send, remove) = (view.clone(), view.clone());
                    let id = item["id"].as_str().unwrap_or("").to_owned();
                    let remove_id = id.clone();
                    let cancellable = enabled
                        && (item["status"] == "queued"
                            || item["status"] == "held"
                            || (item["status"] == "dispatching" && item["admittedAt"].is_null()));
                    let retryable = enabled
                        && item["status"] == "held"
                        && item["payload"]["routing"]["source"] == "bot-network";
                    let steerable = enabled
                        && item["status"] == "queued"
                        && item["intent"] == "send-next"
                        && item["admittedAt"].is_null()
                        && item["payload"]["afterTaskId"].is_null()
                        && steerable_ids
                            .as_array()
                            .is_some_and(|ids| ids.iter().any(|v| v == &id));
                    let text =
                        crate::text::sanitize(item["payload"]["text"].as_str().unwrap_or(""));
                    let caption_only = item["captionOnly"] == true;
                    div()
                        .flex()
                        .flex_col()
                        .items_end()
                        .min_w_0()
                        .gap(px(4.))
                        .when(!caption_only, |row| {
                            row.child(
                                div()
                                    .max_w(gpui::relative(0.8))
                                    .px(px(12.))
                                    .py(px(8.))
                                    .rounded(px(14.))
                                    .bg(theme().selection)
                                    .text_size(px(14.))
                                    .line_height(px(22.))
                                    // Wrapped then clamped: a long draft stays three lines.
                                    .child(
                                        div()
                                            .overflow_hidden()
                                            .text_ellipsis()
                                            .line_clamp(3)
                                            .child(text),
                                    ),
                            )
                        })
                        .child(
                            div()
                                .w_full()
                                .flex()
                                .justify_end()
                                .items_center()
                                .gap(px(8.))
                                .text_size(px(11.))
                                .text_color(theme().text_muted)
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .text_right()
                                        // A held earlier message explains itself in
                                        // full; it is why everything after it waits.
                                        .when(!caption_only, |d| {
                                            d.whitespace_nowrap().overflow_hidden().text_ellipsis()
                                        })
                                        .child(if caption_only {
                                            format!("Earlier message · {}", queue_caption(&item))
                                        } else {
                                            queue_caption(&item)
                                        }),
                                )
                                .when(steerable || retryable, |d| {
                                    d.child(
                                        link(
                                            format!("steer-{id}"),
                                            if retryable {
                                                "retry-network-send"
                                            } else {
                                                "steer-now"
                                            },
                                            if retryable { "Retry" } else { "Steer now" },
                                        )
                                        .on_click(
                                            move |_, _, cx| {
                                                send.update(cx, |this, cx| {
                                                    this.send(Some(id.clone()), cx)
                                                })
                                            },
                                        ),
                                    )
                                })
                                .when(cancellable, |d| {
                                    d.child(
                                        link(
                                            format!("remove-{remove_id}"),
                                            "remove-queued",
                                            "Remove",
                                        )
                                        .on_click(
                                            move |_, _, cx| {
                                                remove.update(cx, |this, cx| {
                                                    this.remove_queued(remove_id.clone(), cx)
                                                })
                                            },
                                        ),
                                    )
                                }),
                        )
                })),
        )
        .into_any_element()
}

/// A queued message's caption, in words: classic's "Queued" and "Needs
/// attention", with the reason trimmed of transport prefixes.
fn queue_caption(item: &Value) -> String {
    let state = match item["status"].as_str().unwrap_or("queued") {
        "held" => "Needs attention",
        "dispatching" => "Sending",
        _ => "Queued",
    };
    let Some(reason) = item["reason"].as_str().filter(|r| !r.trim().is_empty()) else {
        return state.into();
    };
    let reason = if reason.contains("no rollout found") {
        "this thread's Codex session can't be resumed. Remove it and send again.".to_owned()
    } else {
        let mut text = reason.trim();
        while let Some(rest) = text
            .strip_prefix("Error:")
            .or_else(|| text.strip_prefix("error:"))
        {
            text = rest.trim_start();
        }
        crate::text::sanitize(text)
    };
    format!("{state} · {reason}")
}
