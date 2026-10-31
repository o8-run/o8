use super::*;
struct ContentSlot;
register_shell_feature!(ContentSlot);
impl ShellFeature for ContentSlot {
    fn slots(&self) -> &'static [RenderSlot] {
        &[RenderSlot {
            group: RenderGroup::Content,
            order: 600,
            render,
        }]
    }
}
fn render(
    s: &mut Shell,
    frame: &Frame,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> Option<AnyElement> {
    let active = s.active();
    let content = registrations()
        .iter()
        .find_map(|r| (r.overlay)(s))
        .or_else(|| registry::extensions().find_map(|extension| extension.overlay(s)))
        .or_else(|| {
            active
                .as_ref()
                .and_then(|t| s.content.get(&s.key(t)))
                .map(Content::element)
        });
    // The Activity Dock floats at the top right of the chat column.
    let content = div()
        .flex_1()
        .min_h_0()
        .relative()
        .child(content.unwrap_or_else(|| landing(s, frame, cx)))
        .children(super::activity_dock::element(s, window, cx))
        .into_any_element();
    let content = super::panes::element(s, content, cx);
    // The right panel sits inside the sidebar decoration, beside the content.
    super::right_panel::settle_resize(s, cx);
    let content = match super::right_panel::element(s, window, cx) {
        Some((panel, full, shown)) => div()
            .relative()
            .flex()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .on_drag_move(cx.listener(
                |s, event: &gpui::DragMoveEvent<super::right_panel::Resize>, window, cx| {
                    super::right_panel::resize(s, event, window);
                    cx.notify();
                },
            ))
            .when(!super::right_panel::maximized(s), |row| {
                row.child(
                    div()
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .child(content),
                )
            })
            .child(
                div()
                    .w(px(shown))
                    .h_full()
                    .flex_shrink_0()
                    .overflow_hidden()
                    .rounded_br(px(14.))
                    .when(s.system_glass || super::right_panel::maximized(s), |v| {
                        v.rounded_bl(px(14.))
                    })
                    .child(panel)
                    .map(|v| super::rail_drag::panel_target(s, v, cx)),
            )
            // The edge only once the column has finished opening.
            .when(shown >= full && !super::right_panel::maximized(s), |row| {
                row.child(super::right_panel::edge(s, shown, window, cx))
            })
            .into_any_element(),
        None => content,
    };

    // The width saves once, when the edge is let go.
    if s.surfaces.sidebar.resizing && !cx.has_active_drag() {
        s.surfaces.sidebar.resizing = false;
        s.surfaces.sidebar.press.set(None);
        s.persist();
    }
    let content = registrations()
        .iter()
        .fold(content, |content, registration| {
            (registration.decorate)(s, content)
        });
    Some(
        div()
            .flex()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .on_drag_move(cx.listener(
                |s, event: &gpui::DragMoveEvent<super::super::sidebar::Resize>, _, cx| {
                    super::super::sidebar::resize(s, event);
                    cx.notify();
                },
            ))
            .child(content)
            .into_any_element(),
    )
}

/// A workspace with nothing open lands on classic's compose-first prompt
/// (OrchestratorEmptyState): the question, the repository, and how to start.
fn landing(s: &Shell, frame: &Frame, cx: &mut Context<Shell>) -> AnyElement {
    let Some(repo) = s.state.selected.clone() else {
        return div().p(px(24.)).child(frame.empty).into_any_element();
    };
    let name = repo.rsplit('/').next().unwrap_or(&repo).to_owned();
    let action = |id: &'static str, label: &'static str| {
        div()
            .id(id)
            .debug_selector(move || id.into())
            .h(px(36.))
            .px(px(14.))
            .flex()
            .items_center()
            .rounded(px(10.))
            .border_1()
            .border_color(theme().border)
            .bg(theme().surface_raised)
            .text_size(px(13.))
            .text_color(theme().text)
            .cursor_pointer()
            .hover(|b| b.bg(theme().hover))
            .child(label)
    };
    div()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .p(px(24.))
        .child(
            div()
                .max_w(px(640.))
                .flex()
                .flex_col()
                .items_center()
                .child(
                    div()
                        .text_size(px(28.))
                        .font_weight(gpui::FontWeight::EXTRA_LIGHT)
                        .text_color(theme().text)
                        .text_center()
                        .child(format!("What should we build in {name}?")),
                )
                .child(
                    div()
                        .mt(px(10.))
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child(repo),
                )
                .child(
                    div()
                        .mt(px(24.))
                        .flex()
                        .gap(px(8.))
                        .child(action("landing-new-chat", "New chat").on_click(cx.listener(
                            |s, _, window, cx| {
                                s.capture(window, cx);
                                super::start_chat(s, window, cx);
                            },
                        )))
                        .child(action("landing-terminal", "Terminal").on_click(cx.listener(
                            |s, _, window, cx| {
                                s.capture(window, cx);
                                s.execute(Command::Terminal, window, cx);
                            },
                        ))),
                ),
        )
        .into_any_element()
}
