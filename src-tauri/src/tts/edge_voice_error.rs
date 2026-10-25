/// Retain only known route codes in the error passed to the `say` breadcrumb.
pub(crate) fn response_error(status: &str, code: Option<&str>) -> String {
    match code {
        Some(code @ ("edge_voice_update_required" | "edge_voice_unavailable")) => {
            format!("edge-local {code} (status {status})")
        }
        _ => format!("edge-local status {status}"),
    }
}

/// Carry the route's known error through synthesis retries to the system-voice
/// transition. The message ID lets the webview reject superseded playback.
pub(crate) fn say_fallback_state(
    message_id: Option<&str>,
    error: Option<&str>,
) -> serde_json::Value {
    let voice_error = error.and_then(|error| {
        error.split_whitespace().find(|word| {
            matches!(
                *word,
                "edge_voice_update_required" | "edge_voice_unavailable"
            )
        })
    });
    serde_json::json!({
        "state": "playing",
        "messageId": message_id,
        "usingFallback": true,
        "voiceError": voice_error,
    })
}

#[cfg(test)]
mod tests {
    use super::{response_error, say_fallback_state};

    #[test]
    fn say_fallback_carries_the_typed_error_and_message_to_the_webview() {
        for code in ["edge_voice_update_required", "edge_voice_unavailable"] {
            let error = format!("synth failed: {}", response_error("503", Some(code)));
            assert_eq!(
                say_fallback_state(Some("reply"), Some(&error)),
                serde_json::json!({
                    "state": "playing",
                    "messageId": "reply",
                    "usingFallback": true,
                    "voiceError": code,
                })
            );
        }
    }

    #[test]
    fn say_fallback_does_not_invent_a_voice_error_for_other_failures() {
        for error in [
            None,
            Some("no audio output"),
            Some("edge_voice_unavailable_extra"),
        ] {
            let state = say_fallback_state(None, error);
            assert_eq!(state["voiceError"], serde_json::Value::Null);
            assert_eq!(state["messageId"], serde_json::Value::Null);
            assert_eq!(state["usingFallback"], true);
        }
    }

    #[test]
    fn retains_voice_error_codes_for_the_say_breadcrumb() {
        for code in ["edge_voice_update_required", "edge_voice_unavailable"] {
            let error = response_error("503", Some(code));
            assert!(error.contains(code));
            assert!(error.contains("503"));
        }
    }

    #[test]
    fn does_not_echo_unknown_server_content() {
        assert_eq!(
            response_error("401", Some("private detail")),
            "edge-local status 401"
        );
        assert_eq!(response_error("500", None), "edge-local status 500");
    }
}
