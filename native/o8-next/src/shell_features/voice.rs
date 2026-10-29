use super::*;
use crate::ui::VoiceState;
use serde_json::{Value, json};
use std::collections::HashSet;
// Chat Live voice through the hidden voice host (0.1.815). The composer mic
// and the shell's voice-toggle (Caps Lock) start and stop Live for the
// selected chat over POST /api/next/voice-host. The host relays each
// delegation as a ui-command; it posts through that chat's own queue send,
// and the server answers the host with the queued turn's terminal. Stop
// closes voice and never cancels submitted work.
struct Voice;
register_shell_feature!(Voice);
impl ShellFeature for Voice {
    fn ticks(&self) -> &'static [TickHook] {
        &[TickHook {
            order: 75,
            run: |s, _, _, cx| follow(s, cx),
        }]
    }
}

/// One Live session, pinned to the chat and binding it started for.
#[derive(Default)]
struct Live {
    on: bool,
    binding: String,
    nonce: String,
    view: Option<gpui::WeakEntity<crate::ui::Surface>>,
    /// Delegations already posted, so a replayed frame sends nothing twice.
    posted: HashSet<String>,
}

impl Live {
    fn owns(&self, payload: &Value) -> bool {
        self.on
            && payload["binding"] == self.binding.as_str()
            && payload["nonce"] == self.nonce.as_str()
    }
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

impl Shell {
    pub(crate) fn toggle_voice(&mut self, cx: &mut Context<Shell>) {
        if self.features.get::<Live>().on {
            stop(self, cx);
            return;
        }
        let Some(view) = active_view(self) else {
            self.notice = "Open a chat to talk to it.".into();
            cx.notify();
            return;
        };
        let Some(binding) = view.read(cx).voice_binding(cx) else {
            self.notice = "This chat is not ready for voice yet.".into();
            cx.notify();
            return;
        };
        let nonce = format!("v-{}", stamp());
        *self.features.get::<Live>() = Live {
            on: true,
            binding: binding.clone(),
            nonce: nonce.clone(),
            view: Some(view.downgrade()),
            posted: HashSet::new(),
        };
        view.update(cx, |view, cx| view.set_voice(VoiceState::Connecting, cx));
        let body = json!({"action":"start","requestId":format!("r-{}", stamp()),
            "binding":binding,"nonce":nonce,"source":"byok"});
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

/// Closes voice for the pinned chat. Submitted work keeps running.
fn stop(s: &mut Shell, cx: &mut Context<Shell>) {
    let live = s.features.get::<Live>();
    let body = json!({"action":"stop","binding":live.binding,"nonce":live.nonce});
    retire(s, cx);
    post(s, body, cx, |this, result, cx| {
        if let Err(error) = result {
            this.notice = format!("Voice stop was not confirmed: {error}");
            cx.notify();
        }
    });
}

/// Retires the nonce and turns the pinned chat's mic off.
fn retire(s: &mut Shell, cx: &mut Context<Shell>) {
    let live = std::mem::take(s.features.get::<Live>());
    if let Some(view) = live.view.and_then(|view| view.upgrade()) {
        view.update(cx, |view, cx| view.set_voice(VoiceState::Off, cx));
    }
    cx.notify();
}

/// Another chat in front, new routing for this one, or the chat closing
/// retires the session.
fn follow(s: &mut Shell, cx: &mut Context<Shell>) {
    if !s.features.get::<Live>().on {
        return;
    }
    let live = s.features.get::<Live>();
    let (pinned, binding) = (
        live.view.as_ref().and_then(|view| view.upgrade()),
        live.binding.clone(),
    );
    let changed = match (pinned, active_view(s)) {
        (None, _) => true,
        (Some(pinned), Some(active)) if active != pinned => true,
        // A tab that is not a chat in front keeps the pinned chat's voice.
        (Some(pinned), _) => pinned.read(cx).voice_binding(cx) != Some(binding),
    };
    if changed {
        stop(s, cx);
    }
}

/// `voice-host-state`: the host's view of this session.
pub(super) fn host_state(s: &mut Shell, payload: &Value, cx: &mut Context<Shell>) {
    let live = s.features.get::<Live>();
    if !live.owns(payload) {
        return;
    }
    let voice = match payload["state"].as_str() {
        Some("connecting") => VoiceState::Connecting,
        Some("live") => VoiceState::Live,
        Some("error") => {
            retire(s, cx);
            s.notice = "Voice stopped with an error.".into();
            return;
        }
        Some("stopped") => {
            retire(s, cx);
            return;
        }
        _ => return,
    };
    if let Some(view) = live.view.as_ref().and_then(|view| view.upgrade()) {
        view.update(cx, |view, cx| view.set_voice(voice, cx));
    }
}

/// `voice-delegate`: Live handed a request to this chat. It posts through the
/// chat's own send once, then the host hears which queue item carries it.
pub(super) fn delegate(s: &mut Shell, payload: &Value, cx: &mut Context<Shell>) {
    let live = s.features.get::<Live>();
    let delegation = payload["delegationId"].as_str().unwrap_or("").to_string();
    let text = payload["text"].as_str().unwrap_or("").trim().to_string();
    if !live.owns(payload) || delegation.is_empty() || text.is_empty() {
        return;
    }
    if !live.posted.insert(delegation.clone()) {
        return;
    }
    let Some(view) = live.view.as_ref().and_then(|view| view.upgrade()) else {
        return;
    };
    let (binding, nonce) = (live.binding.clone(), live.nonce.clone());
    let task = match view.update(cx, |view, cx| view.send_spoken(text, cx)) {
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
                let body = json!({"action":"accepted","binding":binding,"nonce":nonce,
                    "delegationId":delegation,"queueItemId":item});
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
            Err(ureq::Error::Status(code, response)) => Err(response
                .into_json::<Value>()
                .ok()
                .and_then(|body| body["error"].as_str().map(String::from))
                .unwrap_or_else(|| format!("The voice host returned HTTP {code}."))),
            Err(error) => Err(error.to_string()),
        }
    });
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |this, cx| done(this, result, cx));
    })
    .detach();
}
