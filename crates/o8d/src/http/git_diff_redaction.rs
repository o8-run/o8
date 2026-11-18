//! Request-local viewer authority. Unsupported grammar defers to the canonical TS implementation.
use super::*;
use sha2::{Digest, Sha256};

pub struct ViewerRedaction {
    normalized: Vec<String>,
    hashes: Vec<String>,
}
impl ViewerRedaction {
    pub fn from_grant(value: &Value) -> Option<Self> {
        let array = |key| {
            value[key]
                .as_array()?
                .iter()
                .map(|v| v.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        };
        let known = array("knownValues")?;
        let normalized = array("normalizedValues")?;
        let hashes = array("activeCredentialHashes")?;
        if known.len() + normalized.len() + hashes.len() > 1024
            || known
                .iter()
                .chain(&normalized)
                .chain(&hashes)
                .any(|s| s.len() > 16 * 1024)
        {
            return None;
        }
        Some(Self { normalized, hashes })
    }
    fn ranges(&self, text: &str) -> Result<Vec<(usize, usize)>, ()> {
        let mut ranges = Vec::new();
        let preserved = normalize(text, true)?;
        let decoded = normalize(text, false)?;
        for (mapped, positions) in [&preserved, &decoded] {
            // Static syntax is outside this first exact port, even if a live literal
            // overlaps its key. Never let masking hide a larger statement range.
            let original = mapped.to_ascii_lowercase();
            let compact: String = original
                .chars()
                .filter(|c| !c.is_ascii_whitespace())
                .collect();
            let keyed = [
                "token",
                "ticket",
                "jwt",
                "session",
                "secret",
                "password",
                "passwd",
                "authorization",
                "cookie",
                "apikey",
                "api_key",
                "api-key",
                "credential",
            ]
            .iter()
            .any(|key| original.contains(key));
            if (keyed && original.contains(['=', ':', '\"', '\'', '`', '[', ']']))
                || compact.contains("data:")
                || [
                    "bearer",
                    "bearer\n",
                    "bearer\t",
                    "basic",
                    "basic\n",
                    "basic\t",
                    "eyj",
                    "o8d_",
                    "o8pw_",
                    "o8sp_",
                    "cwk_",
                    "sk-",
                    "sk_",
                    "rk_",
                    "ghp_",
                    "github_pat_",
                    "xox",
                    "akia",
                    "asia",
                    "aiza",
                    "code=",
                    "://",
                    "--user",
                    "--password",
                    "--token",
                    "--api-key",
                    "process",
                    "-----begin",
                    "<!doctype",
                ]
                .iter()
                .any(|key| original.contains(key))
                || original
                    .split_whitespace()
                    .any(|word| word.starts_with("-u"))
            {
                return Err(());
            }
            let mut masked = mapped.clone();
            for literal in &self.normalized {
                if literal.is_empty() {
                    continue;
                }
                for (start, _) in mapped.match_indices(literal) {
                    let end = start + literal.len();
                    ranges.push((positions[start].0, positions[end - 1].1));
                    masked.replace_range(start..end, &" ".repeat(end - start));
                }
            }
            // Hash candidates have the same ASCII boundary rule as the TS DEVICE matcher.
            let bytes = mapped.as_bytes();
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i].is_ascii_hexdigit() {
                    let start = i;
                    while i < bytes.len() && bytes[i].is_ascii_hexdigit() {
                        i += 1;
                    }
                    if i - start == 64
                        && (start == 0 || !word(bytes[start - 1]))
                        && (i == bytes.len() || !word(bytes[i]))
                    {
                        let candidate = &mapped[start..i];
                        if self
                            .hashes
                            .contains(&format!("{:x}", Sha256::digest(candidate.as_bytes())))
                        {
                            ranges.push((positions[start].0, positions[i - 1].1));
                            masked.replace_range(start..i, &" ".repeat(i - start));
                        }
                    }
                } else {
                    i += 1;
                }
            }
            // The remaining static credential/statement grammar is deliberately unsupported.
            // Returning unavailable retains all canonical TS matching and normalization rules.
            let lower = masked.to_ascii_lowercase();
            if [
                "token",
                "ticket",
                "jwt",
                "session",
                "secret",
                "password",
                "passwd",
                "authorization",
                "cookie",
                "api_key",
                "api-key",
                "apikey",
                "credential",
                "bearer",
                "basic",
                "eyj",
                "o8d_",
                "o8pw_",
                "o8sp_",
                "cwk_",
                "sk-",
                "rk_",
                "sk_",
                "ghp_",
                "github_pat_",
                "xox",
                "akia",
                "asia",
                "aiza",
                "code=",
                "://",
                "--user",
                "?auth=",
                "?key=",
                "&auth=",
                "&key=",
                "process",
                "-----begin",
                "data:",
                "<!doctype",
            ]
            .iter()
            .any(|trigger| lower.contains(trigger))
            {
                return Err(());
            }
        }
        for (start, _) in text.match_indices("[redacted]") {
            ranges.push((start, start + 10));
        }
        ranges.sort_unstable();
        let mut merged: Vec<(usize, usize)> = Vec::new();
        for (start, end) in ranges {
            if let Some(previous) = merged.last_mut() {
                if start < previous.1 {
                    previous.1 = previous.1.max(end);
                    continue;
                }
            }
            merged.push((start, end));
        }
        Ok(merged)
    }
    pub(super) fn json(&self, mut body: Value, verified: &[String]) -> ReadResult {
        fn visit(
            policy: &ViewerRedaction,
            item: &mut Value,
            path: &str,
            verified: &[String],
            spans: &mut Vec<Value>,
        ) -> Result<(), ()> {
            match item {
                Value::String(text) => {
                    // Diff strings must have passed source projection first.
                    if (path.ends_with("/diff") || path.ends_with("/patch"))
                        && !text.is_empty()
                        && !verified.contains(text)
                    {
                        return Err(());
                    }
                    let ranges = policy.ranges(text)?;
                    let mut result = String::new();
                    let mut cursor = 0;
                    for (start, end) in ranges {
                        result.push_str(&text[cursor..start]);
                        spans.push(json!({"start":result.len(),"end":result.len()+10,"kind":"credential","path":path}));
                        result.push_str("[redacted]");
                        cursor = end;
                    }
                    result.push_str(&text[cursor..]);
                    *text = result;
                }
                Value::Array(array) => {
                    for (i, child) in array.iter_mut().enumerate() {
                        visit(policy, child, &format!("{path}/{i}"), verified, spans)?;
                    }
                }
                Value::Object(object) => {
                    // viewerJson emits spans in the TS producer's insertion order.
                    // serde_json's map order must not reorder this observable array.
                    let order: &[&str] = if object.contains_key("sessionKey") {
                        &[
                            "sessionKey",
                            "worktreePath",
                            "baseBranch",
                            "headSha",
                            "revision",
                            "filePath",
                            "files",
                            "diff",
                            "additions",
                            "deletions",
                            "fileCount",
                            "sizeBytes",
                            "sizeBytesExact",
                            "maxBytes",
                            "truncated",
                            "truncationReason",
                            "error",
                        ]
                    } else if object.contains_key("expectedHeadSha") {
                        &["error", "expectedHeadSha", "currentHeadSha"]
                    } else if !path.is_empty() {
                        &["path", "status", "additions", "deletions"]
                    } else if object.contains_key("isUntracked") {
                        &[
                            "path",
                            "isUntracked",
                            "hasDiff",
                            "kind",
                            "size",
                            "diff",
                            "diffStatus",
                        ]
                    } else {
                        &[
                            "path",
                            "diff",
                            "hasDiff",
                            "kind",
                            "size",
                            "diffStatus",
                            "error",
                        ]
                    };
                    let mut keys: Vec<String> = object.keys().cloned().collect();
                    keys.sort_by_key(|key| {
                        order
                            .iter()
                            .position(|candidate| candidate == key)
                            .unwrap_or(order.len())
                    });
                    for key in keys {
                        visit(
                            policy,
                            object.get_mut(&key).ok_or(())?,
                            &format!("{path}/{}", key.replace('~', "~0").replace('/', "~1")),
                            verified,
                            spans,
                        )?;
                    }
                }
                _ => (),
            }
            Ok(())
        }
        let mut spans = Vec::new();
        visit(self, &mut body, "", verified, &mut spans)?;
        body["redaction"] = json!({"version":1,"offsetEncoding":"utf-8","spans":spans});
        Ok(body)
    }
    pub(super) fn source_lines(&self, text: &str) -> Result<Vec<(String, bool)>, ()> {
        let ranges = self.ranges(text)?;
        let mut offset = 0;
        Ok(text
            .split('\n')
            .map(|line| {
                let secret = ranges
                    .iter()
                    .any(|(start, end)| *start < offset + line.len() && *end > offset);
                offset += line.len() + 1;
                (line.to_owned(), secret)
            })
            .collect())
    }
}
fn word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

