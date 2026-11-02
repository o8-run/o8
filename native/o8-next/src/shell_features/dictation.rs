use super::*;
use crate::ui::{DictationState, VoiceTarget};
use serde_json::{Value, json};
// Composer dictation through the hidden voice host's HeadlessDictationHost
// (docs/development/native-voice-host.md, Composer dictation). The composer
// mic is classic MicButton in toggle mode: a tap starts dictation for the chat
// in front and the next tap stops it and sends what was said. Ctrl+Z held
// dictates until it is released, on macOS, where Ctrl+Z is not undo. The host
// relays full transcript snapshots; each replaces what follows the draft the
// recording started from, and the final one goes out through the chat's own
// send. GPT Live keeps the waveform (voice.rs); the host refuses a second
// microphone owner.
struct Dictation;
register_shell_feature!(Dictation);
impl ShellFeature for Dictation {
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 76,
            run: |s, _, _, cx| follow(s, cx),
        }]
    }
    fn keys(&self) -> &'static [KeyContext] {
        &[KeyContext {
            order: 45,
            dispatch: key,
        }]
    }
}

/// One recording, pinned to the chat and start request it began with.
#[derive(Default)]
struct Mic {
    state: DictationState,
    target: Option<VoiceTarget>,
    nonce: String,
    /// The start request; frames from an earlier recording carry another.
    request: String,
    view: Option<gpui::WeakEntity<crate::ui::Surface>>,
    /// The draft the recording started from.
    draft: String,
    /// Ctrl+Z started this recording; releasing it stops and sends.
    held: bool,
    /// The final transcript went out; the host's idle retires the recording.
    sent: bool,
}

impl Mic {
    fn active(&self) -> bool {
        self.state != DictationState::Off
    }
    /// The broker's binding fields and the start request every frame carries.
    fn owns(&self, payload: &Value) -> bool {
        self.active()
            && payload["requestId"] == self.request.as_str()
            && self.target.as_ref().is_some_and(|target| {
                payload["binding"] == target.binding.as_str()
                    && payload["nonce"] == self.nonce.as_str()
                    && payload["threadId"] == target.thread.as_str()
                    && payload["repoPath"] == target.repo.as_str()
            })
    }
    fn control(&self, extra: Value) -> Value {
        let mut body = extra;
        if let Some(target) = &self.target {
            body["binding"] = json!(target.binding);
            body["threadId"] = json!(target.thread);
            body["repoPath"] = json!(target.repo);
        }
        body["nonce"] = json!(self.nonce);
        body
    }
    /// The draft with a transcript after it.
    fn joined(&self, text: &str) -> String {
        let text = text.trim();
        if self.draft.is_empty() || self.draft.ends_with(char::is_whitespace) || text.is_empty() {
            format!("{}{text}", self.draft)
        } else {
            format!("{} {text}", self.draft)
        }
    }
}

fn active_view(s: &Shell) -> Option<Entity<crate::ui::Surface>> {
    s.active()
        .and_then(|tab| match s.content.get(&s.key(&tab)) {
            Some(Content::Session(view)) => Some(view.clone()),
            _ => None,
        })
}

fn pinned(s: &mut Shell) -> Option<Entity<crate::ui::Surface>> {
    s.features
        .get::<Mic>()
        .view
        .as_ref()
        .and_then(|view| view.upgrade())
}

fn stamp() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("{nanos:x}")
}

fn show(s: &mut Shell, state: DictationState, cx: &mut Context<Shell>) {
    s.features.get::<Mic>().state = state;
    if let Some(view) = pinned(s) {
        view.update(cx, |view, cx| view.set_dictation(state, cx));
    }
}

