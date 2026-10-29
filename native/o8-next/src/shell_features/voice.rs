use super::*;
use crate::ui::{VoiceState, VoiceTarget};
use serde_json::{Value, json};
use std::collections::HashSet;
// Chat Live voice through the hidden voice host (0.1.815;
// docs/development/native-voice-host.md). The composer's waveform and the
// shell's voice-toggle (Caps Lock) start and stop Live for the selected chat
// over POST /api/next/voice-host. The host relays each delegation as a
// ui-command; it posts through that chat's own queue send, and the broker
// answers the host with the queued turn's terminal. Stop closes voice and
// never cancels submitted work; a spoken cancel uses the chat's stop path.
// Symon's tool confirmations surface here for an explicit decision.
struct Voice;
register_shell_feature!(Voice);
impl ShellFeature for Voice {
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 75,
            run: |s, _, _, cx| follow(s, cx),
        }]
    }
    fn slots(&self) -> &'static [RenderSlot] {
        &[RenderSlot {
            group: RenderGroup::Content,
            order: 950,
            render: |s, _, _, cx| confirmations(s, cx),
        }]
    }
}

/// One Live session, pinned to the chat and binding it started for.
#[derive(Default)]
struct Live {
    on: bool,
    /// Stop was asked; nothing starts until the host reports closure.
    closing: bool,
    target: Option<VoiceTarget>,
    nonce: String,
    view: Option<gpui::WeakEntity<crate::ui::Surface>>,
    /// Delegations already posted, so a replayed frame sends nothing twice.
    posted: HashSet<String>,
}

impl Live {
    /// The broker's sameVoiceBinding: binding, nonce, thread and repository.
    fn owns(&self, payload: &Value) -> bool {
        self.on
            && self.target.as_ref().is_some_and(|target| {
                payload["binding"] == target.binding.as_str()
                    && payload["nonce"] == self.nonce.as_str()
                    && payload["threadId"] == target.thread.as_str()
                    && payload["repoPath"] == target.repo.as_str()
            })
    }
    /// The binding fields every binding-scoped control carries, plus `extra`.
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
}

/// Symon's pending tool confirmations, newest last.
#[derive(Default)]
struct Gates {
    pending: Vec<Value>,
    /// The server connection as the last tick saw it; a reconnect reads the
    /// confirmations the host republished while the window was away.
    connected: bool,
}

fn active_view(s: &Shell) -> Option<Entity<crate::ui::Surface>> {
    s.active()
        .and_then(|tab| match s.content.get(&s.key(&tab)) {
            Some(Content::Session(view)) => Some(view.clone()),
            _ => None,
        })
}

fn stamp() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("{nanos:x}")
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0., |elapsed| elapsed.as_millis() as f64)
}

fn show(s: &mut Shell, voice: VoiceState, cx: &mut Context<Shell>) {
    let view = s.features.get::<Live>().view.clone();
    if let Some(view) = view.and_then(|view| view.upgrade()) {
        view.update(cx, |view, cx| view.set_voice(voice, cx));
    }
}

impl Shell {
    pub(crate) fn toggle_voice(&mut self, cx: &mut Context<Shell>) {
        let live = self.features.get::<Live>();
        if live.closing {
            self.notice = "Voice is still closing.".into();
            cx.notify();
            return;
        }
        if live.on {
            stop(self, cx);
            return;
        }
        let Some(view) = active_view(self) else {
            self.notice = "Open a chat to talk to it.".into();
            cx.notify();
            return;
        };
        let Some(target) = view.read(cx).voice_binding(cx) else {
            self.notice = "This chat is not ready for voice yet.".into();
            cx.notify();
            return;
        };
        let nonce = format!("v-{}", stamp());
        *self.features.get::<Live>() = Live {
            on: true,
            closing: false,
            target: Some(target),
            nonce: nonce.clone(),
            view: Some(view.downgrade()),
            posted: HashSet::new(),
        };
        show(self, VoiceState::Connecting, cx);
        let body = self.features.get::<Live>().control(json!({"action":"start",
            "requestId":format!("r-{}", stamp()),"source":"byok"}));
        post(self, body, cx, move |this, result, cx| {
            if let Err(error) = result
                && this.features.get::<Live>().nonce == nonce
            {
                retire(this, cx);
                this.notice = error;
            }
        });
    }
}

