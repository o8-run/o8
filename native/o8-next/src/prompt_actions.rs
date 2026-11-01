//! Hover/focus actions beneath user prompts. Continuing never mutates the source chat.
use super::*;
use gpui::{AnyElement, ClipboardItem, Entity, SharedString};
use std::time::Duration;

#[path = "prompt_actions/continuation.rs"]
pub(super) mod continuation;
#[path = "prompt_actions/metadata.rs"]
mod metadata;

const COPY: &str = "M9 9h11v11H9z M15 5V3H3v12h2";
const CHECK: &str = "M5 12.5 10 17.5 19 7";
const DOUBLE_CHECK: &str = "M2 12.5 7 17.5 16 7 M12 17.5 21 7";
const REWIND: &str = "M3 10h5 M3 10V5 M3 10a9 9 0 1 1 1 8";
const FORK: &str = "M4 5h4c6 0 2 14 8 14h4 M16 15l4 4-4 4 M4 19h4c6 0 2-14 8-14h4 M16 1l4 4-4 4";

struct Hint(SharedString);
impl Render for Hint {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .max_w(px(280.))
            .px(px(8.))
            .py(px(6.))
            .rounded(px(6.))
            .bg(crate::theme::menu_fill())
            .border_1()
            .border_color(theme().border)
            .font_family(theme().font_ui)
            .text_color(theme().text)
            .text_size(px(12.))
            .child(self.0.clone())
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Action {
    Copy,
    Fork,
    Rewind,
    Confirm,
    Cancel,
}

#[derive(Clone)]
struct Attempt {
    source: String,
    prompt: String,
    rewind: bool,
    destination: String,
}

#[derive(Default)]
pub(super) struct State {
    confirm: Option<String>,
    busy: bool,
    copied: Option<(String, Instant)>,
    error: Option<(String, String, String)>,
    attempt: Option<Attempt>,
    focus: HashMap<String, FocusHandle>,
    stage: &'static str,
    minute: u64,
}

impl State {
    pub(super) fn selection_changed(&mut self) {
        self.confirm = None;
        self.copied = None;
        self.focus.clear();
    }
}

#[derive(Clone)]
pub(super) struct Prompt {
    source: String,
    id: String,
    time: Option<u64>,
    delivery: (bool, &'static str),
    copied: bool,
    confirm: bool,
    busy: bool,
    fork_reason: Option<String>,
    rewind_reason: Option<String>,
    error: Option<String>,
    focus: Vec<FocusHandle>,
    stage: &'static str,
}

impl Surface {
    pub(super) fn prompt_clock(&mut self, cx: &mut Context<Self>) {
        let minute = crate::clock::now() / 60;
        if self.transcript.is_some() && self.prompt_actions.minute != minute {
            self.prompt_actions.minute = minute;
            cx.notify();
        }
    }

    fn prompt_reason(&self, rewind: bool, cx: &App) -> Option<String> {
        if self
            .selected
            .as_ref()
            .is_none_or(|id| !id.starts_with("thoughts-"))
        {
            Some("This history is read-only. Copy is still available.".into())
        } else if self.prompt_actions.busy || self.saving || self.composer.read(cx).controls.busy {
            Some("Wait for the current action to finish.".into())
        } else if !self.queue_ready || self.composer_routing(cx).is_none() {
            Some("Wait for this conversation to connect before continuing.".into())
        } else if rewind && self.turn_running() {
            Some("Rewind is unavailable while the agent is working.".into())
        } else {
            None
        }
    }

