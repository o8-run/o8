//! Presentation boundary for credential-bearing source and server diagnostics.
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

// Scan key/value tokens rather than a language's assignment spelling. Quoted keys,
// indexing, computed properties and wrappers do not change a credential key's meaning.
fn secret_key(raw: &str) -> bool {
    let unquoted = raw.trim_matches(['\'', '"', '`']);
    static ESCAPE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4}))").unwrap()
    });
    let unescaped = ESCAPE.replace_all(unquoted, |captures: &regex::Captures<'_>| {
        captures
            .iter()
            .skip(1)
            .flatten()
            .next()
            .and_then(|m| u32::from_str_radix(m.as_str(), 16).ok())
            .and_then(char::from_u32)
            .map_or_else(|| captures[0].to_owned(), |ch| ch.to_string())
    });
    let decoded =
        serde_json::from_str::<String>(&format!("\"{}\"", unescaped.replace('"', "\\\"")))
            .unwrap_or_else(|_| unescaped.into_owned());
    let mut words = String::new();
    let mut previous_lower = false;
    let chars: Vec<_> = decoded.chars().collect();
    for (index, ch) in chars.iter().copied().enumerate() {
        if !ch.is_alphanumeric() {
            words.push(' ');
        } else {
            if ch.is_uppercase()
                && (previous_lower
                    || (index > 0
                        && chars[index - 1].is_uppercase()
                        && chars.get(index + 1).is_some_and(|next| next.is_lowercase())))
            {
                words.push(' ');
            }
            words.extend(ch.to_lowercase());
        }
        previous_lower = ch.is_lowercase() || ch.is_ascii_digit();
    }
    let words: Vec<_> = words.split_whitespace().collect();
    let collapsed = decoded
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .collect::<String>();
    // Case changes inside a credential word must not turn it into a look-alike.
    // Join only whole adjacent components, bounded by the longest keyword.
    for start in 0..words.len() {
        let mut joined = String::new();
        for part in words[start..].iter().take(13) {
            joined.push_str(part);
            if joined.len() > 13 {
                break;
            }
            if matches!(
                joined.as_str(),
                "apikey"
                    | "accesskey"
                    | "privatekey"
                    | "token"
                    | "secret"
                    | "password"
                    | "passwd"
                    | "credential"
                    | "credentials"
                    | "authorization"
            ) {
                return true;
            }
        }
    }
    ["token", "secret", "password", "apikey", "accesskey"]
        .iter()
        .any(|suffix| collapsed.to_lowercase().ends_with(suffix))
}

#[derive(Clone, Copy)]
struct Token<'a> {
    text: &'a str,
    start: usize,
    end: usize,
}
// Comments can separate a key, delimiter and value. They are skipped only while
// looking ahead; their own tokens are still inspected for stored credentials.
fn next_token(tokens: &[Token<'_>], mut index: usize, text: &str) -> usize {
    loop {
        let Some(token) = tokens.get(index) else {
            return index;
        };
        if token.text == "/" && tokens.get(index + 1).is_some_and(|t| t.text == "*") {
            index += 2;
            while index + 1 < tokens.len()
                && !(tokens[index].text == "*" && tokens[index + 1].text == "/")
            {
                index += 1;
            }
            index = (index + 2).min(tokens.len());
        } else if token.text == "#"
            || (token.text == "/" && tokens.get(index + 1).is_some_and(|t| t.text == "/"))
        {
            let end = text[token.end..]
                .find('\n')
                .map_or(text.len(), |n| token.end + n);
            while index < tokens.len() && tokens[index].start < end {
                index += 1;
            }
        } else {
            return index;
        }
    }
}
fn key_values(text: &str) -> bool {
    static TOKENS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r#"(?s)"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\p{L}\p{N}_$\\-]+|[^\s]"#,
        )
        .unwrap()
    });
    let tokens: Vec<_> = TOKENS
        .find_iter(text)
        .map(|m| Token {
            text: m.as_str(),
            start: m.start(),
            end: m.end(),
        })
        .collect();
    let benign = benign_keys(text);
    for (index, key) in tokens.iter().enumerate() {
        if !secret_key(key.text) || benign.iter().any(|range| range.contains(&key.start)) {
            continue;
        }
        let mut next = next_token(&tokens, index + 1, text);
        while tokens
            .get(next)
            .is_some_and(|t| matches!(t.text, "]" | ")" | "!" | "?"))
        {
            next = next_token(&tokens, next + 1, text);
        }
        while tokens
            .get(next)
            .is_some_and(|t| matches!(t.text, "|" | "&" | "+" | "-" | "*" | "/" | "%" | "?"))
        {
            next = next_token(&tokens, next + 1, text);
        }
        // Quoted map/setter keys may be followed by a comma; bare function
        // parameters and destructuring names are not stored key/value pairs.
        let quoted = key.text.starts_with(['\'', '"', '`']);
        if !tokens
            .get(next)
            .is_some_and(|t| matches!(t.text, ":" | "=") || (quoted && t.text == ","))
        {
            continue;
        }
        // A leading #, // or /* is a legal unquoted value in another format.
        // Do not discard value bytes as a language-specific comment.
        next += 1;
        if tokens.get(next).is_none() {
            continue;
        }
        // Every nonempty value is private, including punctuation-only INI or
        // dotenv values. Code-only references were already proven above.
        return true;
    }
    false
}