impl Shell {
    pub(crate) fn toggle_dictation(&mut self, cx: &mut Context<Shell>) {
        match self.features.get::<Mic>().state {
            DictationState::Off => start(self, false, cx),
            // MicButton: a tap while the microphone is requested cancels.
            DictationState::Starting => cancel(self, cx),
            DictationState::Listening => stop(self, cx),
            // Transcribing finishes uninterrupted.
            DictationState::Finishing => {}
        }
    }
    /// Releasing a held Ctrl+Z stops its recording and sends it.
    pub(crate) fn dictation_key_up(&mut self, event: &gpui::KeyUpEvent, cx: &mut Context<Shell>) {
        let mic = self.features.get::<Mic>();
        if mic.held && event.keystroke.key == "z" {
            mic.held = false;
            match mic.state {
                DictationState::Starting => cancel(self, cx),
                DictationState::Listening => stop(self, cx),
                _ => {}
            }
        }
    }
}

/// Ctrl+Z held dictates (macOS); repeats while held change nothing.
fn key(s: &mut Shell, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Shell>) -> KeyResult {
    let stroke = &event.keystroke;
    let hold = cfg!(target_os = "macos")
        && stroke.key == "z"
        && stroke.modifiers.control
        && !stroke.modifiers.platform
        && !stroke.modifiers.alt
        && !stroke.modifiers.shift;
    if !hold {
        return KeyResult::Unhandled;
    }
    if !event.is_held && !s.features.get::<Mic>().active() {
        start(s, true, cx);
    }
    KeyResult::Handled
}

fn start(s: &mut Shell, held: bool, cx: &mut Context<Shell>) {
    let Some(view) = active_view(s) else {
        toasts::info("Open a chat to dictate into it.", cx);
        cx.notify();
        return;
    };
    let Some(mut target) = view.read(cx).voice_binding(cx) else {
        toasts::info("This chat is not ready for dictation yet.", cx);
        cx.notify();
        return;
    };
    // Dictation and Live hold separate bindings on the host.
    target.binding = json!(["composer", target.repo, target.thread]).to_string();
    let request = format!("m-{}", stamp());
    *s.features.get::<Mic>() = Mic {
        state: DictationState::Off,
        target: Some(target),
        nonce: format!("d-{}", stamp()),
        request: request.clone(),
        draft: view.read(cx).draft(cx),
        view: Some(view.downgrade()),
        held,
        sent: false,
    };
    show(s, DictationState::Starting, cx);
    let body = s
        .features
        .get::<Mic>()
        .control(json!({"action":"dictation-start","requestId":request}));
    post(s, body, cx, move |this, result, cx| {
        if let Err(error) = result
            && this.features.get::<Mic>().request == request
        {
            retire(this, cx);
            toasts::error(error, cx);
        }
    });
}

/// Stops the recording and asks for the polished transcript, then sends it.
fn stop(s: &mut Shell, cx: &mut Context<Shell>) {
    let mic = s.features.get::<Mic>();
    let request = mic.request.clone();
    let body = mic.control(
        json!({"action":"dictation-stop","requestId":format!("m-{}", stamp()),"submit":true}),
    );
    show(s, DictationState::Finishing, cx);
    post(s, body, cx, move |this, result, cx| {
        if let Err(error) = result
            && this.features.get::<Mic>().request == request
        {
            restore(this, cx);
            retire(this, cx);
            toasts::error(format!("Dictation did not finish: {error}"), cx);
        }
    });
}

/// Ends the recording without sending; late text is discarded.
fn cancel(s: &mut Shell, cx: &mut Context<Shell>) {
    let mic = s.features.get::<Mic>();
    if !mic.active() {
        return;
    }
    let body = mic.control(
        json!({"action":"dictation-stop","requestId":format!("m-{}", stamp()),"submit":false}),
    );
    restore(s, cx);
    retire(s, cx);
    post(s, body, cx, |_, _, _| {});
}

/// Puts back the draft the recording started from.
fn restore(s: &mut Shell, cx: &mut Context<Shell>) {
    let (draft, sent) = {
        let mic = s.features.get::<Mic>();
        (mic.draft.clone(), mic.sent)
    };
    if !sent && let Some(view) = pinned(s) {
        view.update(cx, |view, cx| view.dictate(&draft, cx));
    }
}

fn retire(s: &mut Shell, cx: &mut Context<Shell>) {
    show(s, DictationState::Off, cx);
    *s.features.get::<Mic>() = Mic::default();
    cx.notify();
}