    pub(super) fn prompt_action_rows(&mut self, cx: &mut Context<Self>) -> HashMap<usize, Prompt> {
        let fork_reason = self.prompt_reason(false, cx);
        let rewind_reason = self.prompt_reason(true, cx);
        let Some(transcript) = &self.transcript else {
            return HashMap::new();
        };
        let entries: HashMap<_, _> = transcript
            .shown_entries()
            .iter()
            .map(|e| (e.id.as_str(), e))
            .collect();
        let mut prompts = HashMap::new();
        for (index, row) in self.rows.iter().enumerate() {
            let row = row.borrow();
            if !matches!(&row.row, Row::Message { role, .. } if role == "user") {
                continue;
            }
            let Some(entry) = entries.get(row.row.id()) else {
                continue;
            };
            let focus = ["copy", "rewind", "fork", "confirm", "cancel"]
                .iter()
                .map(|action| {
                    self.prompt_actions
                        .focus
                        .entry(format!("{action}-{}", entry.id))
                        .or_insert_with(|| cx.focus_handle())
                        .clone()
                })
                .collect();
            prompts.insert(
                index,
                Prompt {
                    source: self.selected.clone().unwrap_or_default(),
                    id: entry.id.clone(),
                    time: metadata::timestamp(entry),
                    delivery: metadata::delivery(entry),
                    copied: self.prompt_actions.copied.as_ref().is_some_and(|(id, at)| {
                        id == &entry.id && at.elapsed() < Duration::from_millis(1500)
                    }),
                    confirm: self.prompt_actions.confirm.as_ref() == Some(&entry.id),
                    busy: self.prompt_actions.busy
                        && self.prompt_actions.attempt.as_ref().is_some_and(|a| {
                            a.prompt == entry.id && self.selected.as_ref() == Some(&a.source)
                        }),
                    fork_reason: fork_reason.clone(),
                    rewind_reason: rewind_reason.clone(),
                    error: self
                        .prompt_actions
                        .error
                        .as_ref()
                        .filter(|(source, id, _)| {
                            self.selected.as_ref() == Some(source) && id == &entry.id
                        })
                        .map(|(_, _, error)| error.clone()),
                    focus,
                    stage: self.prompt_actions.stage,
                },
            );
        }
        prompts
    }

    fn remeasure_prompt(&self, id: &str) {
        if let Some(index) = self.rows.iter().position(|r| r.borrow().row.id() == id) {
            self.remeasure_action_row(index);
        }
    }

    pub(super) fn remeasure_action_row(&self, index: usize) {
        let anchor = self.list.logical_scroll_top();
        self.list.splice(index..index + 1, 1);
        // This is the same row with changed controls, not a replacement. GPUI's
        // splice resets an anchor inside its range, including on first paint.
        let after = self.list.logical_scroll_top();
        if after.item_ix != anchor.item_ix || after.offset_in_item != anchor.offset_in_item {
            self.list.scroll_to(anchor);
        }
    }

