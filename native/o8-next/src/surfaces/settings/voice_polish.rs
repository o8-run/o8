//! Settings › Voice › Polish, from the desktop voice window's Polish tab:
//! custom words, snippets and instructions for how dictation is cleaned up.
//! Values live in `voice-prefs.json` on this Mac (see `voice_prefs`).
use super::voice_prefs::{self, Prefs};
use crate::composer::{Composer, Submit};
use crate::theme::current as theme;
use gpui::{
    AnyElement, Context, Entity, IntoElement, Render, SharedString, Subscription, Window, div,
    prelude::*, px,
};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::path::PathBuf;

const CLOSE: &str = "M6 6l12 12M18 6L6 18";
const SWAP: &str = "M7 7h13l-4-4 M17 17H4l4 4";
pub(crate) const MISSING: &str =
    "Voice settings appear here once o8 on this Mac has moved them to its new settings file.";
pub(crate) const UNREADABLE: &str =
    "o8 couldn't read this Mac's voice settings file, so it was left as it is.";

type Change = Box<dyn FnOnce(Option<&Value>) -> Value + Send>;

/// One step on the file, run off the UI thread, one at a time, in order.
enum Op {
    Read,
    Change(&'static str, Change),
}

pub(crate) struct VoicePolish {
    path: Option<PathBuf>,
    /// None until the first read returns.
    pub prefs: Option<Prefs>,
    shown: bool,
    queue: VecDeque<Op>,
    running: bool,
    word: Entity<Composer>,
    trigger: Entity<Composer>,
    replacement: Entity<Composer>,
    pub(crate) instructions: Entity<Composer>,
    /// The instructions last read, so a reload never replaces unsaved typing.
    instructions_read: String,
    _subscriptions: Vec<Subscription>,
}

fn input(placeholder: &str, cx: &mut Context<VoicePolish>) -> Entity<Composer> {
    let placeholder = placeholder.to_owned();
    cx.new(|cx| {
        let mut input = Composer::new(cx);
        input.focus = input.focus.clone().tab_stop(true);
        input.placeholder = placeholder;
        // No frame of its own: the field box around it is the frame.
        input.inline = true;
        input
    })
}

impl VoicePolish {
    pub(crate) fn new(path: Option<PathBuf>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let word = input("Add a word and press Enter", cx);
        let trigger = input("trigger", cx);
        let replacement = input("replacement", cx);
        let instructions = input("Tell o8 how to handle your dictation", cx);
        // A textarea, as on the desktop: Enter adds a line.
        instructions.update(cx, |input, _| input.newline_on_enter = true);
        let focus = instructions.read(cx).focus.clone();
        let subscriptions = vec![
            cx.subscribe(&word, |this, _, _: &Submit, cx| this.add_word(cx)),
            cx.subscribe(&replacement, |this, _, _: &Submit, cx| this.add_snippet(cx)),
            // Saved when the field is left, as on the desktop.
            cx.on_blur(&focus, window, |this, _, cx| this.save_instructions(cx)),
            cx.observe_window_activation(window, |this, window, cx| {
                if this.shown && window.is_window_active() {
                    this.load(cx);
                }
            }),
        ];
        Self {
            path,
            prefs: None,
            shown: false,
            queue: VecDeque::new(),
            running: false,
            word,
            trigger,
            replacement,
            instructions,
            instructions_read: String::new(),
            _subscriptions: subscriptions,
        }
    }

    /// Settings reports whether the panel is on screen; coming on screen rereads.
    pub(crate) fn set_shown(&mut self, shown: bool, cx: &mut Context<Self>) {
        let appearing = shown && !self.shown;
        self.shown = shown;
        if appearing {
            self.load(cx);
        }
    }

    pub(crate) fn load(&mut self, cx: &mut Context<Self>) {
        self.apply(Op::Read, cx);
    }

    fn change(
        &mut self,
        key: &'static str,
        change: impl FnOnce(Option<&Value>) -> Value + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        if matches!(self.prefs, Some(Prefs::Ready(_))) {
            self.apply(Op::Change(key, Box::new(change)), cx);
        }
    }

    fn apply(&mut self, op: Op, cx: &mut Context<Self>) {
        self.queue.push_back(op);
        self.next(cx);
    }

    fn next(&mut self, cx: &mut Context<Self>) {
        if self.running {
            return;
        }
        let Some(path) = self.path.clone() else {
            self.queue.clear();
            self.received(Prefs::Missing, cx);
            return;
        };
        let Some(op) = self.queue.pop_front() else {
            return;
        };
        self.running = true;
        let work = cx.background_executor().spawn(async move {
            match op {
                Op::Read => voice_prefs::read(&path),
                Op::Change(key, change) => voice_prefs::update(&path, key, change),
            }
        });
        cx.spawn(async move |this, cx| {
            let prefs = work.await;
            let _ = this.update(cx, |this, cx| {
                this.running = false;
                // A queued step reads again; show only the latest file.
                if this.queue.is_empty() {
                    this.received(prefs, cx);
                }
                this.next(cx);
            });
        })
        .detach();
    }