/// Asks the host to close voice for the pinned chat; the mic stays busy until
/// the host reports closure. Submitted work keeps running.
fn stop(s: &mut Shell, cx: &mut Context<Shell>) {
    let live = s.features.get::<Live>();
    if !live.on || live.closing {
        return;
    }
    live.closing = true;
    let nonce = live.nonce.clone();
    let body = live.control(json!({"action":"stop","requestId":format!("r-{}", stamp())}));
    show(s, VoiceState::Closing, cx);
    post(s, body, cx, move |this, result, cx| {
        if let Err(error) = result
            && this.features.get::<Live>().nonce == nonce
        {
            retire(this, cx);
            this.notice = format!("Voice stop was not confirmed: {error}");
        }
    });
}

/// Retires the nonce and turns the pinned chat's mic off.
fn retire(s: &mut Shell, cx: &mut Context<Shell>) {
    show(s, VoiceState::Off, cx);
    *s.features.get::<Live>() = Live::default();
    cx.notify();
}

/// Another chat in front, new routing for this one, or the chat closing
/// retires the session. A reconnect rereads pending confirmations.
fn follow(s: &mut Shell, cx: &mut Context<Shell>) {
    let connected = s.connected;
    let gates = s.features.get::<Gates>();
    let reconnected = connected && !gates.connected;
    gates.connected = connected;
    if reconnected {
        reread_gates(s, cx);
    }
    let live = s.features.get::<Live>();
    if !live.on || live.closing {
        return;
    }
    let (pinned, target) = (
        live.view.as_ref().and_then(|view| view.upgrade()),
        live.target.clone(),
    );
    let changed = match (pinned, active_view(s)) {
        (None, _) => true,
        (Some(pinned), Some(active)) if active != pinned => true,
        // A tab that is not a chat in front keeps the pinned chat's voice.
        (Some(pinned), _) => pinned.read(cx).voice_binding(cx) != target,
    };
    if changed {
        stop(s, cx);
    }
}

/// `voice-host-state`: session state, spoken cancels and Symon's
/// confirmations. Acceptance and terminal frames spread the active binding,
/// state included, so state is read only from `action: "state"`.
pub(super) fn host_state(s: &mut Shell, payload: &Value, cx: &mut Context<Shell>) {
    match payload["action"].as_str() {
        Some("state") => session_state(s, payload, cx),
        Some("interrupt") => interrupt(s, payload, cx),
        Some("confirmation") => add_gate(s, &payload["confirmation"], cx),
        Some("confirmation-dismissed") => {
            if let Some(id) = payload["confirmationId"].as_str() {
                drop_gate(s, id, cx);
            }
        }
        _ => {}
    }
}

fn session_state(s: &mut Shell, payload: &Value, cx: &mut Context<Shell>) {
    let live = s.features.get::<Live>();
    if !live.owns(payload) {
        return;
    }
    let closing = live.closing;
    match payload["state"].as_str() {
        Some("connecting") if !closing => show(s, VoiceState::Connecting, cx),
        Some("live") if !closing => show(s, VoiceState::Live, cx),
        Some("closing") => {
            s.features.get::<Live>().closing = true;
            show(s, VoiceState::Closing, cx);
        }
        Some("closed" | "idle") => retire(s, cx),
        Some("error") => {
            retire(s, cx);
            s.notice = match payload["detail"]
                .as_str()
                .filter(|detail| !detail.is_empty())
            {
                Some(detail) => format!("Voice stopped: {detail}"),
                None => "Voice stopped with an error.".into(),
            };
        }
        Some("unknown") => {
            retire(s, cx);
            s.notice = "Voice stopped, but its closure was not confirmed.".into();
        }
        _ => {}
    }
}

