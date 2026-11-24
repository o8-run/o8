//! Text helpers shared by the native session-rule and diff-comment handlers.

/// JavaScript `String.prototype.trim` whitespace.
pub(super) fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
pub(super) fn trim(value: &str) -> &str {
    value.trim_matches(whitespace)
}
/// Schema SQL with whitespace and case removed outside quoted literals, so a
/// stored `sqlite_master` entry compares equal to its source statement.
pub(super) fn normalize_sql(sql: &str) -> String {
    let mut result = String::new();
    let mut quoted = false;
    for c in sql.chars() {
        if c == '\'' {
            quoted = !quoted;
        }
        if quoted || c == '\'' {
            result.push(c);
        } else if !c.is_ascii_whitespace() && c != ';' {
            result.push(c.to_ascii_lowercase());
        }
    }
    // SQLite omits IF NOT EXISTS in sqlite_master. Keep literal strings exact.
    for prefix in ["createtable", "createuniqueindex", "createindex"] {
        if let Some(rest) = result.strip_prefix(&format!("{prefix}ifnotexists")) {
            return format!("{prefix}{rest}");
        }
    }
    result
}
