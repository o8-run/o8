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
/// Classic's SHELL_EDGE_INSET (shell-geometry.ts).
const EDGE_INSET: f32 = 4.;
/// Classic's workspace card corner (WORKSPACE_RAIL_CORNER_RADIUS, branch-rail-geometry.ts).
const CARD_RADIUS: f32 = 26.;
/// Width the frame takes from the panel row: the inset and its two borders.
pub(super) const FRAME_SPACE: f32 = EDGE_INSET;
/// Nothing frames the sidebar: it sits on the window and only the workspace is
/// a card. All Glass fills it with OrchestratorTab's fog, `--t-glass-muted`
/// fading to clear, with no border. Dark and light keep their colors, so a
/// border in their usual ink is what shows the corners (Q 2026-11-01).
fn workspace_card(element: gpui::Div) -> gpui::Div {
    let card = element.rounded(px(CARD_RADIUS)).overflow_hidden();
    if crate::theme::glass() {
        let fog = crate::theme::glass_muted();
        card.bg(gpui::linear_gradient(
            180.,
            gpui::linear_color_stop(fog, 0.),
            gpui::linear_color_stop(gpui::Rgba { a: 0., ..fog }, 1.),
        ))
    } else {
        card.border_1()
            .border_color(crate::theme::current().border)
    }
}
fn render(
    s: &mut Shell,
    frame: &Frame,
    window: &mut Window,
    cx: &mut Context<Shell>,
) -> Option<AnyElement> {
    // Settings takes over the window: only the rail stays, as in classic.
    if s.surfaces.settings.view.is_some() {
        // The panel's native pages draw above the window, so they still get covered.
        let _ = super::right_panel::element(s, window, cx);
        // Settings can open Shortcuts over itself, so the overlay order still decides.
        let page = registrations().iter().find_map(|r| (r.overlay)(s));
        return Some(
            div()
                .flex()
                .flex_1()
                .min_h_0()
                .min_w_0()
                .pt(px(EDGE_INSET))
                .pr(px(EDGE_INSET))
                .pb(px(EDGE_INSET))
                .child(
                    workspace_card(div().flex().flex_1().min_h_0().min_w_0()).children(page),
                )
                .into_any_element(),
        );
    }
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
    let content = workspace_card(div().flex().flex_col().flex_1().min_h_0().min_w_0())
        .child(content)
        .into_any_element();
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
                        // Classic's `workspaceInset` beside the panel column.
                        .mr(px(EDGE_INSET))
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
                    .rounded(px(14.))
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
            // Classic's frame (SHELL_EDGE_INSET, workspaceFrameCorners): the
            // workspace sits inset from the window edge with rounded corners.
            .pr(px(EDGE_INSET))
            .pb(px(EDGE_INSET))
            .on_drag_move(cx.listener(
                |s, event: &gpui::DragMoveEvent<super::super::sidebar::Resize>, _, cx| {
                    super::super::sidebar::resize(s, event);
                    cx.notify();
                },
            ))
            .child(div().flex().flex_1().min_h_0().min_w_0().child(content))
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
    // Working without a project (classic's home mode).
    let home = crate::shell::session::is_home(&repo);
    let (title, detail) = if home {
        (
            "What should we do?".to_owned(),
            "No project · agents start in your home folder".to_owned(),
        )
    } else {
        (format!("What should we build in {name}?"), repo)
    };
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
                        .child(title),
                )
                .child(
                    div()
                        .mt(px(10.))
                        .text_size(px(11.))
                        .text_color(theme().text_muted)
                        .child(detail),
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