    fn received(&mut self, prefs: Prefs, cx: &mut Context<Self>) {
        if let Prefs::Ready(map) = &prefs {
            let saved = map
                .get("polish_instructions")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let unchanged = self.instructions.read(cx).text == self.instructions_read;
            if unchanged && saved != self.instructions_read {
                self.instructions
                    .update(cx, |input, cx| input.set_text(&saved, cx));
            }
            self.instructions_read = saved;
        }
        self.prefs = Some(prefs);
        cx.notify();
    }

    fn value(&self, key: &str) -> Option<&Value> {
        match &self.prefs {
            Some(Prefs::Ready(map)) => map.get(key),
            _ => None,
        }
    }

    fn add_word(&mut self, cx: &mut Context<Self>) {
        let word = self.word.read(cx).text.trim().to_owned();
        self.word.update(cx, |input, cx| input.set_text("", cx));
        if word.is_empty() {
            return;
        }
        self.change(
            "dictionary",
            move |current| {
                let mut words = voice_prefs::strings(current);
                if !words
                    .iter()
                    .any(|w| w.to_lowercase() == word.to_lowercase())
                {
                    words.push(word);
                }
                json!(words)
            },
            cx,
        );
    }

    fn remove_word(&mut self, word: String, cx: &mut Context<Self>) {
        self.change(
            "dictionary",
            move |current| {
                let words: Vec<String> = voice_prefs::strings(current)
                    .into_iter()
                    .filter(|w| *w != word)
                    .collect();
                json!(words)
            },
            cx,
        );
    }

    fn add_snippet(&mut self, cx: &mut Context<Self>) {
        let trigger = self.trigger.read(cx).text.trim().to_owned();
        let replacement = self.replacement.read(cx).text.trim().to_owned();
        if trigger.is_empty() || replacement.is_empty() {
            return;
        }
        self.trigger.update(cx, |input, cx| input.set_text("", cx));
        self.replacement
            .update(cx, |input, cx| input.set_text("", cx));
        self.change(
            "replacements",
            move |current| {
                let mut rules: Vec<(String, String)> = voice_prefs::rules(current)
                    .into_iter()
                    .filter(|(t, _)| t.to_lowercase() != trigger.to_lowercase())
                    .collect();
                rules.push((trigger, replacement));
                voice_prefs::rules_value(&rules)
            },
            cx,
        );
    }

    fn remove_snippet(&mut self, trigger: String, cx: &mut Context<Self>) {
        self.change(
            "replacements",
            move |current| {
                let rules: Vec<(String, String)> = voice_prefs::rules(current)
                    .into_iter()
                    .filter(|(t, _)| *t != trigger)
                    .collect();
                voice_prefs::rules_value(&rules)
            },
            cx,
        );
    }

    fn save_instructions(&mut self, cx: &mut Context<Self>) {
        let text = self.instructions.read(cx).text.trim().to_owned();
        if text == self.instructions_read {
            return;
        }
        self.instructions_read = text.clone();
        self.change("polish_instructions", move |_| json!(text), cx);
    }