/// Another chat in front, or this one closing or changing, cancels.
fn follow(s: &mut Shell, cx: &mut Context<Shell>) {
    let (state, target) = {
        let mic = s.features.get::<Mic>();
        (mic.state, mic.target.clone())
    };
    if state == DictationState::Off || state == DictationState::Finishing {
        return;
    }
    let changed = match (pinned(s), active_view(s)) {
        (None, _) => true,
        (Some(pinned), Some(active)) if active != pinned => true,
        (Some(pinned), _) => {
            pinned
                .read(cx)
                .voice_binding(cx)
                .map(|t| (t.thread, t.repo))
                != target.map(|t| (t.thread, t.repo))
        }
    };
    if changed {
        cancel(s, cx);
    }
}

/// `dictation-text` snapshots and `dictation-state` for this recording.
pub(super) fn frame(s: &mut Shell, kind: &str, payload: &Value, cx: &mut Context<Shell>) {
    if !s.features.get::<Mic>().owns(payload) {
        return;
    }
    let state = s.features.get::<Mic>().state;
    match kind {
        "dictation-text" => {
            let Some(text) = payload["text"].as_str() else {
                return;
            };
            let joined = s.features.get::<Mic>().joined(text);
            let Some(view) = pinned(s) else {
                return;
            };
            if payload["final"] == true {
                if state != DictationState::Finishing || s.features.get::<Mic>().sent {
                    return;
                }
                s.features.get::<Mic>().sent = true;
                let draft = s.features.get::<Mic>().draft.clone();
                view.update(cx, |view, cx| view.send_dictated(&draft, &joined, cx));
            } else {
                view.update(cx, |view, cx| view.dictate(&joined, cx));
            }
        }
        _ => match payload["state"].as_str() {
            Some("listening") => {
                if state == DictationState::Starting {
                    show(s, DictationState::Listening, cx);
                }
                // The host relays the native recorder's level on listening frames.
                if let Some(level) = payload["level"].as_f64()
                    && let Some(view) = pinned(s)
                {
                    view.update(cx, |view, _| view.dictation_level(level as f32));
                }
            }
            Some("idle") => {
                let sent = s.features.get::<Mic>().sent;
                restore(s, cx);
                retire(s, cx);
                if state == DictationState::Finishing && !sent {
                    toasts::info("Dictation heard nothing to send.", cx);
                }
            }
            Some("error") => {
                restore(s, cx);
                retire(s, cx);
                toasts::error(
                    payload["error"]
                        .as_str()
                        .unwrap_or("Dictation stopped.")
                        .to_owned(),
                    cx,
                );
            }
            _ => {}
        },
    }
}

fn post(
    s: &Shell,
    body: Value,
    cx: &mut Context<Shell>,
    done: impl FnOnce(&mut Shell, Result<(), String>, &mut Context<Shell>) + 'static,
) {
    let client = s.client.clone();
    let task = cx.background_executor().spawn(async move {
        let url = client
            .url("/api/next/voice-host")
            .map_err(|_| "Invalid route".to_string())?;
        match client.request("POST", &url).send_json(body) {
            Ok(_) => Ok(()),
            Err(ureq::Error::Status(503, _)) => Err("Dictation needs the o8 app.".into()),
            Err(ureq::Error::Status(404, _)) => Err("Dictation needs a newer o8.".into()),
            // Another recording, or Fn or Live, holds the microphone.
            Err(ureq::Error::Status(409, _)) => Err("Another voice input is active.".into()),
            Err(ureq::Error::Status(code, response)) => Err(response
                .into_json::<Value>()
                .ok()
                .and_then(|body| body["code"].as_str().map(String::from))
                .map_or_else(
                    || format!("The voice host returned HTTP {code}."),
                    |code| format!("The voice host refused dictation ({code})."),
                )),
            Err(error) => Err(error.to_string()),
        }
    });
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |this, cx| done(this, result, cx));
    })
    .detach();
}