/// A spoken cancel goes to the pinned chat's stop path; voice stays on.
fn interrupt(s: &mut Shell, payload: &Value, cx: &mut Context<Shell>) {
    let live = s.features.get::<Live>();
    if !live.owns(payload) {
        return;
    }
    let (Some(view), Some(target)) = (
        live.view.as_ref().and_then(|view| view.upgrade()),
        live.target.clone(),
    ) else {
        return;
    };
    let task = view.read(cx).interrupt_turn(&target, cx);
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |this, cx| {
            this.notice = match result {
                Ok(()) => {
                    "Voice asked this chat to stop. The chat has not confirmed it yet.".into()
                }
                Err(error) => format!("Voice could not stop this chat: {error}"),
            };
            cx.notify();
        });
    })
    .detach();
}

/// `voice-delegate`: Live handed a request to this chat. It posts through the
/// chat's own send once, then the host hears which queue item carries it.
pub(super) fn delegate(s: &mut Shell, payload: &Value, cx: &mut Context<Shell>) {
    let live = s.features.get::<Live>();
    let delegation = payload["delegationId"].as_str().unwrap_or("").to_string();
    let text = payload["text"].as_str().unwrap_or("").trim().to_string();
    if !live.owns(payload) || live.closing || delegation.is_empty() || text.is_empty() {
        return;
    }
    if !live.posted.insert(delegation.clone()) {
        return;
    }
    let Some(view) = live.view.as_ref().and_then(|view| view.upgrade()) else {
        return;
    };
    let nonce = live.nonce.clone();
    let task = match view.update(cx, |view, cx| view.send_spoken(text, &nonce, cx)) {
        Ok(task) => task,
        Err(error) => {
            s.notice = format!("Voice request not sent: {error}");
            cx.notify();
            return;
        }
    };
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |this, cx| match result {
            Ok(item) if this.features.get::<Live>().nonce == nonce => {
                let body = this
                    .features
                    .get::<Live>()
                    .control(json!({"action":"accepted",
                    "delegationId":delegation,"queueItemId":item}));
                post(this, body, cx, |_, _, _| {});
            }
            Ok(_) => {}
            Err(error) => {
                this.notice = format!("Voice request not confirmed: {error}");
                cx.notify();
            }
        });
    })
    .detach();
}

fn add_gate(s: &mut Shell, gate: &Value, cx: &mut Context<Shell>) {
    let Some(id) = gate["confirmationId"].as_str() else {
        return;
    };
    if !gate["expiresAt"].is_number() {
        return;
    }
    let pending = &mut s.features.get::<Gates>().pending;
    pending.retain(|known| known["confirmationId"] != id);
    pending.push(gate.clone());
    cx.notify();
}

fn drop_gate(s: &mut Shell, id: &str, cx: &mut Context<Shell>) {
    s.features
        .get::<Gates>()
        .pending
        .retain(|gate| gate["confirmationId"] != id);
    cx.notify();
}

fn reread_gates(s: &mut Shell, cx: &mut Context<Shell>) {
    let client = s.client.clone();
    let task = cx
        .background_executor()
        .spawn(async move { client.get::<Value>("/api/next/voice-host", &[]) });
    cx.spawn(async move |this, cx| {
        // No host (503) or an older server (404) has nothing pending.
        let Ok(body) = task.await else { return };
        let _ = this.update(cx, |this, cx| {
            this.features.get::<Gates>().pending.clear();
            for gate in body["confirmations"].as_array().into_iter().flatten() {
                add_gate(this, gate, cx);
            }
        });
    })
    .detach();
}

/// The person's explicit answer to one confirmation. Never sent on its own.
fn decide(s: &mut Shell, id: String, allow: bool, cx: &mut Context<Shell>) {
    let body = json!({"action":"decision","confirmationId":id,"allow":allow});
    post(s, body, cx, move |this, result, cx| {
        match result {
            Ok(()) => drop_gate(this, &id, cx),
            Err(error) if error.contains("409") => {
                drop_gate(this, &id, cx);
                this.notice = "That confirmation expired before your answer.".into();
            }
            Err(error) => this.notice = format!("Your answer was not delivered: {error}"),
        }
        cx.notify();
    });
}

