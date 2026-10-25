/// Retain only known route codes in the error passed to the `say` breadcrumb.
pub(crate) fn response_error(status: &str, code: Option<&str>) -> String {
    match code {
        Some(code @ ("edge_voice_update_required" | "edge_voice_unavailable")) => {
            format!("edge-local {code} (status {status})")
        }
        _ => format!("edge-local status {status}"),
    }
}

#[cfg(test)]
mod tests {
    use super::response_error;

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