    fn prompt_event(
        &mut self,
        source: &str,
        id: &str,
        action: Action,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.selected.as_deref() != Some(source) {
            return;
        }
        let Some(entry) = self
            .transcript
            .as_ref()
            .and_then(|t| {
                t.shown_entries()
                    .iter()
                    .find(|e| e.id == id && e.role == "user")
            })
            .cloned()
        else {
            return;
        };
        if action == Action::Copy {
            cx.write_to_clipboard(ClipboardItem::new_string(entry.text));
            let at = Instant::now();
            self.prompt_actions.copied = Some((id.into(), at));
            cx.spawn(async move |view, cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(1500))
                    .await;
                let _ = view.update(cx, |s, cx| {
                    if s.prompt_actions
                        .copied
                        .as_ref()
                        .is_some_and(|(_, current)| *current == at)
                    {
                        s.prompt_actions.copied = None;
                        cx.notify();
                    }
                });
            })
            .detach();
            cx.notify();
            return;
        }
        if action == Action::Cancel {
            self.prompt_actions.confirm = None;
            self.remeasure_prompt(id);
            if let Some(focus) = self.prompt_actions.focus.get(&format!("rewind-{id}")) {
                focus.focus(window);
            }
            cx.notify();
            return;
        }
        let rewind = matches!(action, Action::Rewind | Action::Confirm);
        if self.prompt_reason(rewind, cx).is_some() {
            return;
        }
        if action == Action::Rewind {
            if let Some(previous) = self.prompt_actions.confirm.replace(id.into()) {
                self.remeasure_prompt(&previous);
            }
            self.remeasure_prompt(id);
            if let Some(focus) = self.prompt_actions.focus.get(&format!("confirm-{id}")) {
                focus.focus(window);
            }
            cx.notify();
            return;
        }
        if action == Action::Confirm && self.prompt_actions.confirm.as_deref() != Some(id) {
            return;
        }
        let Some(session) = self.sessions.iter().find(|s| s.id == source).cloned() else {
            return;
        };
        let Some(routing) = self.composer_routing(cx) else {
            return;
        };
        let attempt = self
            .prompt_actions
            .attempt
            .as_ref()
            .filter(|a| a.source == source && a.prompt == id && a.rewind == rewind)
            .cloned()
            .unwrap_or_else(|| Attempt {
                source: source.into(),
                prompt: id.into(),
                rewind,
                destination: format!(
                    "thoughts-next-{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                ),
            });
        self.prompt_actions.attempt = Some(attempt.clone());
        self.prompt_actions.busy = true;
        self.prompt_actions.stage = "Reading saved conversation…";
        self.prompt_actions.error = None;
        self.prompt_actions.confirm = None;
        self.remeasure_prompt(id);
        let editor = self.composer.clone();
        editor.update(cx, |i, cx| {
            i.controls.busy = true;
            cx.notify();
        });
        let generation = self.generation;
        let client = self.client.clone();
        let store = crate::composer::mode_store::path(
            &client.url("/").map(|u| u.to_string()).unwrap_or_default(),
            &attempt.destination,
            cx,
        );
        let (progress, stages) = async_channel::unbounded();
        let stage_destination = attempt.destination.clone();
        cx.spawn(async move |view, cx| {
            while let Ok(stage) = stages.recv().await {
                let _ = view.update(cx, |s, cx| {
                    if s.prompt_actions.busy
                        && s.prompt_actions
                            .attempt
                            .as_ref()
                            .is_some_and(|a| a.destination == stage_destination)
                    {
                        s.prompt_actions.stage = stage;
                        cx.notify();
                    }
                });
            }
        })
        .detach();
        let task_attempt = attempt.clone();
        let task = cx.background_executor().spawn(async move {
            continuation::create(
                &client,
                &session,
                &task_attempt.prompt,
                &entry.text,
                &task_attempt.destination,
                rewind,
                &routing,
                store,
                progress,
            )
        });
        let window = window.window_handle();
        cx.spawn(async move |view, cx| {
            let result = task.await;
            let _ = window.update(cx, |_, window, cx| {
                let _ = view.update(cx, |s, cx| {
                    s.prompt_actions.busy = false;
                    editor.update(cx, |i, cx| {
                        i.controls.busy = false;
                        cx.notify();
                    });
                    match result {
                        Err(error) => {
                            s.prompt_actions.error = Some((
                                attempt.source.clone(),
                                attempt.prompt.clone(),
                                format!("Continuation could not be verified: {error}"),
                            ))
                        }
                        Ok(saved) => {
                            let id = saved.session.id.clone();
                            s.sessions.retain(|session| session.id != id);
                            s.sessions.insert(0, saved.session);
                            s.prompt_actions.attempt = None;
                            if s.generation == generation
                                && s.selected.as_deref() == Some(&attempt.source)
                                && s.composer == editor
                            {
                                s.select(id, cx);
                                s.composer.read(cx).focus.focus(window);
                            }
                        }
                    }
                    s.remeasure_prompt(&attempt.prompt);
                    cx.notify();
                });
            });
        })
        .detach();
        cx.notify();
    }
}

fn control(
    view: &Entity<Surface>,
    prompt: &Prompt,
    name: &'static str,
    path: &'static str,
    tip: String,
    enabled: bool,
    focus: &FocusHandle,
    action: Action,
) -> gpui::Stateful<gpui::Div> {
    let id: SharedString = format!("prompt-{name}-{}", prompt.id).into();
    let (source, prompt_id) = (prompt.source.clone(), prompt.id.clone());
    let click = view.clone();
    let clicked_focus = focus.clone();
    let (key_source, key_id, key_view) = (source.clone(), prompt_id.clone(), view.clone());
    div()
        .id(id.clone())
        .debug_selector(move || id.to_string())
        .track_focus(focus)
        .tab_index(0)
        .size(px(26.))
        .flex_shrink_0()
        .rounded(px(7.))
        .border_1()
        .border_color(gpui::transparent_black())
        .focus(|s| s.border_color(theme().accent))
        .flex()
        .items_center()
        .justify_center()
        .when(enabled, |d| {
            d.cursor_pointer().hover(|d| d.bg(theme().hover))
        })
        .when(!enabled, |d| d.opacity(0.45))
        .tooltip(move |_, cx| cx.new(|_| Hint(tip.clone().into())).into())
        .child(crate::icon::stroke(
            path,
            if action == Action::Confirm {
                theme().danger
            } else {
                theme().text_muted
            },
            14.,
            1.8,
        ))
        .on_click(move |_, window, cx| {
            if enabled {
                clicked_focus.focus(window);
                click.update(cx, |s, cx| {
                    s.prompt_event(&source, &prompt_id, action, window, cx)
                });
            }
        })
        .on_key_down(move |event, window, cx| {
            if event.keystroke.key == "tab" {
                cx.stop_propagation();
                if event.keystroke.modifiers.shift {
                    window.focus_prev();
                } else {
                    window.focus_next();
                }
                key_view.update(cx, |_, cx| cx.notify());
                return;
            }
            if enabled && matches!(event.keystroke.key.as_str(), "enter" | "space") {
                cx.stop_propagation();
                key_view.update(cx, |s, cx| {
                    s.prompt_event(&key_source, &key_id, action, window, cx)
                });
            }
        })
}

pub(super) fn row(view: &Entity<Surface>, prompt: &Prompt, window: &Window) -> AnyElement {
    let visible = prompt.confirm
        || prompt.busy
        || prompt.error.is_some()
        || prompt.copied
        || prompt.focus.iter().any(|f| f.is_focused(window));
    let mut actions = div()
        .w_full()
        .flex()
        .items_center()
        .justify_end()
        .gap(px(3.))
        .text_size(px(10.))
        .text_color(theme().text_muted)
        .child(
            div()
                .id(SharedString::from(format!("prompt-delivery-{}", prompt.id)))
                .debug_selector({
                    let id = prompt.id.clone();
                    move || format!("prompt-delivery-{id}")
                })
                .size(px(16.))
                .tooltip({
                    let tip = prompt.delivery.1;
                    move |_, cx| cx.new(|_| Hint(tip.into())).into()
                })
                .child(crate::icon::stroke(
                    if prompt.delivery.0 {
                        DOUBLE_CHECK
                    } else {
                        CHECK
                    },
                    theme().text_muted,
                    14.,
                    1.8,
                )),
        );
    if let Some(time) = prompt.time {
        let absolute = metadata::absolute(time);
        actions = actions
            .child(
                div()
                    .id(SharedString::from(format!("prompt-time-{}", prompt.id)))
                    .debug_selector({
                        let id = prompt.id.clone();
                        move || format!("prompt-time-{id}")
                    })
                    .tooltip(move |_, cx| cx.new(|_| Hint(absolute.clone().into())).into())
                    .child(metadata::relative(time, crate::clock::now())),
            )
            .child("·");
    }
    actions = actions
        .child(control(view, prompt, "copy", if prompt.copied { CHECK } else { COPY }, if prompt.copied { "Copied" } else { "Copy" }.into(), true, &prompt.focus[0], Action::Copy))
        .child(control(view, prompt, "rewind", REWIND, prompt.rewind_reason.clone().unwrap_or_else(|| "Rewind from here. Restore this prompt in a continuation; keep the original chat and workspace files.".into()), prompt.rewind_reason.is_none(), &prompt.focus[1], Action::Rewind))
        .child(control(view, prompt, "fork", FORK, prompt.fork_reason.clone().unwrap_or_else(|| "Fork from here. Start a new conversation through this prompt. This one stays as it is.".into()), prompt.fork_reason.is_none(), &prompt.focus[2], Action::Fork));
    let mut body = div()
        .w_full()
        .max_w(px(crate::retained::COLUMN))
        .pr(px(18.))
        .pb(px(6.))
        .flex()
        .flex_col()
        .items_end()
        .when(!visible, |d| {
            d.opacity(0.).group_hover("prompt-row", |d| d.opacity(1.))
        })
        .child(actions);
    if prompt.busy {
        body = body.child(
            div()
                .text_size(px(11.))
                .text_color(theme().text_muted)
                .child(prompt.stage),
        );
    }
    if prompt.confirm {
        body = body.child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .flex_wrap()
                .justify_end()
                .text_size(px(11.))
                .text_color(theme().text_muted)
                .child("Reopen before this prompt? Original chat and files stay unchanged.")
                .child(
                    control(
                        view,
                        prompt,
                        "rewind-confirm",
                        CHECK,
                        "Rewind to an editable continuation".into(),
                        prompt.rewind_reason.is_none(),
                        &prompt.focus[3],
                        Action::Confirm,
                    )
                    .w_auto()
                    .px(px(8.))
                    .gap(px(4.))
                    .bg(theme().danger_surface)
                    .text_color(theme().danger)
                    .child("Rewind"),
                )
                .child(
                    control(
                        view,
                        prompt,
                        "rewind-cancel",
                        "M6 6l12 12 M6 18 18 6",
                        "Cancel rewind".into(),
                        true,
                        &prompt.focus[4],
                        Action::Cancel,
                    )
                    .w_auto()
                    .px(px(8.))
                    .gap(px(4.))
                    .child("Cancel"),
                ),
        );
    }
    if let Some(error) = &prompt.error {
        body = body.child(
            div()
                .text_size(px(11.))
                .text_color(theme().danger)
                .child(error.clone()),
        );
    }
    div()
        .w_full()
        .flex()
        .justify_center()
        .child(body)
        .into_any_element()
}
