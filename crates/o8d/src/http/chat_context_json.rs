//! The window's semantic revisions and legacy ids hash ECMAScript JSON, not
//! serde's float/key ordering. Keep this isolated from the mobile readers.
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(super) fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub(super) fn trim(s: &str) -> &str {
    s.trim_matches(whitespace)
}
fn index(key: &str) -> Option<u32> {
    let n: u32 = key.parse().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}
pub(super) fn canonical(value: &Value) -> Result<String, ()> {
    fn write(value: &Value, out: &mut String) -> Result<(), ()> {
        match value {
            Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::String(s) => out.push_str(&serde_json::to_string(s).map_err(|_| ())?),
            Value::Number(n) => {
                let n = n.as_f64().filter(|n| n.is_finite()).ok_or(())?;
                out.push_str(ryu_js::Buffer::new().format_finite(n));
            }
            Value::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i != 0 {
                        out.push(',');
                    }
                    write(item, out)?;
                }
                out.push(']');
            }
            Value::Object(fields) => {
                // canonicalize() assigns into {}, where __proto__ is a setter.
                // Defer this unsupported prototype-bearing input to TypeScript.
                if fields.contains_key("__proto__") {
                    return Err(());
                }
                let mut keys: Vec<_> = fields.keys().collect();
                keys.sort_by(|a, b| match (index(a), index(b)) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => a.encode_utf16().cmp(b.encode_utf16()),
                });
                out.push('{');
                for (i, key) in keys.into_iter().enumerate() {
                    if i != 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(key).map_err(|_| ())?);
                    out.push(':');
                    write(&fields[key], out)?;
                }
                out.push('}');
            }
        }
        Ok(())
    }
    let mut out = String::new();
    write(value, &mut out)?;
    Ok(out)
}
pub(super) fn hash(value: &Value) -> Result<String, ()> {
    Ok(format!(
        "{:x}",
        Sha256::digest(canonical(value)?.as_bytes())
    ))
}
