//! Note threads under their paragraphs: handwriting from o8, bubbles from you.
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
        // o8 speaks from the left in handwriting with no background; you answer
        // from the right, the way the chat does.
        let ink = self.note_color;
        let say = move |author: &str, text: String| {
            if author == "AI" {
                div()
                    // Keeps the line clear of the note's words at the right.
                    .pr(px(140.))
                    .font_family(theme().font_annotation)
                    .text_size(px(17.))
                    .line_height(px(20.))
                    .text_color(ink)
                    .child(text)
            } else {
                div().flex().justify_end().pl(px(28.)).child(
                    div()
                        .px(px(10.))
                        .py(px(5.))
                        .rounded(px(12.))
                        .bg(theme().surface_raised)
                        .font_family(theme().font_ui)
                        .text_size(px(13.))
                        .line_height(px(18.))
                        .text_color(theme().text)
                        .child(text),
                )
            }
        };
        div()
            .absolute()
            .left(px(4.))
            .right(px(8.))
            .top(px(22.))
            .children(notes.into_iter().filter(|note| !note.resolved).map(|note| {
                let id = note.id.clone();
                let measure_id = id.clone();
                let measure = cx.weak_entity();
                let top = self.rail.positions.get(&id).copied().unwrap_or(px(0.));
                let busy = self.rail.busy.as_ref().is_some_and(|(n, _)| n == &id);
                let actions: &[(&'static str, &'static str)] = if note.kind == "suggestion" {
                    &[("apply", "Apply"), ("reply", "Reply"), ("dismiss", "Dismiss")]
                } else {
                    &[("reply", "Reply"), ("act", "Do it"), ("resolve", "Done")]
                };
                let from_o8 = note.author == "AI";
                let working = self
                    .rail
                    .busy
                    .as_ref()
                    .filter(|(n, _)| n == &id)
                    .map(|(_, kind)| match kind.as_str() {
                        "reply" => "o8 is replying…",
                        "act" => "Starting…",
                        _ => "One moment…",
                    });
                let shown = busy || self.rail.reply.as_ref().is_some_and(|(n, _, _)| n == &id);
                div()
                    .id(ElementId::Name(format!("note-{id}").into()))
                    .debug_selector({
                        let id = id.clone();
                        move || format!("note-{id}")
                    })
                    .group("spec-note")
                    .absolute()
                    .top(top)
                    .left_0()
                    .right_0()
                    .flex()
                    .flex_col()
                    .gap(px(3.))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|_, _, _, cx| cx.stop_propagation()),
                    )
                    .child(say(
                        &note.author,
                        if note.text.is_empty() {
                            "suggested edit".into()
                        } else {
                            note.text
                        },
                    ))
                    .children(
                        note.replies
                            .into_iter()
                            .map(|(author, text)| say(&author, text)),
                    )
                    // Plain words that hold still, so nothing slides under the pointer.
                    .child(
                        div()
                            .absolute()
                            .top(px(-2.))
                            .when(from_o8, |d| d.right_0())
                            .when(!from_o8, |d| d.left_0())
                            .flex()
                            .gap(px(2.))
                            .when(!shown, |d| {
                                d.opacity(0.).group_hover("spec-note", |d| d.opacity(1.))
                            })
                            .children(actions.iter().map(|(kind, label)| {
                                let kind = *kind;
                                let target = id.clone();
                                control(
                                    format!("note-{id}-{kind}"),
                                    label,
                                    cx,
                                    move |this, window, cx| {
                                        if kind == "reply" {
                                            this.reply(target.clone(), window, cx)
                                        } else {
                                            this.request_note(
                                                target.clone(),
                                                kind.to_owned(),
                                                String::new(),
                                                cx,
                                            )
                                        }
                                    },
                                )
                                .min_h(px(20.))
                                .px(px(6.))
                                .when(self.rail.busy.is_some() && !busy, |d| d.opacity(0.35))
                            })),
                    )
                    .when_some(
                        self.rail.feedback.get(&id).filter(|(ok, _)| !*ok),
                        |d, (_, message)| {
                        d.child(
                            div()
                                .font_family(theme().font_ui)
                                .text_size(px(9.5))
                                .line_height(px(12.35))
                                .text_color(theme().danger)
                                .child(message.clone()),
                        )
                    },
                    )
                    .when_some(
                        self.rail.reply.as_ref().filter(|(n, _, _)| n == &id),
                        |d, (_, input, _)| {
                            d.child(
                                div()
                                    .debug_selector({
                                        let id = id.clone();
                                        move || format!("note-{id}-input")
                                    })
                                    .ml(px(120.))
                                    .min_h(px(30.))
                                    .px(px(10.))
                                    .py(px(5.))
                                    .rounded(px(12.))
                                    .bg(theme().surface_raised)
                                    .text_size(px(13.))
                                    .child(input.clone()),
                            )
                        },
                    )
                    .when_some(working, |d, text| {
                        d.child(
                            div()
                                .font_family(theme().font_ui)
                                .text_size(px(11.))
                                .text_color(theme().text_faint)
                                .child(text),
                        )
                    })
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