// Never exempt a whole binding pattern or computed expression: it can itself
// contain a stored credential, independently of the outer reference assignment.
fn leaf_key(node: tree_sitter::Node<'_>) -> Option<tree_sitter::Node<'_>> {
    match node.kind() {
        "identifier" | "property_identifier" | "string" => Some(node),
        "computed_property_name" if node.named_child_count() == 1 => node
            .named_child(0)
            .filter(|child| matches!(child.kind(), "string" | "identifier")),
        _ => None,
    }
}

// Exempt only syntax proven to contain a code reference rather than a stored value.
// Parsing is solely for visibility exemptions: parse errors remain conservative.
fn benign_keys(text: &str) -> Vec<std::ops::Range<usize>> {
    static REFERENCE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r#"^(?:[A-Za-z_$][A-Za-z0-9_$.]*\(\s*(?:[A-Za-z_$][A-Za-z0-9_$.]*(?:\s*,\s*[A-Za-z_$][A-Za-z0-9_$.]*)*)?\s*\)|[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+|(?:process|import\.meta)\.env(?:\.[A-Za-z0-9_]+|\[\s*(?:"[^"\r\n]+"|'[^'\r\n]+')\s*\]))\s*[,;}]*\s*(?://[^\r\n]*)?$"#,
    ).unwrap()
    });

    let mut parser = tree_sitter::Parser::new();
    if parser
        .set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())
        .is_err()
    {
        return Vec::new();
    }
    let Some(tree) = parser.parse(text, None) else {
        return Vec::new();
    };
    if tree.root_node().has_error() {
        return Vec::new();
    }
    let mut pending = vec![tree.root_node()];
    let mut ranges = Vec::new();
    while let Some(node) = pending.pop() {
        let pair = match node.kind() {
            "variable_declarator" => node
                .child_by_field_name("name")
                .zip(node.child_by_field_name("value")),
            "pair" => {
                let mut parent = node.parent();
                while parent.is_some_and(|p| !matches!(p.kind(), "variable_declarator" | "program"))
                {
                    parent = parent.and_then(|p| p.parent());
                }
                if parent.is_some_and(|p| p.kind() == "variable_declarator") {
                    node.child_by_field_name("key")
                        .zip(node.child_by_field_name("value"))
                } else {
                    None
                }
            }
            "assignment_expression" => node
                .child_by_field_name("left")
                .and_then(|left| match left.kind() {
                    "member_expression" => left.child_by_field_name("property"),
                    "subscript_expression" => left.child_by_field_name("index"),
                    _ => None,
                })
                .zip(node.child_by_field_name("right")),
            _ => None,
        };
        if let Some((key, value)) = pair
            && value
                .utf8_text(text.as_bytes())
                .is_ok_and(|value| REFERENCE.is_match(value))
            && let Some(key) = leaf_key(key)
        {
            ranges.push(key.byte_range());
        }
        if node.kind() == "property_signature"
            && node
                .child_by_field_name("type")
                .and_then(|t| t.named_child(0))
                .is_some_and(|t| t.kind() == "predefined_type")
            && let Some(key) = node.child_by_field_name("name").and_then(leaf_key)
        {
            ranges.push(key.byte_range());
        }
        let mut cursor = node.walk();
        pending.extend(node.named_children(&mut cursor));
    }
    ranges
}

pub(crate) fn sensitive(text: &str) -> bool {
    sensitive_literal(text, 0)
}
fn sensitive_literal(text: &str, depth: usize) -> bool {
    // Source can itself contain serialized configuration. Each decoded layer is
    // smaller; unusually deep nesting fails closed rather than exhausting a stack.
    if depth == 16 {
        return true;
    }
    if key_values(text) {
        return true;
    }
    static CREDENTIAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r#"(?im)[a-z][a-z0-9+.\-]*://[^/\s@]+@|(?:--password|--token|--api-key|--user|-u)\s+[^\s"']{8,}|bearer\s+[A-Za-z0-9._-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_\-]{16,}|gh[pousr]_[A-Za-z0-9]{16,})\b|\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b"#,
    ).unwrap()
    });
    if CREDENTIAL.is_match(text) {
        return true;
    }
    static STRINGS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?s)"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`"#).unwrap()
    });
    STRINGS.find_iter(text).any(|literal| {
        let raw = literal.as_str();
        let decoded = serde_json::from_str::<String>(raw)
            .unwrap_or_else(|_| raw[1..raw.len() - 1].to_owned());
        (decoded.contains(':') || decoded.contains('=')) && sensitive_literal(&decoded, depth + 1)
    })
}
pub(crate) fn contains(value: &Value) -> bool {
    match value {
        Value::String(text) => sensitive(text),
        Value::Array(items) => items.iter().any(contains),
        Value::Object(items) => items.values().any(contains),
        _ => false,
    }
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
