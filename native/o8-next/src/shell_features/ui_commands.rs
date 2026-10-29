use super::*;
use serde_json::{Value, json};
// UI commands relayed to the main window (#5076). The Tauri shell's global
// shortcuts, Symon's o8_ui tools and the spatial ink overlay post
// {kind, payload} to /api/next/ui-command; the realtime server broadcasts
// {type: "ui-command", kind, payload}, and the sidebar's global socket hands
// each frame here once. Unknown kinds are ignored.
struct UiCommands;
register_shell_feature!(UiCommands);
impl ShellFeature for UiCommands {}

/// The spatial ink overlay's last relayed step ("first-stroke", "strokes",
/// "clear", "disarm-request"). The Tauri shell captures and composites the
/// marks itself, as it did beside the desktop window; the window keeps only
/// where the overlay is.
#[derive(Default)]
struct Ink {
    event: Option<String>,
}

impl Shell {
    pub(crate) fn ui_command(
        &mut self,
        frame: &Value,
        window: &mut Window,
        cx: &mut Context<Shell>,
    ) {
        // The broadcast nests the payload; accept it spread over the frame too.
        let payload = frame
            .get("payload")
            .filter(|payload| payload.is_object())
            .unwrap_or(frame);
        match frame["kind"].as_str() {
            Some("open-settings") => self.execute(Command::Settings, window, cx),
            Some("voice-toggle") => self.notice = "Voice chat is not in o8 next yet.".into(),
            Some("symon-ui") => symon(self, &payload["data"], window, cx),
            Some("ink-mark") => {
                self.features.get::<Ink>().event = payload["event"].as_str().map(String::from);
            }
            _ => return,
        }
        cx.notify();
    }
}

/// Symon's o8_ui_open and o8_ui_set (the desktop's `o8:ui-command` handler):
/// open a named surface through the same paths its buttons use, draft for the
/// orchestrator, or flip a preference.
fn symon(s: &mut Shell, data: &Value, window: &mut Window, cx: &mut Context<Shell>) {
    let surface = data["surface"].as_str().unwrap_or("");
    match surface {
        "settings" => s.execute(Command::Settings, window, cx),
        "prs" => s.execute(Command::PullRequests, window, cx),
        "orchestrator_draft" => {
            if let Some(text) = data["text"].as_str() {
                draft(s, text, window, cx);
            }
        }
        "set" => set(s, data["key"].as_str(), data["value"].as_str(), cx),
        "mobile_qr" => s.notice = "Mobile pairing is not in o8 next yet.".into(),
        "automations" => s.notice = "Automations are not in o8 next yet.".into(),
        _ => {
            if !super::right_panel::open_surface(s, surface, data["url"].as_str(), window, cx) {
                s.notice = format!("I don't know the o8 surface \"{surface}\".");
            }
        }
    }
}

/// "Tell the orchestrator…": drafts only, ahead of what is already typed; the
/// person sends it.
fn draft(s: &mut Shell, text: &str, window: &mut Window, cx: &mut Context<Shell>) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    let view = s
        .active()
        .and_then(|tab| match s.content.get(&s.key(&tab)) {
            Some(Content::Session(view)) => Some(view.clone()),
            _ => None,
        });
    match view {
        Some(view) => view.update(cx, |surface, cx| surface.prepend_draft(text, window, cx)),
        None => s.notice = "Open a conversation for Symon's draft.".into(),
    }
}

/// o8_ui_set: theme and surface choose the appearance o8 next opens with;
/// canvas_mode is the experimentalCanvas operator default.
fn set(s: &mut Shell, key: Option<&str>, value: Option<&str>, cx: &mut Context<Shell>) {
    let current = crate::theme::appearance_name();
    let mode = match (key, value) {
        (Some("theme"), Some(theme @ ("dark" | "light"))) => theme,
        (Some("surface"), Some("glass")) => "glass",
        (Some("surface"), Some("solid")) if current == "light" => "light",
        (Some("surface"), Some("solid")) => "dark",
        (Some("canvas_mode"), Some(canvas @ ("on" | "off"))) => {
            canvas_mode(s, canvas == "on", cx);
            return;
        }
        _ => {
            s.notice = format!(
                "I can't set {} to {}.",
                key.unwrap_or("?"),
                value.unwrap_or("?")
            );
            return;
        }
    };
    if mode != current {
        crate::theme::save_appearance(mode);
    }
    let label = match mode {
        "glass" => "All Glass",
        "light" => "Light",
        _ => "Dark",
    };
    s.notice = format!("{label} applies the next time o8 opens.");
}

fn canvas_mode(s: &mut Shell, on: bool, cx: &mut Context<Shell>) {
    let client = s.client.clone();
    let task = cx.background_executor().spawn(async move {
        let url = client.url("/api/panel/operator-defaults").map_err(|_| ())?;
        client
            .request("POST", &url)
            .send_json(json!({ "experimentalCanvas": on }))
            .map(|_| ())
            .map_err(|_| ())
    });
    cx.spawn(async move |this, cx| {
        let result = task.await;
        let _ = this.update(cx, |this, cx| {
            this.notice = match result {
                Ok(()) => format!("Canvas mode {}.", if on { "on" } else { "off" }),
                Err(()) => "Could not change Canvas mode.".into(),
            };
            cx.notify();
        });
    })
    .detach();
}
