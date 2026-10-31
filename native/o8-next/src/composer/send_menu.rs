//! The send menu (Send, Queue for later, Fork with this prompt) and Stop while
//! the agent works. Q 2026-10-31, after the Claude desktop composer: the Send
//! button's hold or right-click opens the menu; ⌘↵ queues and ⌥⌘↵ forks.
use super::*;
use gpui::{AnyElement, Div, SharedString, Stateful};

/// Lucide "square" filled, as the stop control draws it.
const STOP_SIZE: f32 = 9.;

impl Surface {
    /// This chat's agent has a turn in flight.
    pub(crate) fn turn_running(&self) -> bool {
        self.transcript
            .as_ref()
            .is_some_and(|transcript| transcript.context_snapshot().1)
    }

    /// The conversation has turns a fork can carry.
    pub(super) fn can_fork(&self) -> bool {
        self.transcript
            .as_ref()
            .is_some_and(|transcript| !transcript.shown_entries().is_empty())
    }

    /// "Queue for later": this one send waits for the agent's next turn.
    pub(crate) fn queue_prompt(&mut self, cx: &mut Context<Self>) {
        let steer = std::mem::replace(&mut self.send_next, true);
        self.send(None, cx);
        self.send_next = steer;
    }

    /// "Fork with this prompt": copies this conversation into a new thread,
    /// moves the draft there and sends it once that thread is ready. This
    /// thread and its running turn are untouched.
    pub(crate) fn fork_prompt(&mut self, cx: &mut Context<Self>) {
        let editor = self.composer.clone();
        let input = editor.read(cx);
        if self.saving
            || !self.queue_ready
            || input.composing()
            || input.controls.busy
            || input.controls.pending_images > 0
        {
            return;
        }
        let draft = input.text.clone();
        if draft.trim().is_empty()
            && input.controls.images.is_empty()
            && input.controls.files.is_empty()
        {
            return;
        }
        let Some(session) = self
            .sessions
            .iter()
            .find(|s| Some(&s.id) == self.selected.as_ref())
            .cloned()
        else {
            return;
        };
        if !self.can_fork() {
            editor.update(cx, |i, cx| {
                i.controls.error = "Nothing to fork yet. Send the first message here.".into();
                cx.notify();
            });
            return;
        }
        let entries = self
            .transcript
            .as_ref()
            .map(|t| t.shown_entries().to_vec())
            .unwrap_or_default();
        let routing = self.composer_routing(cx).unwrap_or(Value::Null);
        let client = self.client.clone();
        let origin = session.id.clone();
        editor.update(cx, |i, cx| {
            i.controls.open = None;
            i.controls.busy = true;
            i.controls.error.clear();
            cx.notify();
        });
        let task = cx.background_executor().spawn(async move {
            super::command_client::fork(&client, &session, &entries, &routing)
        });
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let _ = this.update(cx, |s, cx| {
                editor.update(cx, |i, cx| {
                    i.controls.busy = false;
                    if let Err(error) = &result {
                        i.controls.error = format!("Fork failed: {error}");
                    }
                    cx.notify();
                });
                let Ok((destination, prelude)) = result else {
                    return;
                };
                let id = destination.id.clone();
                s.sessions.retain(|session| session.id != id);
                s.sessions.insert(0, destination);
                if s.selected.as_ref() != Some(&origin) || s.composer != editor {
                    editor.update(cx, |i, cx| {
                        i.controls.prompt.feedback =
                            "The fork was created. Your draft stayed here because the conversation changed.".into();
                        cx.notify();
                    });
                    cx.notify();
                    return;
                }
                let (text, images, files) = editor.update(cx, |i, cx| {
                    let carried = (
                        i.text.clone(),
                        std::mem::take(&mut i.controls.images),
                        std::mem::take(&mut i.controls.files),
                    );
                    i.clear(cx);
                    carried
                });
                s.select(id.clone(), cx);
                s.composer.update(cx, |i, cx| {
                    i.set_text(&text, cx);
                    i.controls.images = images;
                    i.controls.files = files;
                    if !prelude.is_empty() {
                        i.controls.prompt.prelude = prelude;
                    }
                    cx.notify();
                });
                s.fork_send = Some(id);
                cx.notify();
            });
        })
        .detach();
    }

    /// Stops this chat's turn, as the desktop stop pill does.
    pub(crate) fn stop_turn(&mut self, cx: &mut Context<Self>) {
        let Some(session) = self
            .sessions
            .iter()
            .find(|s| Some(&s.id) == self.selected.as_ref())
        else {
            return;
        };
        let Some(repo) = session.repo_path.clone() else {
            return;
        };
        let thread = session.id.clone();
        let backend = self
            .composer_routing(cx)
            .and_then(|routing| routing["backend"].as_str().map(str::to_owned));
        let client = self.client.clone();
        let task = cx.background_executor().spawn(async move {
            crate::transport::interrupt(&client, &repo, &thread, backend.as_deref())
        });
        cx.spawn(async move |this, cx| {
            if let Err(error) = task.await {
                let _ = this.update(cx, |s, cx| {
                    s.notice = error;
                    cx.notify();
                });
            }
        })
        .detach();
    }

    /// The square Stop beside the primary button while a turn runs.
    pub(super) fn stop_button(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        self.composer_button("composer-stop", "", true, cx, |s, window, cx| {
            s.stop_turn(cx);
            s.composer.read(cx).focus.focus(window);
        })
        .w(px(28.))
        .h(px(28.))
        .px(px(0.))
        .rounded_full()
        .justify_center()
        .tooltip(|_, cx| cx.new(|_| crate::icon::Tip("Stop · Esc".into())).into())
        .child(div().size(px(STOP_SIZE)).rounded(px(2.)).bg(theme().text))
    }

    /// The send menu's rows, each with its shortcut.
    pub(super) fn send_menu_rows(&self, busy: bool, cx: &mut Context<Self>) -> Vec<AnyElement> {
        let steer = self.turn_running() && self.queue["canSteer"] == true;
        let fork = self.can_fork();
        [
            (
                "send-menu-send",
                if steer { "Steer now" } else { "Send" },
                "↵",
                !busy,
            ),
            ("send-menu-queue", "Queue for later", "⌘ ↵", !busy),
            (
                "send-menu-fork",
                "Fork with this prompt",
                "⌥ ⌘ ↵",
                !busy && fork,
            ),
        ]
        .into_iter()
        .map(|(id, label, keys, enabled)| {
            self.composer_button(id, "", enabled, cx, move |s, window, cx| {
                s.close_composer_picker(window, cx);
                match id {
                    "send-menu-queue" => s.queue_prompt(cx),
                    "send-menu-fork" => s.fork_prompt(cx),
                    _ => s.send(None, cx),
                }
            })
            .w_full()
            .h(px(32.))
            .px(px(10.))
            .rounded(px(8.))
            .child(
                div()
                    .flex_1()
                    .text_size(px(12.5))
                    .text_color(theme().text)
                    .child(label),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .text_color(theme().text_muted)
                    .child(SharedString::from(keys)),
            )
            .into_any_element()
        })
        .collect()
    }
}
