//! The Shortcuts editor: every command, its chord and where that chord comes
//! from. It renders a snapshot of the shell's model and reports choices back.
use super::keymap::{Row, Scope, Source, display};
use super::*;
use crate::theme::current as theme;

pub(super) enum Event {
    Close,
    Begin(String),
    Reset(String),
    ResetAll,
    Scope(Scope),
}
pub(crate) struct Editor {
    pub rows: Vec<Row>,
    pub scope: Scope,
    pub capturing: Option<String>,
    pub notice: Option<String>,
    pub focus: FocusHandle,
    pub return_focus: Option<FocusHandle>,
    pub scroll: gpui::ScrollHandle,
}
impl gpui::EventEmitter<Event> for Editor {}

fn button(id: String, label: String, selected: bool) -> gpui::Stateful<gpui::Div> {
    let selector = id.clone();
    div()
        .id(gpui::SharedString::from(id))
        .debug_selector(move || selector.clone())
        .px(px(8.))
        .py(px(4.))
        .rounded(px(6.))
        .border_1()
        .border_color(theme().border)
        .when(selected, |b| b.bg(theme().surface))
        .cursor_pointer()
        .child(label)
}

impl Render for Editor {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let scope = |scope: Scope, label: &str, id: &str, cx: &mut Context<Self>| {
            button(id.into(), label.into(), self.scope == scope).on_click(cx.listener(
                move |_, _, _, cx| {
                    cx.emit(Event::Scope(scope));
                    cx.stop_propagation();
                },
            ))
        };
        let header =
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .p(px(12.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child("Customize shortcuts")
                        .child(
                            button("shortcuts-editor-close".into(), "Close".into(), false)
                                .on_click(cx.listener(|_, _, _, cx| {
                                    cx.emit(Event::Close);
                                    cx.stop_propagation();
                                })),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .child(div().text_color(theme().text_secondary).child("Save to"))
                        .child(scope(Scope::Global, "Global", "shortcuts-scope-global", cx))
                        .child(scope(
                            Scope::Machine,
                            "This machine",
                            "shortcuts-scope-machine",
                            cx,
                        ))
                        .child(div().flex_1())
                        .child(
                            button("shortcuts-reset-all".into(), "Reset all".into(), false)
                                .on_click(cx.listener(|_, _, _, cx| {
                                    cx.emit(Event::ResetAll);
                                    cx.stop_propagation();
                                })),
                        ),
                )
                .children(self.notice.clone().map(|notice| {
                    div()
                        .debug_selector(|| "shortcuts-notice".into())
                        .text_color(theme().text_secondary)
                        .child(notice)
                }));
        let rows = self.rows.iter().map(|row| {
            let id = row.id.clone();
            let capturing = self.capturing.as_deref() == Some(row.id.as_str());
            let chord = if capturing {
                "Press a shortcut…".to_string()
            } else {
                row.chord
                    .as_deref()
                    .map(display)
                    .unwrap_or_else(|| "—".into())
            };
            let begin = id.clone();
            let reset = id.clone();
            div()
                .flex()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .child(row.label.clone())
                        .when(!row.conflicts.is_empty(), |d| {
                            let selector = format!("shortcut-conflict-{id}");
                            d.child(
                                div()
                                    .debug_selector(move || selector.clone())
                                    .text_color(theme().text_secondary)
                                    .child(format!("Conflicts with {}", row.conflicts.join(", "))),
                            )
                        }),
                )
                .child(
                    div()
                        .text_color(theme().text_secondary)
                        .child(row.source.label()),
                )
                .child(
                    button(format!("shortcut-capture-{id}"), chord, capturing)
                        .font_family(theme().font_mono)
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.emit(Event::Begin(begin.clone()));
                            cx.stop_propagation();
                        })),
                )
                .when(row.source != Source::Default, |d| {
                    d.child(
                        button(format!("shortcut-reset-{id}"), "Reset".into(), false).on_click(
                            cx.listener(move |_, _, _, cx| {
                                cx.emit(Event::Reset(reset.clone()));
                                cx.stop_propagation();
                            }),
                        ),
                    )
                })
        });
        gpui::anchored().position(point(px(0.), px(0.))).child(
            gpui::deferred(
                div()
                    .id("shortcuts-editor-backdrop")
                    .w(window.viewport_size().width)
                    .h(window.viewport_size().height)
                    .p(px(24.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(theme().surface)
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(Event::Close)))
                    .child(
                        div()
                            .id("shortcuts-editor")
                            .debug_selector(|| "shortcuts-editor".into())
                            .track_focus(&self.focus)
                            .w_full()
                            .max_w(px(640.))
                            .h_full()
                            .max_h(px(640.))
                            .flex()
                            .flex_col()
                            .min_h_0()
                            .rounded(px(12.))
                            .border_1()
                            .border_color(theme().border)
                            .bg(theme().background)
                            .on_click(|_, _, cx| cx.stop_propagation())
                            .child(header)
                            .child(
                                div()
                                    .id("shortcuts-editor-list")
                                    .track_scroll(&self.scroll)
                                    .flex_1()
                                    .min_h_0()
                                    .overflow_y_scroll()
                                    .p(px(12.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(8.))
                                    .children(rows),
                            ),
                    ),
            )
            .with_priority(10),
        )
    }
}