    fn button(
        &self,
        id: &'static str,
        label: &'static str,
        cx: &mut Context<Self>,
        run: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> impl IntoElement {
        div()
            .id(id)
            .debug_selector(move || id.into())
            .flex_none()
            .px(px(12.))
            .py(px(5.))
            .rounded(px(8.))
            .text_size(px(12.))
            .text_color(crate::theme::on_accent())
            .bg(theme().accent)
            .cursor_pointer()
            .hover(|v| v.opacity(0.9))
            .on_click(cx.listener(move |this, _, _, cx| run(this, cx)))
            .child(label)
    }

    fn remove_button(
        &self,
        id: String,
        size: f32,
        cx: &mut Context<Self>,
        run: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> impl IntoElement {
        let selector = id.clone();
        div()
            .id(SharedString::from(id))
            .debug_selector(move || selector.clone())
            .size(px(size))
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .rounded(px(6.))
            .cursor_pointer()
            .hover(|v| v.bg(theme().hover))
            .on_click(cx.listener(move |this, _, _, cx| run(this, cx)))
            .child(crate::icon::stroke(
                CLOSE,
                theme().text_muted,
                size - 6.,
                2.,
            ))
    }

    fn word_chip(&self, index: usize, word: &str, cx: &mut Context<Self>) -> AnyElement {
        let owned = word.to_owned();
        div()
            .debug_selector(move || format!("settings-voice-polish-word-{index}"))
            .h(px(28.))
            .pl(px(11.))
            .pr(px(5.))
            .flex()
            .items_center()
            .gap(px(4.))
            .rounded(px(14.))
            .border_1()
            .border_color(theme().border)
            .text_size(px(12.5))
            .child(word.to_owned())
            .child(self.remove_button(
                format!("settings-voice-polish-word-remove-{index}"),
                18.,
                cx,
                move |this, cx| this.remove_word(owned.clone(), cx),
            ))
            .into_any_element()
    }

    fn snippet_row(
        &self,
        index: usize,
        (trigger, replacement): &(String, String),
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let owned = trigger.clone();
        div()
            .debug_selector(move || format!("settings-voice-polish-snippet-{index}"))
            .flex()
            .items_center()
            .py(px(10.))
            .when(index > 0, |v| v.border_t_1().border_color(theme().border))
            .child(
                div()
                    .flex_none()
                    .text_size(px(12.5))
                    .font_family(theme().font_mono)
                    .child(trigger.clone()),
            )
            .child(
                div()
                    .mx(px(10.))
                    .child(crate::icon::stroke(SWAP, theme().text_muted, 13., 2.)),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(13.))
                    .text_color(theme().text_muted)
                    .child(replacement.clone()),
            )
            .child(div().ml(px(10.)).child(self.remove_button(
                format!("settings-voice-polish-snippet-remove-{index}"),
                22.,
                cx,
                move |this, cx| this.remove_snippet(owned.clone(), cx),
            )))
            .into_any_element()
    }
}

fn field(id: &'static str, input: &Entity<Composer>, cx: &gpui::App) -> gpui::Div {
    let focus = input.read(cx).focus.clone();
    div()
        .debug_selector(move || id.into())
        // The whole box takes the click, so the tall Instructions field
        // focuses wherever it is clicked, as a textarea does.
        .on_mouse_down(gpui::MouseButton::Left, move |_, window, cx| {
            focus.focus(window);
            // Settings' own focus tracking would otherwise take it back.
            cx.stop_propagation();
        })
        .cursor(gpui::CursorStyle::IBeam)
        .flex_1()
        .min_w_0()
        .px(px(10.))
        .py(px(7.))
        .rounded(px(8.))
        .border_1()
        .border_color(theme().border)
        .child(input.clone())
}

fn card(title: &'static str, hint: &'static str) -> gpui::Div {
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .p(px(14.))
        .rounded(px(12.))
        .border_1()
        .border_color(theme().border)
        .child(div().text_size(px(13.)).child(title))
        .child(
            div()
                .text_size(px(11.))
                .text_color(theme().text_muted)
                .child(hint),
        )
}

fn muted(text: &'static str) -> gpui::Div {
    div()
        .text_size(px(12.5))
        .text_color(theme().text_muted)
        .child(text)
}

impl Render for VoicePolish {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let page = div()
            .id("settings-voice-polish")
            .debug_selector(|| "settings-voice-polish".into())
            .flex()
            .flex_col()
            .gap(px(12.))
            .max_w(px(720.))
            .child("Polish");
        match &self.prefs {
            None => return page,
            Some(Prefs::Missing) => {
                return page.child(
                    muted(MISSING).debug_selector(|| "settings-voice-polish-unavailable".into()),
                );
            }
            Some(Prefs::Unreadable) => {
                return page.child(
                    muted(UNREADABLE).debug_selector(|| "settings-voice-polish-unavailable".into()),
                );
            }
            Some(Prefs::Ready(_)) => {}
        }
        let words = voice_prefs::strings(self.value("dictionary"));
        let rules = voice_prefs::rules(self.value("replacements"));
        let chips: Vec<AnyElement> = words
            .iter()
            .enumerate()
            .map(|(index, word)| self.word_chip(index, word, cx))
            .collect();
        let rows: Vec<AnyElement> = rules
            .iter()
            .enumerate()
            .map(|(index, rule)| self.snippet_row(index, rule, cx))
            .collect();
        page.child(
            card(
                "Custom words",
                "Proper nouns and terms o8 should always spell right. Applied on the next dictation — no relaunch.",
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(field("settings-voice-polish-word-input", &self.word, cx))
                    .child(self.button("settings-voice-polish-word-add", "Add", cx, |this, cx| {
                        this.add_word(cx)
                    })),
            )
            .when(chips.is_empty(), |v| v.child(muted("No custom words yet.")))
            .when(!chips.is_empty(), |v| {
                v.child(div().flex().flex_wrap().gap(px(8.)).children(chips))
            }),
        )
        .child(
            card(
                "Snippets",
                "Expand short triggers into longer phrases after dictation. Applied as a deterministic pass on the cleaned text.",
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(field("settings-voice-polish-trigger-input", &self.trigger, cx))
                    .child(crate::icon::stroke(SWAP, theme().text_muted, 14., 2.))
                    .child(field("settings-voice-polish-replacement-input", &self.replacement, cx))
                    .child(self.button(
                        "settings-voice-polish-snippet-add",
                        "Add",
                        cx,
                        |this, cx| this.add_snippet(cx),
                    )),
            )
            .when(rows.is_empty(), |v| v.child(muted("No snippets yet.")))
            .children(rows),
        )
        .child(
            card(
                "Instructions",
                "Guidance for how o8 cleans up your dictation — e.g. “Keep my casual tone; always capitalize iOS.” Applied on the next dictation.",
            )
            .child(field("settings-voice-polish-instructions", &self.instructions, cx).min_h(px(120.))),
        )
    }
}
