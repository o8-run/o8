//! Presentation boundary for credential-bearing source and server diagnostics.
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

pub(crate) fn sensitive(text: &str) -> bool {
    static CREDENTIAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r#"(?im)(?:[a-z0-9_]*(?:token|secret|password|api[_-]?key|access[_-]?key|credential|authorization)[a-z0-9_]*)["']?\s*[:=]\s*(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}')|^[+\-]?[ \t]*(?:export[ \t]+)?(?:[a-z0-9_]*(?:token|secret|password|api[_-]?key|access[_-]?key|credential|authorization)[a-z0-9_]*)["']?[ \t]*[:=][ \t]*[A-Za-z0-9_+/=\-]{8,}[ \t]*(?:#[^\r\n]*)?$|[a-z][a-z0-9+.\-]*://[^/\s@]+@|(?:--password|--token|--api-key|--user|-u)\s+[^\s"']{8,}|bearer\s+[A-Za-z0-9._-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9]{16,})\b|\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b"#
    ).unwrap()
    });
    CREDENTIAL.is_match(text)
}
pub(crate) fn scrub(value: &mut Value) {
    match value {
        Value::String(text) if sensitive(text) || text.contains("Command failed:") => {
            *text = "Sensitive content hidden".into()
        }
        Value::Array(items) => items.iter_mut().for_each(scrub),
        Value::Object(items) => items.values_mut().for_each(scrub),
        _ => {}
    }
}
