//! The speech helper line protocol, shared with the macOS Swift helper.
//!
//! The desktop shell (`src-tauri/src/stt/mod.rs`, `LiveRecognizer`) writes one
//! command per line to the helper's stdin and reads one JSON object per line
//! from its stdout. This module is the Linux side of that contract; it must
//! stay byte-compatible with `src-tauri/helpers/speech_recognizer.swift`.
//!
//! Commands (stdin): `start`, `start:<id>`, `stop`, `stop:<id>`,
//! `locale:<bcp47>`, `on_device:<bool>`, `input_device:<uid|default>`, `quit`.
//!
//! Events (stdout): `{"type":T,"text":S}` or `{"type":T,"text":S,"session_id":N}`
//! where `T` is one of `ready`, `status`, `partial`, `final`, `level`,
//! `audio_file`, `complete`, `error`.

use serde::{Deserialize, Serialize};

/// One parsed stdin command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Begin a session. `0` is the legacy bare `start`.
    Start(u64),
    /// End a session. `None` is the legacy bare `stop` (stops whatever runs).
    Stop(Option<u64>),
    Locale(String),
    OnDevice(bool),
    /// `None` selects the system default input.
    InputDevice(Option<String>),
    Quit,
}

/// Parse one stdin line. Unknown or malformed lines return `None`, which the
/// Swift helper also ignores silently.
pub fn parse_command(line: &str) -> Option<Command> {
    let cmd = line.trim();
    match cmd {
        "quit" => return Some(Command::Quit),
        "start" => return Some(Command::Start(0)),
        "stop" => return Some(Command::Stop(None)),
        _ => {}
    }
    if let Some(id) = cmd.strip_prefix("start:") {
        return id.parse().ok().map(Command::Start);
    }
    if let Some(id) = cmd.strip_prefix("stop:") {
        return id.parse().ok().map(|id| Command::Stop(Some(id)));
    }
    if let Some(locale) = cmd.strip_prefix("locale:") {
        return Some(Command::Locale(locale.trim().to_string()));
    }
    if let Some(raw) = cmd.strip_prefix("on_device:") {
        let raw = raw.trim().to_ascii_lowercase();
        return Some(Command::OnDevice(raw == "true" || raw == "1"));
    }
    if let Some(device) = cmd.strip_prefix("input_device:") {
        let device = device.trim();
        let device = (!device.is_empty() && device != "default").then(|| device.to_string());
        return Some(Command::InputDevice(device));
    }
    None
}

/// One stdout event, in the shape `LiveRecognizer` deserializes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<u64>,
}

impl Event {
    pub fn new(kind: &str, text: impl Into<String>, session_id: Option<u64>) -> Self {
        Self {
            kind: kind.to_string(),
            text: text.into(),
            session_id,
        }
    }

    pub fn ready() -> Self {
        Self::new("ready", "", None)
    }

    pub fn status(text: impl Into<String>, session_id: Option<u64>) -> Self {
        Self::new("status", text, session_id)
    }

    pub fn error(text: impl Into<String>, session_id: Option<u64>) -> Self {
        Self::new("error", text, session_id)
    }

    /// Audio level, clamped to 0..=1 and formatted like the Swift `%.3f`.
    pub fn level(level: f32, session_id: u64) -> Self {
        let clamped = if level.is_finite() {
            level.clamp(0.0, 1.0)
        } else {
            0.0
        };
        Self::new("level", format!("{clamped:.3}"), Some(session_id))
    }

    /// Serialize as one protocol line, without the trailing newline.
    pub fn to_line(&self) -> String {
        // Serializing a struct of strings and integers cannot fail.
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// Parse one stdout line (client side).
pub fn parse_event(line: &str) -> Option<Event> {
    serde_json::from_str(line.trim()).ok()
}

/// Map a BCP-47 locale such as `en-US` or `pt_BR` to a whisper language code
/// (`en`, `pt`). Empty input means auto-detect.
pub fn whisper_language(locale: &str) -> Option<String> {
    let primary = locale
        .trim()
        .split(['-', '_'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    (primary.len() >= 2 && primary.len() <= 3 && primary.chars().all(|c| c.is_ascii_alphabetic()))
        .then_some(primary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_command_the_shell_sends() {
        assert_eq!(parse_command("start:42\n"), Some(Command::Start(42)));
        assert_eq!(parse_command("stop:42"), Some(Command::Stop(Some(42))));
        assert_eq!(parse_command("start"), Some(Command::Start(0)));
        assert_eq!(parse_command("stop"), Some(Command::Stop(None)));
        assert_eq!(parse_command(" quit "), Some(Command::Quit));
        assert_eq!(
            parse_command("locale:en-US"),
            Some(Command::Locale("en-US".into()))
        );
        assert_eq!(
            parse_command("on_device:true"),
            Some(Command::OnDevice(true))
        );
        assert_eq!(parse_command("on_device:0"), Some(Command::OnDevice(false)));
        assert_eq!(
            parse_command("input_device:default"),
            Some(Command::InputDevice(None))
        );
        assert_eq!(
            parse_command("input_device:alsa_input.usb-mic"),
            Some(Command::InputDevice(Some("alsa_input.usb-mic".into())))
        );
    }

    #[test]
    fn ignores_malformed_commands() {
        assert_eq!(parse_command("start:abc"), None);
        assert_eq!(parse_command("stop:-1"), None);
        assert_eq!(parse_command("dance"), None);
        assert_eq!(parse_command(""), None);
    }

    #[test]
    fn events_match_the_swift_wire_shape() {
        assert_eq!(Event::ready().to_line(), r#"{"type":"ready","text":""}"#);
        assert_eq!(
            Event::new("final", "say \"hi\"\nnow", Some(7)).to_line(),
            r#"{"type":"final","text":"say \"hi\"\nnow","session_id":7}"#
        );
        assert_eq!(Event::level(1.7, 3).text, "1.000");
        assert_eq!(Event::level(0.25, 3).text, "0.250");
        assert_eq!(Event::level(f32::NAN, 3).text, "0.000");
    }

    #[test]
    fn swift_lines_round_trip_through_the_client_parser() {
        let swift = r#"{"type":"audio_file","text":"/tmp/o8 rec.wav","session_id":12}"#;
        let event = parse_event(swift).unwrap();
        assert_eq!(event, Event::new("audio_file", "/tmp/o8 rec.wav", Some(12)));
        assert_eq!(parse_event(&event.to_line()), Some(event));
        assert_eq!(parse_event("not json"), None);
    }

    #[test]
    fn maps_locales_to_whisper_languages() {
        assert_eq!(whisper_language("en-US").as_deref(), Some("en"));
        assert_eq!(whisper_language("pt_BR").as_deref(), Some("pt"));
        assert_eq!(whisper_language("yue").as_deref(), Some("yue"));
        assert_eq!(whisper_language(""), None);
        assert_eq!(whisper_language("x"), None);
    }
}
