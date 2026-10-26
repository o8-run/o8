//! Presentation boundary for credential-bearing source and server diagnostics.
use regex::Regex;
use std::sync::LazyLock;

// Scan key/value tokens rather than a language's assignment spelling. Quoted keys,
// indexing, computed properties and wrappers do not change a credential key's meaning.
fn decoded_key(spelling: &str) -> String {
    fn hex(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, count: usize) -> Option<u32> {
        let mut probe = chars.clone();
        let mut value = 0;
        for _ in 0..count {
            value = value * 16 + probe.next()?.to_digit(16)?;
        }
        *chars = probe;
        Some(value)
    }
    let quoted = spelling.starts_with(['\'', '"', '`'])
        && spelling.len() >= 2
        && spelling.chars().next() == spelling.chars().last();
    let raw = if quoted {
        &spelling[1..spelling.len() - 1]
    } else {
        spelling
    };
    let mut chars = raw.chars().peekable();
    let mut decoded = String::with_capacity(raw.len());
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            decoded.push(ch);
            continue;
        }
        let Some(escape) = chars.next() else {
            decoded.push('\\');
            break;
        };
        let value = match escape {
            // JavaScript has identity escapes and line continuations that JSON
            // rejects. Decode source spelling without evaluating source code.
            '\n' | '\u{2028}' | '\u{2029}' => continue,
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                continue;
            }
            'n' => '\n' as u32,
            'r' => '\r' as u32,
            't' => '\t' as u32,
            'b' => 8,
            'f' => 12,
            'v' => 11,
            'x' => hex(&mut chars, 2).unwrap_or(0xfffd),
            'u' if chars.peek() == Some(&'{') => {
                chars.next();
                let mut value = 0_u32;
                let mut count = 0;
                while chars.peek().is_some_and(|ch| ch.is_ascii_hexdigit()) && count < 6 {
                    value = value * 16 + chars.next().unwrap().to_digit(16).unwrap();
                    count += 1;
                }
                if count == 0 || chars.next() != Some('}') {
                    0xfffd
                } else {
                    value
                }
            }
            'u' => hex(&mut chars, 4).unwrap_or(0xfffd),
            '0'..='7' => {
                let mut value = escape.to_digit(8).unwrap();
                for _ in 1..if escape <= '3' { 3 } else { 2 } {
                    let Some(next) = chars.peek().and_then(|ch| ch.to_digit(8)) else {
                        break;
                    };
                    chars.next();
                    value = value * 8 + next;
                }
                value
            }
            other => other as u32,
        };
        decoded.push(char::from_u32(value).unwrap_or('\u{fffd}'));
    }
    decoded
}
fn secret_key(raw: &str) -> bool {
    let decoded = decoded_key(raw);
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
    computed_key(text) || sensitive_literal(text, 0)
}
// Constant expressions can spell a credential key without containing a single
// credential token. Unknown computed environment reads are private as well.
fn computed_key(text: &str) -> bool {
    fn literal(node: tree_sitter::Node<'_>, text: &str, depth: usize) -> Option<String> {
        if depth > 64 {
            return None;
        }
        match node.kind() {
            "string" | "template_string" => {
                let mut cursor = node.walk();
                if node
                    .named_children(&mut cursor)
                    .any(|n| n.kind() == "template_substitution")
                {
                    return None;
                }
                Some(decoded_key(node.utf8_text(text.as_bytes()).ok()?))
            }
            "parenthesized_expression" => {
                let mut cursor = node.walk();
                literal(
                    node.named_children(&mut cursor)
                        .find(|n| n.kind() != "comment")?,
                    text,
                    depth + 1,
                )
            }
            "binary_expression" if node.child_by_field_name("operator")?.kind() == "+" => Some(
                literal(node.child_by_field_name("left")?, text, depth + 1)?
                    + &literal(node.child_by_field_name("right")?, text, depth + 1)?,
            ),
            _ => None,
        }
    }
    fn contains_environment(node: tree_sitter::Node<'_>, text: &str) -> bool {
        // Inspect the receiver subtree instead of reprinting an object path.
        // Type assertions, optional chains, parentheses and wrapper calls must
        // not erase an environment receiver's provenance.
        let mut pending = vec![(node, 0)];
        while let Some((node, depth)) = pending.pop() {
            if depth > 64 {
                return true;
            }
            let key = match node.kind() {
                "identifier" => node.utf8_text(text.as_bytes()).ok().map(decoded_key),
                "member_expression" => node
                    .child_by_field_name("property")
                    .and_then(|n| n.utf8_text(text.as_bytes()).ok())
                    .map(decoded_key),
                "subscript_expression" => node
                    .child_by_field_name("index")
                    .and_then(|n| literal(n, text, 0)),
                _ => None,
            };
            if key.is_some_and(|key| matches!(key.as_str(), "env" | "environ")) {
                return true;
            }
            let mut cursor = node.walk();
            pending.extend(
                node.named_children(&mut cursor)
                    .map(|node| (node, depth + 1)),
            );
        }
        false
    }
    let mut parser = tree_sitter::Parser::new();
    if parser
        .set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())
        .is_err()
    {
        return true;
    }
    let Some(tree) = parser.parse(text, None) else {
        return true;
    };
    let mut pending = vec![(tree.root_node(), 0)];
    while let Some((node, depth)) = pending.pop() {
        // Bound every recursive normalization path; deeply nested input is masked.
        if depth > 64 {
            return true;
        }
        let index = match node.kind() {
            "subscript_expression" => node.child_by_field_name("index"),
            "computed_property_name" => node.named_child(0),
            _ => None,
        };
        if let Some(index) = index
            && index.kind() != "string"
        {
            let environment = node
                .child_by_field_name("object")
                .is_some_and(|node| contains_environment(node, text));
            if environment || literal(index, text, 0).is_some_and(|value| secret_key(&value)) {
                return true;
            }
        }
        let mut cursor = node.walk();
        pending.extend(
            node.named_children(&mut cursor)
                .map(|node| (node, depth + 1)),
        );
    }
    false
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