// Exact source offsets for the supported ASCII escape domain. Unicode and other
// normalization cases defer, rather than substituting a different source map.
fn normalize(text: &str, preserve: bool) -> Result<(String, Vec<(usize, usize)>), ()> {
    if !text.is_ascii() {
        return Err(());
    }
    let mut bytes = text.as_bytes().to_vec();
    let mut map: Vec<_> = (0..bytes.len()).map(|i| (i, i + 1)).collect();
    for _ in 0..3 {
        let mut out = Vec::new();
        let mut positions = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            let mut decoded = None;
            let mut length = 1;
            let tail = &bytes[i..];
            if tail[0] == b'\\' {
                let (prefix, digits) = if tail.starts_with(b"\\u{") {
                    let end = tail.iter().position(|b| *b == b'}').ok_or(())?;
                    if !(4..=9).contains(&end) {
                        return Err(());
                    }
                    length = end + 1;
                    (3, end - 3)
                } else if tail.starts_with(b"\\u") {
                    length = 6;
                    (2, 4)
                } else if tail.starts_with(b"\\x") {
                    length = 4;
                    (2, 2)
                } else {
                    if tail.len() > 1 && b"\\\"'`".contains(&tail[1]) {
                        if !preserve {
                            decoded = Some(tail[1]);
                            length = 2;
                        }
                    }
                    (0, 0)
                };
                if digits > 0 && tail.len() >= length {
                    let raw =
                        std::str::from_utf8(&tail[prefix..prefix + digits]).map_err(|_| ())?;
                    if let Ok(n) = u32::from_str_radix(raw, 16) {
                        if n > 127 {
                            return Err(());
                        }
                        decoded = Some(n as u8);
                    }
                }
            } else if tail[0] == b'%' && tail.len() >= 3 {
                if let Ok(n) =
                    u8::from_str_radix(std::str::from_utf8(&tail[1..3]).map_err(|_| ())?, 16)
                {
                    if n > 127 {
                        return Err(());
                    }
                    decoded = Some(n);
                    length = 3;
                }
            } else if tail[0] == b'&' {
                let raw = std::str::from_utf8(tail).map_err(|_| ())?;
                for (entity, character) in [
                    ("&colon;", b':'),
                    ("&comma;", b','),
                    ("&sol;", b'/'),
                    ("&semi;", b';'),
                    ("&Tab;", b'\t'),
                    ("&NewLine;", b'\n'),
                    ("&quot;", b'"'),
                    ("&apos;", b'\''),
                    ("&amp;", b'&'),
                    ("&lt;", b'<'),
                    ("&gt;", b'>'),
                ] {
                    if raw.starts_with(entity) {
                        decoded = Some(character);
                        length = entity.len();
                        break;
                    }
                }
                if raw.starts_with("&#") {
                    return Err(());
                }
            }
            if let Some(b) = decoded {
                if preserve && b"\"'`\\\r\n".contains(&b) {
                    decoded = None;
                }
            }
            if let Some(b) = decoded {
                out.push(b);
                positions.push((map[i].0, map[i + length - 1].1));
                i += length;
            } else {
                out.push(bytes[i]);
                positions.push(map[i]);
                i += 1;
            }
        }
        if out == bytes {
            break;
        }
        bytes = out;
        map = positions;
    }
    Ok((String::from_utf8(bytes).map_err(|_| ())?, map))
}
