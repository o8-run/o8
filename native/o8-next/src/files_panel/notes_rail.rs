//! Classic's 150px shared-scroll handwritten note rail and compact action rows.
use super::super::spec::controls::control;
use super::super::spec_rfm::Note;
use super::*;
use crate::composer::Composer;
use std::collections::HashMap;
#[derive(Clone)]
pub(in crate::files_panel) struct Action {
    pub id: String,
    pub kind: String,
    pub message: String,
}
impl EventEmitter<Action> for Editor {}
#[derive(Default)]
pub(in crate::files_panel) struct Rail {
    pub context: Option<Point<Pixels>>,
    pub positions: HashMap<String, Pixels>,
    pub heights: HashMap<String, Pixels>,
    pub busy: Option<(String, String)>,
    pub feedback: HashMap<String, (bool, String)>,
    pub hovered: Option<(String, String)>,
    pub reply: Option<(String, Entity<Composer>, Subscription)>,
}
impl Editor {
    fn request_note(&mut self, id: String, kind: String, message: String, cx: &mut Context<Self>) {
        if self.rail.busy.is_none() {
            cx.emit(Action { id, kind, message });
        }
    }
    fn reply(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.rail.busy.is_some() {
            return;
        }
        if self
            .rail
            .reply
            .as_ref()
            .is_some_and(|(old, _, _)| old == &id)
        {
            self.rail.reply = None;
            self.focus.focus(window);
            cx.notify();
            return;
        }
        let input = cx.new(|cx| {
            let mut input = Composer::new(cx);
            input.inline = true;
            input.placeholder = "Reply…".into();
            input
        });
        let parent = id.clone();
        let subscription = cx.subscribe(
            &input,
            move |this, input, _: &crate::composer::Submit, cx| {
                let message = input.read(cx).text.trim().to_owned();
                if !message.is_empty() {
                    this.request_note(parent.clone(), "reply".into(), message, cx);
                }
            },
        );
        input.read(cx).focus.focus(window);
        self.rail.reply = Some((id, input, subscription));
        cx.notify();
    }
    pub(super) fn note_rail(&self, notes: Vec<Note>, cx: &mut Context<Self>) -> AnyElement {
        div()
            .w(px(150.))
            .h(self.height)
            .flex_shrink_0()
            .relative()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _, _, cx| cx.stop_propagation()),
            )
            .children(notes.into_iter().map(|note| {
                let id = note.id.clone();
                let measure_id = id.clone();
                let measure = cx.weak_entity();
                let top = self.rail.positions.get(&id).copied().unwrap_or(px(0.));
                let busy = self.rail.busy.as_ref().is_some_and(|(n, _)| n == &id);
                let actions = if note.kind == "suggestion" {
                    vec![
                        ("apply", "Accept & apply", "m20 6-11 11-5-5"),
                        ("act", "Accept & act", "m13 2-10 12h9l-1 8 10-12h-9z"),
                        ("reply", "Reply", "m9 14-5-5 5-5m-5 5h12a4 4 0 0 1 4 4v7"),
                        ("dismiss", "Dismiss", "m6 6 12 12M6 18 18 6"),
                    ]
                } else {
                    vec![
                        ("reply", "Reply", "m9 14-5-5 5-5m-5 5h12a4 4 0 0 1 4 4v7"),
                        ("act", "Accept & act", "m13 2-10 12h9l-1 8 10-12h-9z"),
                        (
                            "resolve",
                            "Resolve",
                            "m22 4-10 10-3-3M22 12a10 10 0 1 1-6-9",
                        ),
                    ]
                };
                let active = self
                    .rail
                    .busy
                    .as_ref()
                    .or(self.rail.hovered.as_ref())
                    .filter(|(n, _)| n == &id)
                    .and_then(|(_, a)| actions.iter().find(|(k, _, _)| a == k));
                let label_color =
                    if active.is_some_and(|(kind, _, _)| matches!(*kind, "apply" | "act")) {
                        theme().success
                    } else {
                        theme().text_faint
                    };
                let label = active
                    .map(|(_, label, _)| {
                        if busy {
                            format!("{label}…")
                        } else {
                            label.to_string()
                        }
                    })
                    .unwrap_or_default();
                let ink = if note.author == "AI" {
                    self.note_color
                } else {
                    theme().text_secondary
                };
                div()
                    .id(ElementId::Name(format!("note-{id}").into()))
                    .debug_selector({
                        let id = id.clone();
                        move || format!("note-{id}")
                    })
                    .absolute()
                    .top(top - px(3.))
                    .right_0()
                    .w(px(134.))
                    .pt(px(3.))
                    .pb(px(4.))
                    .pl(px(14.))
                    .pr(px(6.))
                    .rounded(px(9.))
                    .hover(|d| d.bg(theme().hover))
                    .when(note.resolved, |d| d.opacity(0.4))
                    .child(
                        div()
                            .flex()
                            .gap(px(6.))
                            .items_center()
                            .text_size(px(9.))
                            .font_family(theme().font_ui)
                            .text_color(ink)
                            .child(if note.author == "AI" { "o8" } else { "you" })
                            .when(note.resolved, |d| d.child("resolved")),
                    )
                    .child(
                        div()
                            .font_family("Caveat")
                            .text_size(px(18.))
                            .line_height(px(20.7))
                            .text_color(ink)
                            .when(note.resolved, |d| d.line_through())
                            .child(if note.text.is_empty() {
                                "suggested edit".into()
                            } else {
                                note.text
                            }),
                    )
                    .children(note.replies.into_iter().map(|(author, text)| {
                        div()
                            .pl(px(12.))
                            .mt(px(3.))
                            .font_family("Caveat")
                            .text_size(px(16.))
                            .line_height(px(18.4))
                            .text_color(if author == "AI" {
                                self.note_color
                            } else {
                                theme().text_secondary
                            })
                            .child(format!("↳ {text}"))
                    }))
                    .when(!note.resolved, |d| {
                        d.child(
                            div()
                                .mt(px(5.))
                                .child(div().flex().gap(px(2.)).children(actions.into_iter().map(
                                    |(kind, label, icon)| {
                                        let target = id.clone();
                                        let key = kind.to_owned();
                                        let hover_id = id.clone();
                                        let hover_key = kind.to_owned();
                                        control(
                                            format!("note-{id}-{kind}"),
                                            "",
                                            cx,
                                            move |this, window, cx| {
                                                if kind == "reply" {
                                                    this.reply(target.clone(), window, cx)
                                                } else {
                                                    this.request_note(
                                                        target.clone(),
                                                        key.clone(),
                                                        String::new(),
                                                        cx,
                                                    )
                                                }
                                            },
                                        )
                                        .size(px(22.))
                                        .min_h(px(22.))
                                        .p_0()
                                        .when(self.rail.busy.is_some() && !busy, |d| {
                                            d.opacity(0.35)
                                        })
                                        .child(crate::icon::stroke(
                                            icon,
                                            if matches!(kind, "apply" | "act") {
                                                theme().success
                                            } else {
                                                theme().text_faint
                                            },
                                            14.,
                                            1.8,
                                        ))
                                        .on_hover(cx.listener(move |this, hover, _, cx| {
                                            this.rail.hovered = if *hover {
                                                Some((hover_id.clone(), hover_key.clone()))
                                            } else {
                                                None
                                            };
                                            cx.notify();
                                        }))
                                        .tooltip(
                                            move |_, cx| {
                                                cx.new(move |_| crate::icon::Tip(label.into()))
                                                    .into()
                                            },
                                        )
                                    },
                                )))
                                .child(
                                    div()
                                        .h(px(13.))
                                        .font_family(theme().font_ui)
                                        .text_size(px(9.))
                                        .text_color(label_color)
                                        .whitespace_nowrap()
                                        .overflow_hidden()
                                        .child(label),
                                ),
                        )
                    })
                    .when_some(self.rail.feedback.get(&id), |d, (ok, message)| {
                        d.child(
                            div()
                                .mt(px(5.))
                                .font_family(theme().font_ui)
                                .text_size(px(9.5))
                                .line_height(px(12.35))
                                .text_color(if *ok { theme().success } else { theme().danger })
                                .child(message.clone()),
                        )
                    })
                    .when_some(
                        self.rail.reply.as_ref().filter(|(n, _, _)| n == &id),
                        |d, (_, input, _)| {
                            d.child(
                                div()
                                    .debug_selector({
                                        let id = id.clone();
                                        move || format!("note-{id}-input")
                                    })
                                    .mt(px(5.))
                                    .min_h(px(24.))
                                    .border_b_1()
                                    .border_color(theme().border)
                                    .child(input.clone()),
                            )
                        },
                    )
                    .child(
                        canvas(
                            |_, _, _| (),
                            move |bounds, _, _, cx| {
                                let _ = measure.update(cx, |editor, cx| {
                                    let h = bounds.size.height;
                                    if editor
                                        .rail
                                        .heights
                                        .get(&measure_id)
                                        .is_none_or(|old| (*old - h).abs() > px(1.))
                                    {
                                        editor.rail.heights.insert(measure_id.clone(), h);
                                        cx.notify();
                                    }
                                });
                            },
                        )
                        .absolute()
                        .size_full(),
                    )
            }))
            .into_any_element()
    }
}