/// Symon's pending confirmations as cards above the composer, newest on top.
fn confirmations(s: &mut Shell, cx: &mut Context<Shell>) -> Option<AnyElement> {
    let now = now_ms();
    let gates = s
        .features
        .get::<Gates>()
        .pending
        .iter()
        .rev()
        .filter(|gate| gate["expiresAt"].as_f64().is_some_and(|at| at > now))
        .take(3)
        .cloned()
        .collect::<Vec<_>>();
    if gates.is_empty() {
        return None;
    }
    Some(
        div()
            .absolute()
            .right(px(24.))
            .bottom(px(132.))
            .w(px(340.))
            .flex()
            .flex_col()
            .gap(px(8.))
            .children(
                gates
                    .into_iter()
                    .map(|gate| gate_card(gate, cx).into_any_element())
                    .collect::<Vec<_>>(),
            )
            .into_any_element(),
    )
}

fn gate_card(gate: Value, cx: &mut Context<Shell>) -> impl IntoElement {
    let id = gate["confirmationId"].as_str().unwrap_or("").to_string();
    let text = |key: &str| gate[key].as_str().filter(|value| !value.is_empty());
    let summary = text("summary")
        .or(text("title"))
        .or(text("message"))
        .unwrap_or("Symon wants to run a tool.")
        .to_string();
    let detail = [text("tool"), text("source")]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" · ");
    let answer = |label: &'static str, allow: bool, cx: &mut Context<Shell>| {
        let selector = format!(
            "voice-confirm-{}-{id}",
            if allow { "allow" } else { "deny" }
        );
        let id = id.clone();
        div()
            .id(gpui::SharedString::from(selector.clone()))
            .debug_selector(move || selector.clone())
            .h(px(28.))
            .px(px(12.))
            .flex()
            .items_center()
            .rounded(px(8.))
            .cursor_pointer()
            .text_size(px(12.5))
            .map(|button| {
                if allow {
                    button
                        .bg(theme().accent)
                        .text_color(gpui::white())
                        .hover(|button| button.opacity(0.9))
                } else {
                    button
                        .text_color(theme().text)
                        .border_1()
                        .border_color(theme().border)
                        .hover(|button| button.bg(theme().hover))
                }
            })
            .child(label)
            .on_click(cx.listener(move |this, _, _, cx| decide(this, id.clone(), allow, cx)))
    };
    div()
        .p(px(14.))
        .flex()
        .flex_col()
        .gap(px(6.))
        .rounded(px(12.))
        .bg(crate::theme::popover_background())
        .border_1()
        .border_color(theme().border)
        .shadow_lg()
        .child(
            div()
                .text_size(px(11.))
                .text_color(theme().text_muted)
                .child("Symon needs your OK"),
        )
        .child(
            div()
                .text_size(px(13.5))
                .text_color(theme().text)
                .child(summary),
        )
        .when(!detail.is_empty(), |card| {
            card.child(
                div()
                    .font_family(theme().font_mono)
                    .text_size(px(10.5))
                    .text_color(theme().text_faint)
                    .child(detail),
            )
        })
        .child(
            div()
                .pt(px(4.))
                .flex()
                .justify_end()
                .gap(px(8.))
                .child(answer("Deny", false, cx))
                .child(answer("Allow", true, cx)),
        )
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
            // A daemon without the o8 app has no voice host.
            Err(ureq::Error::Status(503, _)) => Err("Voice needs the o8 app.".into()),
            // A server from before the voice host has no route for it.
            Err(ureq::Error::Status(404, _)) => Err("Voice needs a newer o8.".into()),
            // The broker holds another session, or this one is still closing.
            Err(ureq::Error::Status(409, _)) => {
                Err("Voice is busy with another session (409).".into())
            }
            Err(ureq::Error::Status(code, response)) => Err(response
                .into_json::<Value>()
                .ok()
                .and_then(|body| body["code"].as_str().map(String::from))
                .map_or_else(
                    || format!("The voice host returned HTTP {code}."),
                    |code| format!("The voice host refused the request ({code})."),
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
